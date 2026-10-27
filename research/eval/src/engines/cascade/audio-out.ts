/**
 * 訳音声の出口。
 * - OrderedAudioOutput: 単位（と単位内の TTS 片）の順序を守る直列キュー。後の片の TTS は先に走ってよいが、
 *   書き出しは open した順。届いた chunk は結合・分割せずそのまま渡す。
 * - AudioPacer: 再生より paceAheadMs 以上先へは出さない（iOS の未再生保持 2 秒を超えないため）。
 * - PcmAligner: HTTP の chunk が奇数 byte で切れても、PCM16 のサンプル境界を保つ。
 */
import { BYTES_PER_MS } from "../../engine.ts";

export class OrderedAudioOutput<K extends string = string> {
  private readonly order: K[] = [];
  private readonly slots = new Map<K, { chunks: Buffer[]; closed: boolean }>();
  private head = 0;

  constructor(private readonly emit: (pcm: Buffer, key: K) => void) {}

  /** 次の出力枠を予約する。予約順が出力順。 */
  open(key: K): void {
    if (this.slots.has(key)) throw new Error(`slot already open: ${key}`);
    this.order.push(key);
    this.slots.set(key, { chunks: [], closed: false });
  }

  push(key: K, pcm: Buffer): void {
    const slot = this.slots.get(key);
    if (!slot || slot.closed || pcm.length === 0) return;
    if (this.order[this.head] === key) {
      this.emit(pcm, key);
    } else {
      slot.chunks.push(pcm);
    }
  }

  close(key: K): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.closed = true;
    this.advance();
  }

  /** 予約済みで、まだ出し終えていない枠の数。 */
  get openSlots(): number {
    return this.order.length - this.head;
  }

  /** 先頭枠より後ろで保留している音声の長さ。 */
  get bufferedMs(): number {
    let bytes = 0;
    for (const slot of this.slots.values()) for (const chunk of slot.chunks) bytes += chunk.length;
    return bytes / BYTES_PER_MS;
  }

  private advance(): void {
    while (this.head < this.order.length) {
      const key = this.order[this.head];
      if (key === undefined) return;
      const slot = this.slots.get(key);
      if (!slot) {
        this.head++;
        continue;
      }
      if (slot.chunks.length > 0) {
        const chunks = slot.chunks;
        slot.chunks = [];
        for (const chunk of chunks) this.emit(chunk, key);
      }
      if (!slot.closed) return;
      this.slots.delete(key);
      this.head++;
    }
  }
}

export interface PacerClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: PacerClock = {
  now: () => performance.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class AudioPacer {
  private readonly queue: Buffer[] = [];
  private playEndMs = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private waiters: Array<() => void> = [];

  /** aheadMs <= 0 なら保留しない（届いたまま出す）。 */
  constructor(
    private readonly aheadMs: number,
    private readonly clock: PacerClock,
    private readonly emit: (pcm: Buffer) => void,
  ) {}

  push(pcm: Buffer): void {
    this.queue.push(pcm);
    this.drain();
  }

  /** 保留中の音声の長さ。 */
  get heldMs(): number {
    let bytes = 0;
    for (const chunk of this.queue) bytes += chunk.length;
    return bytes / BYTES_PER_MS;
  }

  /** 出した音声が実時間で鳴り終わるまでの残り（理想再生モデル）。 */
  get aheadOfPlaybackMs(): number {
    return Math.max(0, this.playEndMs - this.clock.now());
  }

  /** 保留を全部すぐに出す。 */
  flushAll(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.clock.now();
    while (this.queue.length > 0) this.emitOne(now);
    this.resolveWaiters();
  }

  /** 保留が空になったら resolve。 */
  whenDrained(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }

  private drain(): void {
    if (this.aheadMs <= 0) {
      this.flushAll();
      return;
    }
    const now = this.clock.now();
    while (this.queue.length > 0 && this.playEndMs - now <= this.aheadMs) this.emitOne(now);
    if (this.queue.length === 0) {
      this.resolveWaiters();
      return;
    }
    if (this.timer === null) {
      const waitMs = Math.max(1, Math.ceil(this.playEndMs - this.aheadMs - now));
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.drain();
      }, waitMs);
    }
  }

  private emitOne(now: number): void {
    const pcm = this.queue.shift();
    if (!pcm) return;
    this.playEndMs = Math.max(this.playEndMs, now) + pcm.length / BYTES_PER_MS;
    this.emit(pcm);
  }

  private resolveWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** 奇数 byte の chunk を次へ持ち越し、偶数 byte の chunk だけを返す。 */
export class PcmAligner {
  private carry: number | null = null;

  push(chunk: Uint8Array): Buffer | null {
    let data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.carry !== null) {
      data = Buffer.concat([Buffer.from([this.carry]), data]);
      this.carry = null;
    }
    if (data.length % 2 === 1) {
      this.carry = data[data.length - 1] ?? null;
      data = data.subarray(0, data.length - 1);
    }
    return data.length > 0 ? Buffer.from(data) : null;
  }

  /** 終端に残った 1 byte は捨てる（半端なサンプル）。 */
  get dangling(): boolean {
    return this.carry !== null;
  }
}
