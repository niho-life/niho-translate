/**
 * whisper-1 の語時刻は前後の無音を語に含めることがある。区間の先頭/末尾が明らかな無音に
 * かかっているときだけ、音声のエネルギー包絡で内側へ詰める（外側へは動かさない）。
 * 無音 = max(雑音床（全 frame の 10 パーセンタイル）+ 6 dB, 中央値 − 25 dB) 未満。
 * 片側 3 秒を超える無音は詰めずに知らせる。
 */

export interface EnergyEnvelope {
  readonly frameMs: number;
  readonly db: Float64Array;
  readonly silentBelowDb: number;
}

export function energyEnvelope(samples: Int16Array, sampleRate: number, frameMs = 10): EnergyEnvelope {
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames = Math.floor(samples.length / frameLen);
  const db = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frameLen; i < (f + 1) * frameLen; i++) {
      const x = samples[i]! / 32768;
      sum += x * x;
    }
    db[f] = 10 * Math.log10(sum / frameLen + 1e-12);
  }
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floor = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.1)]! : -120;
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)]! : -120;
  // 録音側で無音が 0 に落とされていると雑音床が極端に低くなるので、中央値 −25 dB も無音とみなす。
  return { frameMs, db, silentBelowDb: Math.max(floor + 6, median - 25) };
}

export interface TrimResult {
  readonly startMs: number;
  readonly endMs: number;
  readonly trimmedStartMs: number;
  readonly trimmedEndMs: number;
  /** 端の無音が上限を超えて続いた（語時刻が大きくずれている疑い。詰めない）。 */
  readonly longSilenceAtStart: boolean;
  readonly longSilenceAtEnd: boolean;
  /** 区間全体が無音（時刻が大きくずれている疑い）。 */
  readonly allSilent: boolean;
}

export interface TrimOptions {
  /** 片側で詰めてよい最大 ms。これを超えて無音が続くときは詰めずに知らせる。 */
  readonly maxTrimMs?: number;
  /** 詰めた後に残す最小の長さ ms。 */
  readonly minKeepMs?: number;
  /** 有声の端から残す余白 ms。 */
  readonly guardMs?: number;
}

/** 区間 [startMs, endMs) の両端の無音を詰める。 */
export function trimToVoiced(startMs: number, endMs: number, env: EnergyEnvelope, options: TrimOptions = {}): TrimResult {
  const maxTrim = options.maxTrimMs ?? 3000;
  const minKeep = options.minKeepMs ?? 200;
  const guard = options.guardMs ?? 40;
  const f = env.frameMs;
  const silent = (frame: number): boolean => frame >= 0 && frame < env.db.length && env.db[frame]! < env.silentBelowDb;
  const none: TrimResult = { startMs, endMs, trimmedStartMs: 0, trimmedEndMs: 0, longSilenceAtStart: false, longSilenceAtEnd: false, allSilent: false };
  if (endMs - startMs <= minKeep) return none;
  const lastFrame = Math.ceil(endMs / f) - 1;

  let s = startMs;
  let longSilenceAtStart = false;
  const firstFrame = Math.floor(startMs / f);
  let frame = firstFrame;
  while (frame <= lastFrame && silent(frame)) frame++;
  if (frame > lastFrame) return { ...none, allSilent: true }; // 区間全体が無音: 動かさずに知らせる
  if (frame * f - startMs > maxTrim) longSilenceAtStart = true;
  else if (frame > firstFrame) s = Math.max(startMs, frame * f - guard);

  let e = endMs;
  let longSilenceAtEnd = false;
  frame = lastFrame;
  while (frame >= firstFrame && silent(frame)) frame--;
  if (endMs - (frame + 1) * f > maxTrim) longSilenceAtEnd = true;
  else if (frame < lastFrame) e = Math.min(endMs, (frame + 1) * f + guard);

  if (e - s < minKeep) return { ...none, longSilenceAtStart, longSilenceAtEnd };
  return { startMs: Math.round(s), endMs: Math.round(e), trimmedStartMs: Math.round(s - startMs), trimmedEndMs: Math.round(endMs - e), longSilenceAtStart, longSilenceAtEnd, allSilent: false };
}
