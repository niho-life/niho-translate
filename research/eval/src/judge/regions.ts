/**
 * output-timeline.wav をエネルギーで有声区間に分ける（ASR に無音を送らないため）。
 * whisper-1 は長い音声を 30 秒窓で前の窓の文に続けて読むため、無音や崩れた窓のあとで
 * 無関係な文を出し続けることがある。区間ごとに 1 窓（25 s 以下）で読ませる。
 */
import type { PcmAudio } from "./wav.ts";

export const REGION_FRAME_MS = 10;

export interface RegionOptions {
  /** これより短い無音は同じ区間にまとめる。 */
  readonly mergeGapMs: number;
  /** これより長い区間は最小エネルギー点で分ける。 */
  readonly maxRegionMs: number;
  /** 分けるときの 1 片の最短長。 */
  readonly minPieceMs: number;
  /** 区間の前後に付ける余白（分割点には付けない）。 */
  readonly padMs: number;
  /** 有声フレームの合計がこれ未満の区間は捨てる（クリック音など）。 */
  readonly minVoicedMs: number;
  /** 分割点を探すときのエネルギーの平滑化幅。 */
  readonly smoothMs: number;
}

export const DEFAULT_REGION_OPTIONS: RegionOptions = {
  mergeGapMs: 1_500,
  maxRegionMs: 25_000,
  minPieceMs: 10_000,
  padMs: 300,
  minVoicedMs: 120,
  smoothMs: 200,
};

export interface VoicedRegion {
  /** 送る範囲（余白込み、timeline の t）。 */
  readonly startMs: number;
  readonly endMs: number;
}

/** frameMs ごとの平均パワー（dBFS）。完全無音は -120。 */
export function frameLevelsDb(audio: PcmAudio, frameMs = REGION_FRAME_MS): Float32Array {
  const per = Math.max(1, Math.round((audio.sampleRate * frameMs) / 1000));
  const frames = Math.ceil(audio.samples.length / per);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    const end = Math.min(audio.samples.length, (f + 1) * per);
    let sum = 0;
    for (let i = f * per; i < end; i += 1) {
      const v = audio.samples[i] ?? 0;
      sum += v * v;
    }
    const n = Math.max(1, end - f * per);
    out[f] = sum === 0 ? -120 : 10 * Math.log10(sum / n / (32768 * 32768));
  }
  return out;
}

/** 有声の閾値: 音のあるフレーム（> -90 dBFS）の 90 パーセンタイルから 25 dB 下、-60〜-45 dBFS に収める。 */
export function voicedThresholdDb(levels: Float32Array): number {
  const audible = Array.from(levels).filter((d) => d > -90).sort((a, b) => a - b);
  if (audible.length === 0) return Number.POSITIVE_INFINITY;
  const p90 = audible[Math.min(audible.length - 1, Math.ceil(0.9 * audible.length) - 1)] ?? -90;
  return Math.min(-45, Math.max(-60, p90 - 25));
}

/**
 * 有声区間: 閾値以上のフレームの連なりを、mergeGapMs 未満の間で結合し、
 * maxRegionMs 超は [minPieceMs, maxRegionMs] の範囲で平滑化エネルギー最小の点で切り、外側の端に padMs を付ける。
 */
export function detectVoicedRegions(
  levels: Float32Array,
  thresholdDb: number,
  totalMs: number,
  options: Partial<RegionOptions> = {},
  frameMs = REGION_FRAME_MS,
): VoicedRegion[] {
  const o = { ...DEFAULT_REGION_OPTIONS, ...options };
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let f = 0; f <= levels.length; f += 1) {
    const voiced = f < levels.length && (levels[f] ?? -120) >= thresholdDb;
    if (voiced && start < 0) start = f;
    if (!voiced && start >= 0) {
      runs.push([start, f]);
      start = -1;
    }
  }
  const merged: Array<{ a: number; b: number; voiced: number }> = [];
  for (const [a, b] of runs) {
    const last = merged.at(-1);
    if (last && (a - last.b) * frameMs < o.mergeGapMs) {
      last.b = b;
      last.voiced += b - a;
    } else {
      merged.push({ a, b, voiced: b - a });
    }
  }
  const power = new Float64Array(levels.length + 1); // prefix sum of linear power
  for (let f = 0; f < levels.length; f += 1) power[f + 1] = (power[f] ?? 0) + 10 ** ((levels[f] ?? -120) / 10);
  const half = Math.max(1, Math.round(o.smoothMs / frameMs / 2));
  const smoothed = (f: number): number => {
    const a = Math.max(0, f - half);
    const b = Math.min(levels.length, f + half);
    return ((power[b] ?? 0) - (power[a] ?? 0)) / Math.max(1, b - a);
  };
  const maxFrames = Math.floor(o.maxRegionMs / frameMs);
  const minFrames = Math.min(maxFrames, Math.ceil(o.minPieceMs / frameMs));
  const pad = (ms: number): number => Math.min(totalMs, Math.max(0, ms));
  const regions: VoicedRegion[] = [];
  for (const m of merged) {
    if (m.voiced * frameMs < o.minVoicedMs) continue;
    let cur = m.a;
    let first = true;
    while (m.b - cur > maxFrames) {
      let best = cur + maxFrames;
      let bestEnergy = Number.POSITIVE_INFINITY;
      for (let f = cur + minFrames; f <= cur + maxFrames; f += 1) {
        const e = smoothed(f);
        if (e < bestEnergy) {
          bestEnergy = e;
          best = f;
        }
      }
      regions.push({ startMs: first ? pad(cur * frameMs - o.padMs) : cur * frameMs, endMs: best * frameMs });
      cur = best;
      first = false;
    }
    regions.push({ startMs: first ? pad(cur * frameMs - o.padMs) : cur * frameMs, endMs: pad(m.b * frameMs + o.padMs) });
  }
  return regions;
}
