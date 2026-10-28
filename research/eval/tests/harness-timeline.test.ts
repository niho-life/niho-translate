import { describe, expect, it } from "vitest";
import { encodeWav, mixStereo } from "../src/audio.ts";
import {
  buildOutputTimeline,
  buildSummary,
  escapeTranscriptText,
  idealPlayback,
  overflowMs,
  perMinuteStats,
  queueSummary,
  transcriptFileContent,
} from "../src/timeline.ts";

const MS = 48; // bytes per ms at 24 kHz mono PCM16

describe("idealPlayback", () => {
  it("plays back-to-back arrivals without queueing", () => {
    const played = idealPlayback([
      { t: 0, bytes: 100 * MS },
      { t: 100, bytes: 100 * MS },
      { t: 200, bytes: 100 * MS },
    ]);
    expect(played.map(chunk => chunk.playStartT)).toEqual([0, 100, 200]);
    expect(played.map(chunk => chunk.playEndT)).toEqual([100, 200, 300]);
    expect(played.map(chunk => chunk.queueMs)).toEqual([0, 0, 0]);
  });

  it("starts at the arrival time after a gap", () => {
    const played = idealPlayback([
      { t: 0, bytes: 100 * MS },
      { t: 500, bytes: 200 * MS },
    ]);
    expect(played[1]).toMatchObject({ playStartT: 500, playEndT: 700, queueMs: 0, durationMs: 200 });
  });

  it("queues chunks that arrive faster than real time", () => {
    const played = idealPlayback([
      { t: 0, bytes: 1_000 * MS },
      { t: 0, bytes: 1_000 * MS },
      { t: 250, bytes: 1_000 * MS },
    ]);
    expect(played.map(chunk => chunk.playStartT)).toEqual([0, 1_000, 2_000]);
    expect(played.map(chunk => chunk.queueMs)).toEqual([0, 1_000, 1_750]);
  });
});

describe("queueSummary", () => {
  it("counts only the part of a chunk beyond the 2,000 ms iOS buffer", () => {
    const played = idealPlayback([
      { t: 0, bytes: 1_000 * MS },
      { t: 0, bytes: 1_000 * MS }, // 1,000 queued + 1,000 = 2,000: still fits
      { t: 0, bytes: 1_000 * MS }, // 2,000 queued + 1,000: 1,000 ms over
    ]);
    expect(overflowMs(played[1]!)).toBe(0);
    expect(overflowMs(played[2]!)).toBe(1_000);
    expect(queueSummary(played)).toEqual({ maxMs: 2_000, p95Ms: 2_000, over2000Count: 1, over2000TotalMs: 1_000 });
  });

  it("treats a queue just above the limit as overflow", () => {
    const played = idealPlayback([
      { t: 0, bytes: 1_900 * MS },
      { t: 0, bytes: 101 * MS },
    ]);
    expect(queueSummary(played)).toMatchObject({ over2000Count: 1, over2000TotalMs: 1 });
  });

  it("weights the p95 by output audio duration", () => {
    // 9.5 s of audio with no queue, then one 0.5 s chunk behind a 1 s queue.
    const chunks = Array.from({ length: 19 }, (_, index) => ({ t: index * 500, bytes: 500 * MS }));
    const played = idealPlayback([...chunks, { t: 9_500, bytes: 1_000 * MS }, { t: 9_500, bytes: 500 * MS }]);
    const summary = queueSummary(played);
    expect(summary.maxMs).toBe(1_000);
    // 10.5 s of audio at queue 0 covers more than 95% of 11 s.
    expect(summary.p95Ms).toBe(0);
  });

  it("is all zero without output", () => {
    expect(queueSummary([])).toEqual({ maxMs: 0, p95Ms: 0, over2000Count: 0, over2000TotalMs: 0 });
  });
});

describe("perMinuteStats", () => {
  it("buckets by arrival minute and keeps empty minutes", () => {
    const played = idealPlayback([
      { t: -5, bytes: 10 * MS },
      { t: 10_000, bytes: 1_000 * MS },
      { t: 10_000, bytes: 500 * MS },
      { t: 70_000, bytes: 500 * MS },
    ]);
    expect(perMinuteStats(played, 130_000)).toEqual([
      { minute: 0, maxQueueMs: 1_000, outputAudioMs: 1_510 },
      { minute: 1, maxQueueMs: 0, outputAudioMs: 500 },
      { minute: 2, maxQueueMs: 0, outputAudioMs: 0 },
    ]);
  });
});

describe("buildOutputTimeline", () => {
  it("places chunks at playStart and fills gaps with silence", () => {
    const first = Buffer.alloc(4);
    first.writeInt16LE(1, 0);
    first.writeInt16LE(2, 2);
    const second = Buffer.alloc(2);
    second.writeInt16LE(3, 0);
    const pcm = buildOutputTimeline([
      { playStartT: 0, pcm: first },
      { playStartT: 1, pcm: second }, // 1 ms = sample 24
    ], 2);
    expect(pcm.length).toBe(48 * 2);
    expect(pcm.readInt16LE(0)).toBe(1);
    expect(pcm.readInt16LE(2)).toBe(2);
    expect(pcm.readInt16LE(4)).toBe(0);
    expect(pcm.readInt16LE(24 * 2)).toBe(3);
  });

  it("never overlaps a previous chunk because of rounding and extends past minDuration", () => {
    const pcm = buildOutputTimeline([
      { playStartT: -3, pcm: Buffer.from([1, 0, 2, 0]) },
      { playStartT: 0.02, pcm: Buffer.from([3, 0]) },
    ], 0);
    expect([...pcm]).toEqual([1, 0, 2, 0, 3, 0]);
  });
});

describe("transcript files", () => {
  it("keeps one delta per line", () => {
    expect(escapeTranscriptText("a\tb\nc\\")).toBe("a\\tb\\nc\\\\");
    expect(transcriptFileContent([{ t: 1_234.56, text: "Hello" }, { t: 2_000, text: " world\n" }]))
      .toBe("1234.6\tHello\n2000\t world\\n\n");
  });
});

describe("WAV helpers", () => {
  it("writes a 44-byte PCM16 header", () => {
    const wav = encodeWav(Buffer.alloc(8), 2);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(44);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(28)).toBe(96_000);
    expect(wav.readUInt16LE(32)).toBe(4);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect(() => encodeWav(Buffer.alloc(6), 2)).toThrow("WAV_UNALIGNED_PCM");
  });

  it("interleaves source (with gain) and output, padding the shorter side", () => {
    const left = Buffer.alloc(4);
    left.writeInt16LE(1_000, 0);
    left.writeInt16LE(-32_768, 2);
    const right = Buffer.alloc(6);
    right.writeInt16LE(5, 0);
    right.writeInt16LE(6, 2);
    right.writeInt16LE(7, 4);
    const stereo = mixStereo(left, right, 0.8, 1);
    expect(stereo.length).toBe(12);
    expect([0, 2, 4, 6, 8, 10].map(offset => stereo.readInt16LE(offset))).toEqual([800, 5, -26_214, 6, 0, 7]);
  });
});

describe("buildSummary", () => {
  it("derives the text-free summary", () => {
    const played = idealPlayback([{ t: 4_321.04, bytes: 2_400 * MS }, { t: 4_400, bytes: 100 * MS }]);
    const summary = buildSummary({
      runId: "run",
      engineId: "openai-translate",
      sourceId: "src",
      config: { engineId: "openai-translate", sourceLanguage: "ja", targetLanguage: "en", frameMs: 200, options: {} },
      windowStartSec: 0,
      windowEndSec: 20,
      durationMs: 20_000,
      tailSilenceMs: 6_000,
      engineReadyMs: 812.34,
      played,
      transcriptOut: [{ t: 5_000, text: "Five" }, { t: 5_100, text: " years" }],
      frames: { count: 130, maxLateMs: 3.21, meanLateMs: 0.44 },
      fatalCode: null,
      drained: true,
      finishWaitMs: 1_234.5,
      costUsd: 0.0147333333,
      wallMs: 33_000,
    });
    expect(summary).toMatchObject({
      firstAudioOutMs: 4_321,
      firstTranscriptOutMs: 5_000,
      outputAudioMs: 2_500,
      outputTranscriptChars: 10,
      fatal: null,
      drained: true,
      costUsdEstimate: 0.014733,
      engineReadyMs: 812.3,
      frames: { count: 130, maxLateMs: 3.2, meanLateMs: 0.4 },
    });
    // 2,400 ms の chunk は空の queue でも 400 ms はみ出し、次の 100 ms は丸ごとはみ出す。
    expect(summary.queue).toMatchObject({ over2000Count: 2, over2000TotalMs: 500 });
    expect(summary.perMinute).toHaveLength(1);
    expect(JSON.stringify(summary)).not.toContain("Five");
  });
});
