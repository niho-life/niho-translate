/**
 * 理想再生モデル（README §2）と run 出力の組み立て。すべて純関数。
 * playStart_k = max(t_k, playEnd_{k-1}), playEnd_k = playStart_k + bytes_k / 48,
 * queueMs_k = max(0, playEnd_{k-1} - t_k)。t は t0 からの ms。
 */
import { BYTES_PER_MS, PCM_BYTES_PER_SAMPLE, PCM_SAMPLE_RATE, type EngineConfig, type RunSummary } from "./engine.ts";

/** iOS PlaybackScheduler の保持上限 96,000 byte。 */
export const IOS_QUEUE_LIMIT_MS = 2_000;
const SAMPLES_PER_MS = PCM_SAMPLE_RATE / 1_000;

export interface ArrivedChunk {
  /** 到着時刻（t0 からの ms）。 */
  readonly t: number;
  readonly bytes: number;
}

export interface PlayedChunk extends ArrivedChunk {
  readonly durationMs: number;
  readonly playStartT: number;
  readonly playEndT: number;
  readonly queueMs: number;
}

/** 到着順の chunk を理想再生モデルへ入れる。 */
export function idealPlayback(chunks: ReadonlyArray<ArrivedChunk>): PlayedChunk[] {
  let previousEnd = Number.NEGATIVE_INFINITY;
  return chunks.map(chunk => {
    const durationMs = chunk.bytes / BYTES_PER_MS;
    const playStartT = Math.max(chunk.t, previousEnd);
    const queueMs = Math.max(0, previousEnd - chunk.t);
    const playEndT = playStartT + durationMs;
    previousEnd = playEndT;
    return { t: chunk.t, bytes: chunk.bytes, durationMs, playStartT, playEndT, queueMs };
  });
}

/** 到着時点で上限を超える音声の長さ。iOS は queued + 新 chunk > 上限 の chunk を overflow として捨てる。 */
export function overflowMs(chunk: PlayedChunk, limitMs: number = IOS_QUEUE_LIMIT_MS): number {
  return Math.min(chunk.durationMs, Math.max(0, chunk.queueMs + chunk.durationMs - limitMs));
}

export interface QueueSummary {
  readonly maxMs: number;
  /** 出力音声の長さで重み付けした queueMs の 95 パーセンタイル（chunk の大きさがエンジンで違うため）。 */
  readonly p95Ms: number;
  /** queue + chunk が上限を超えた chunk の数。 */
  readonly over2000Count: number;
  /** それらの chunk のうち上限を超えた部分の合計 ms。 */
  readonly over2000TotalMs: number;
}

export function queueSummary(played: ReadonlyArray<PlayedChunk>, limitMs: number = IOS_QUEUE_LIMIT_MS): QueueSummary {
  let maxMs = 0;
  let overCount = 0;
  let overTotal = 0;
  for (const chunk of played) {
    if (chunk.queueMs > maxMs) maxMs = chunk.queueMs;
    const over = overflowMs(chunk, limitMs);
    if (over > 0) {
      overCount += 1;
      overTotal += over;
    }
  }
  return { maxMs, p95Ms: weightedPercentile(played, 0.95), over2000Count: overCount, over2000TotalMs: overTotal };
}

function weightedPercentile(played: ReadonlyArray<PlayedChunk>, quantile: number): number {
  const total = played.reduce((sum, chunk) => sum + chunk.durationMs, 0);
  if (total <= 0) return 0;
  const sorted = [...played].sort((a, b) => a.queueMs - b.queueMs);
  const threshold = total * quantile;
  let cumulative = 0;
  for (const chunk of sorted) {
    cumulative += chunk.durationMs;
    if (cumulative >= threshold) return chunk.queueMs;
  }
  return sorted.at(-1)?.queueMs ?? 0;
}

export interface MinuteStats {
  readonly minute: number;
  readonly maxQueueMs: number;
  readonly outputAudioMs: number;
}

/** 到着時刻 t の分ごと。0 分目から spanMs と最後の到着を覆う分まで、出力の無い分も 0 で出す。 */
export function perMinuteStats(played: ReadonlyArray<PlayedChunk>, spanMs: number): MinuteStats[] {
  const minuteOf = (t: number) => Math.floor(Math.max(0, t) / 60_000);
  let lastMinute = spanMs > 0 ? minuteOf(spanMs - 1) : 0;
  for (const chunk of played) lastMinute = Math.max(lastMinute, minuteOf(chunk.t));
  const rows = Array.from({ length: lastMinute + 1 }, (_, minute) => ({ minute, maxQueueMs: 0, outputAudioMs: 0 }));
  for (const chunk of played) {
    const row = rows[minuteOf(chunk.t)]!;
    row.maxQueueMs = Math.max(row.maxQueueMs, chunk.queueMs);
    row.outputAudioMs += chunk.durationMs;
  }
  return rows;
}

export interface TimelineChunk {
  readonly playStartT: number;
  readonly pcm: Buffer;
}

/**
 * 訳音声を playStart の位置へ置き、隙間を無音で埋めた mono PCM16（ファイル内時刻 = t）。
 * 長さは max(最後の playEnd, minDurationMs)。t < 0 の分は先頭へ寄せる。
 */
export function buildOutputTimeline(chunks: ReadonlyArray<TimelineChunk>, minDurationMs: number): Buffer {
  const placements: Array<{ offset: number; pcm: Buffer }> = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const samples = Math.floor(chunk.pcm.length / PCM_BYTES_PER_SAMPLE);
    if (samples === 0) continue;
    const offset = Math.max(cursor, Math.round(Math.max(0, chunk.playStartT) * SAMPLES_PER_MS));
    placements.push({ offset, pcm: chunk.pcm.subarray(0, samples * PCM_BYTES_PER_SAMPLE) });
    cursor = offset + samples;
  }
  const totalSamples = Math.max(cursor, Math.ceil(Math.max(0, minDurationMs) * SAMPLES_PER_MS));
  const out = Buffer.alloc(totalSamples * PCM_BYTES_PER_SAMPLE);
  for (const placement of placements) placement.pcm.copy(out, placement.offset * PCM_BYTES_PER_SAMPLE);
  return out;
}

export interface TimedText {
  readonly t: number;
  readonly text: string;
}

/** `t<TAB>text` の行。改行・タブ・バックスラッシュは \n \t \\ に置き換えて 1 delta = 1 行に保つ。 */
export function transcriptFileContent(entries: ReadonlyArray<TimedText>): string {
  return entries.map(entry => `${roundMs(entry.t)}\t${escapeTranscriptText(entry.text)}\n`).join("");
}

export function escapeTranscriptText(text: string): string {
  return text.replace(/\\/gu, "\\\\").replace(/\r/gu, "\\r").replace(/\n/gu, "\\n").replace(/\t/gu, "\\t");
}

/** 0.1 ms 単位。 */
export function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface SummaryInput {
  readonly runId: string;
  readonly engineId: string;
  readonly sourceId: string;
  readonly config: EngineConfig;
  readonly windowStartSec: number;
  readonly windowEndSec: number;
  readonly durationMs: number;
  readonly tailSilenceMs: number;
  readonly engineReadyMs: number;
  readonly played: ReadonlyArray<PlayedChunk>;
  readonly transcriptOut: ReadonlyArray<TimedText>;
  readonly frames: { readonly count: number; readonly maxLateMs: number; readonly meanLateMs: number };
  readonly fatalCode: string | null;
  readonly drained: boolean;
  readonly finishEndT: number;
  readonly lastVoicedAudioT: number | null;
  readonly finishWaitMs: number;
  readonly costUsd: number | null;
  readonly wallMs: number;
}

export function buildSummary(input: SummaryInput): RunSummary {
  const queue = queueSummary(input.played);
  const tailVoicedGapMs = input.lastVoicedAudioT === null ? null : roundMs(input.finishEndT - input.lastVoicedAudioT);
  const outputAudioMs = input.played.reduce((sum, chunk) => sum + chunk.durationMs, 0);
  const outputTranscriptChars = input.transcriptOut.reduce((sum, entry) => sum + Array.from(entry.text).length, 0);
  return {
    runId: input.runId,
    engineId: input.engineId,
    sourceId: input.sourceId,
    config: input.config,
    windowStartSec: input.windowStartSec,
    windowEndSec: input.windowEndSec,
    durationMs: roundMs(input.durationMs),
    tailSilenceMs: roundMs(input.tailSilenceMs),
    engineReadyMs: roundMs(input.engineReadyMs),
    firstAudioOutMs: input.played.length > 0 ? roundMs(input.played[0]!.t) : null,
    firstTranscriptOutMs: input.transcriptOut.length > 0 ? roundMs(input.transcriptOut[0]!.t) : null,
    outputAudioMs: roundMs(outputAudioMs),
    outputTranscriptChars,
    queue: {
      maxMs: roundMs(queue.maxMs),
      p95Ms: roundMs(queue.p95Ms),
      over2000Count: queue.over2000Count,
      over2000TotalMs: roundMs(queue.over2000TotalMs),
    },
    perMinute: perMinuteStats(input.played, input.durationMs + input.tailSilenceMs).map(row => ({
      minute: row.minute,
      maxQueueMs: roundMs(row.maxQueueMs),
      outputAudioMs: roundMs(row.outputAudioMs),
    })),
    frames: {
      count: input.frames.count,
      maxLateMs: roundMs(input.frames.maxLateMs),
      meanLateMs: roundMs(input.frames.meanLateMs),
    },
    fatal: input.fatalCode === null ? null : { code: input.fatalCode },
    drained: input.drained,
    tailVoicedGapMs,
    tailTruncationRisk: tailVoicedGapMs !== null && tailVoicedGapMs < 2_000,
    finishWaitMs: roundMs(input.finishWaitMs),
    costUsdEstimate: input.costUsd === null ? null : Math.round(input.costUsd * 1_000_000) / 1_000_000,
    wallMs: roundMs(input.wallMs),
  };
}
