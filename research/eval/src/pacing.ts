/**
 * 実時間送信（README §2）。frame i を t0 + i*frameMs の絶対時刻へ送り、遅れを次の frame へ持ち越さない。
 * 時計と sleep は差し替え可能（テストでは仮想時計）。
 */
import { setTimeout as delay } from "node:timers/promises";
import { HarnessError } from "./audio.ts";
import { BYTES_PER_MS } from "./engine.ts";

export const FRAME_MS_CHOICES: ReadonlyArray<number> = [100, 200];
/** 製品 protocol の AUDIO_FRAME_BYTES（20 ms）と MAX_AUDIO_BATCH_BYTES（200 ms）。 */
export const INPUT_ALIGNMENT_BYTES = 960;
export const MAX_INPUT_FRAME_BYTES = 9_600;
/** これ以内の早起きは送信してよい（libuv の ms 時計の丸め分）。 */
const EARLY_TOLERANCE_MS = 0.25;

export interface PacingClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: PacingClock = {
  now: () => performance.now(),
  sleep: ms => delay(ms),
};

export function frameBytesFor(frameMs: number): number {
  if (!FRAME_MS_CHOICES.includes(frameMs)) throw new HarnessError("INVALID_FRAME_MS");
  const bytes = frameMs * BYTES_PER_MS;
  if (bytes % INPUT_ALIGNMENT_BYTES !== 0 || bytes > MAX_INPUT_FRAME_BYTES) throw new HarnessError("INVALID_FRAME_MS");
  return bytes;
}

export interface FramePlan {
  /** window（末尾は 0 で埋めた frame）→ tail silence の順。全 frame が frameBytes。 */
  readonly frames: ReadonlyArray<Buffer>;
  readonly frameBytes: number;
  readonly windowFrameCount: number;
  readonly tailFrameCount: number;
}

export function planFrames(windowPcm: Buffer, frameMs: number, tailSilenceMs: number): FramePlan {
  const frameBytes = frameBytesFor(frameMs);
  const frames: Buffer[] = [];
  for (let offset = 0; offset < windowPcm.length; offset += frameBytes) {
    const frame = Buffer.alloc(frameBytes);
    windowPcm.copy(frame, 0, offset, Math.min(windowPcm.length, offset + frameBytes));
    frames.push(frame);
  }
  const windowFrameCount = frames.length;
  const tailFrameCount = Math.ceil(Math.max(0, tailSilenceMs) / frameMs);
  for (let index = 0; index < tailFrameCount; index += 1) frames.push(Buffer.alloc(frameBytes));
  return { frames, frameBytes, windowFrameCount, tailFrameCount };
}

/** frame i の予定時刻（t0 からの ms）。 */
export function scheduledT(index: number, frameMs: number): number {
  return index * frameMs;
}

export interface FrameSendRecord {
  readonly idx: number;
  readonly scheduledT: number;
  /** clock.now() の絶対値（送信直前）。 */
  readonly sentAt: number;
}

export interface PacedSendResult {
  /** 最初の frame を送った瞬間。1 frame も送らなければ undefined。 */
  readonly t0: number | undefined;
  readonly sent: ReadonlyArray<FrameSendRecord>;
}

export interface PacedSendOptions {
  readonly frames: ReadonlyArray<Buffer>;
  readonly frameMs: number;
  readonly clock: PacingClock;
  send(frame: Buffer, index: number): void;
  /** true を返したら次の frame から送らない（fatal・中断）。 */
  shouldStop(): boolean;
  /** send の直前に呼ぶ。 */
  onSent?(record: FrameSendRecord, t0: number): void;
}

export async function sendFramesPaced(options: PacedSendOptions): Promise<PacedSendResult> {
  const { frames, frameMs, clock } = options;
  const sent: FrameSendRecord[] = [];
  let t0: number | undefined;
  for (let index = 0; index < frames.length; index += 1) {
    if (options.shouldStop()) break;
    if (t0 !== undefined) {
      const target = t0 + scheduledT(index, frameMs);
      let wait = target - clock.now();
      while (wait > EARLY_TOLERANCE_MS) {
        await clock.sleep(wait);
        wait = target - clock.now();
      }
      if (options.shouldStop()) break;
    }
    const sentAt = clock.now();
    if (t0 === undefined) t0 = sentAt;
    const record: FrameSendRecord = { idx: index, scheduledT: scheduledT(index, frameMs), sentAt };
    sent.push(record);
    // 記録を先にする（send 中にエンジンが出した event より前に並ぶ）。
    options.onSent?.(record, t0);
    options.send(frames[index]!, index);
  }
  return { t0, sent };
}

export interface LateStats {
  readonly count: number;
  readonly maxLateMs: number;
  readonly meanLateMs: number;
}

/** late = 実送信 − 予定（t0 基準）。frame 0 は定義上 0。 */
export function lateStats(sent: ReadonlyArray<FrameSendRecord>, t0: number | undefined): LateStats {
  if (t0 === undefined || sent.length === 0) return { count: 0, maxLateMs: 0, meanLateMs: 0 };
  let max = 0;
  let sum = 0;
  for (const record of sent) {
    const late = record.sentAt - t0 - record.scheduledT;
    if (late > max) max = late;
    sum += late;
  }
  return { count: sent.length, maxLateMs: max, meanLateMs: sum / sent.length };
}
