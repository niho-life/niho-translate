import { describe, expect, it } from "vitest";
import { AudioPacer, OrderedAudioOutput, PcmAligner, type PacerClock } from "../src/engines/cascade/audio-out.ts";
import { hedgedSpeech, type SpeechSource } from "../src/engines/cascade/tts.ts";

const pcm = (ms: number, fill = 1): Buffer => Buffer.alloc(ms * 48, fill);

describe("cascade ordered audio output", () => {
  it("後の単位の音声が先に届いても、open した順に書き出す", () => {
    const out: string[] = [];
    const ordered = new OrderedAudioOutput<string>((chunk, key) => out.push(`${key}:${chunk.length}`));
    ordered.open("u1#0");
    ordered.open("u2#0");
    ordered.open("u3#0");
    ordered.push("u2#0", Buffer.alloc(2));
    ordered.push("u3#0", Buffer.alloc(6));
    ordered.close("u3#0");
    expect(out).toEqual([]);
    ordered.push("u1#0", Buffer.alloc(4));
    expect(out).toEqual(["u1#0:4"]);
    ordered.push("u2#0", Buffer.alloc(8));
    expect(out).toEqual(["u1#0:4"]);
    ordered.close("u1#0");
    // u2 の保留分が順に出て、u2 はまだ開いているので u3 は待つ
    expect(out).toEqual(["u1#0:4", "u2#0:2", "u2#0:8"]);
    ordered.push("u2#0", Buffer.alloc(10));
    expect(out.at(-1)).toBe("u2#0:10");
    ordered.close("u2#0");
    expect(out).toEqual(["u1#0:4", "u2#0:2", "u2#0:8", "u2#0:10", "u3#0:6"]);
    expect(ordered.openSlots).toBe(0);
  });

  it("chunk を結合・分割しない", () => {
    const sizes: number[] = [];
    const ordered = new OrderedAudioOutput<string>(chunk => sizes.push(chunk.length));
    ordered.open("a");
    ordered.open("b");
    ordered.push("b", Buffer.alloc(3_000));
    ordered.push("b", Buffer.alloc(1_000));
    ordered.close("a");
    ordered.close("b");
    expect(sizes).toEqual([3_000, 1_000]);
  });

  it("失敗した枠（音声なしで close）は飛ばす", () => {
    const out: string[] = [];
    const ordered = new OrderedAudioOutput<string>((chunk, key) => out.push(key));
    ordered.open("a");
    ordered.open("b");
    ordered.push("b", Buffer.alloc(2));
    ordered.close("a");
    expect(out).toEqual(["b"]);
  });
});

class FakeClock implements PacerClock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter(timer => timer.id !== handle);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

describe("cascade audio pacer", () => {
  it("再生より aheadMs 以上先へは出さず、実時間で残りを出す", () => {
    const clock = new FakeClock();
    const emitted: Array<{ t: number; ms: number }> = [];
    const pacer = new AudioPacer(1_500, clock, chunk => emitted.push({ t: clock.now(), ms: chunk.length / 48 }));
    for (let i = 0; i < 10; i++) pacer.push(pcm(300)); // 3 秒ぶんが一度に届く
    // 0, 300, ..., 1500 ms ぶんまで（6 chunk = 1.8 秒）を出したところで止まる
    expect(emitted.length).toBe(6);
    expect(pacer.heldMs).toBe(1_200);
    clock.advance(3_000);
    expect(emitted.length).toBe(10);
    expect(pacer.heldMs).toBe(0);
    // 出した時点の「先行」は常に aheadMs + 1 chunk 以下
    let playEnd = 0;
    for (const entry of emitted) {
      expect(Math.max(0, playEnd - entry.t)).toBeLessThanOrEqual(1_500);
      playEnd = Math.max(playEnd, entry.t) + entry.ms;
    }
  });

  it("aheadMs=0 なら届いたまま出す", () => {
    const clock = new FakeClock();
    let count = 0;
    const pacer = new AudioPacer(0, clock, () => count++);
    for (let i = 0; i < 5; i++) pacer.push(pcm(500));
    expect(count).toBe(5);
  });

  it("flushAll と whenDrained", async () => {
    const clock = new FakeClock();
    let count = 0;
    const pacer = new AudioPacer(500, clock, () => count++);
    for (let i = 0; i < 4; i++) pacer.push(pcm(400));
    expect(count).toBe(2);
    const drained = pacer.whenDrained();
    pacer.flushAll();
    await drained;
    expect(count).toBe(4);
  });
});

describe("cascade pcm aligner", () => {
  it("奇数 byte の chunk を次へ持ち越してサンプル境界を保つ", () => {
    const aligner = new PcmAligner();
    const a = aligner.push(Uint8Array.from([1, 2, 3]));
    const b = aligner.push(Uint8Array.from([4, 5, 6]));
    const c = aligner.push(Uint8Array.from([7]));
    expect([...(a ?? [])]).toEqual([1, 2]);
    expect([...(b ?? [])]).toEqual([3, 4, 5, 6]);
    expect(c).toBeNull();
    expect(aligner.dangling).toBe(true);
  });
});

describe("cascade hedged TTS", () => {
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  /** delayMs 後に chunks を返す擬似 TTS。中断されたら reject。 */
  const fakeTts = (delayMs: number, chunks: number[], fail = false): SpeechSource => async (onAudio, signal) => {
    await sleep(delayMs);
    if (signal.aborted) throw new Error("aborted");
    if (fail) throw new Error("tts failed");
    let bytes = 0;
    for (const size of chunks) {
      if (signal.aborted) throw new Error("aborted");
      onAudio(Buffer.alloc(size));
      bytes += size;
      await sleep(1);
    }
    return { firstAudioMs: delayMs, totalMs: delayMs + chunks.length, bytes, attempts: 1 };
  };

  it("主の TTS が速ければ予備を使わない", async () => {
    const got: number[] = [];
    const hedges: string[] = [];
    const result = await hedgedSpeech(fakeTts(5, [2, 4]), fakeTts(5, [6]), 100, pcm => got.push(pcm.length), { onHedge: reason => hedges.push(reason) });
    expect(result.source).toBe("primary");
    expect(got).toEqual([2, 4]);
    expect(hedges).toEqual([]);
  });

  it("主の最初の音声が遅ければ予備を重ね、先に鳴った方だけを使う", async () => {
    const got: number[] = [];
    const hedges: string[] = [];
    const result = await hedgedSpeech(fakeTts(300, [2, 2]), fakeTts(10, [8, 8]), 30, pcm => got.push(pcm.length), { onHedge: reason => hedges.push(reason) });
    expect(result.source).toBe("fallback");
    expect(got).toEqual([8, 8]);
    expect(hedges).toEqual(["timeout"]);
  });

  it("主が音声の前に失敗したらすぐ予備へ、両方失敗なら例外", async () => {
    const hedges: string[] = [];
    const result = await hedgedSpeech(fakeTts(5, [], true), fakeTts(5, [4]), 1_000, () => undefined, { onHedge: reason => hedges.push(reason) });
    expect(result.source).toBe("fallback");
    expect(hedges).toEqual(["error"]);
    await expect(hedgedSpeech(fakeTts(5, [], true), fakeTts(5, [], true), 1_000, () => undefined)).rejects.toThrow("tts failed");
  });

  it("予備が無ければ遅くても主を待つ", async () => {
    const result = await hedgedSpeech(fakeTts(60, [2]), null, 10, () => undefined);
    expect(result.source).toBe("primary");
  });
});
