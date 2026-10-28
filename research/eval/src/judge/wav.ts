/**
 * 判定器用の WAV 入出力と無音検出（mono PCM16 のみ）。
 * output-timeline.wav は「訳音声の隙間を完全無音で埋めた」ファイルなので、
 * 無音の上に置かれた ASR の語は幻聴として捨て、語頭が無音にかかる場合は音の出る位置へ寄せる
 * （whisper は休止の後の最初の語を早めに置く傾向がある）。
 */

export interface PcmAudio {
  readonly sampleRate: number;
  readonly samples: Int16Array;
}

/** 10 ms 窓の最大振幅がこれ以下なら無音（約 -60 dBFS）。 */
export const SILENCE_THRESHOLD = 32;
export const SILENCE_FRAME_MS = 10;

export function parseWav(buf: Buffer): PcmAudio {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("output-timeline.wav is not a RIFF/WAVE file");
  }
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: { start: number; length: number } | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === "fmt ") {
      if (bodyStart + 16 > buf.length) throw new Error("truncated fmt chunk");
      fmt = {
        format: buf.readUInt16LE(bodyStart),
        channels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        bits: buf.readUInt16LE(bodyStart + 14),
      };
    } else if (id === "data") {
      const remaining = buf.length - bodyStart;
      // ストリーム書き出しで size が 0 / 0xFFFFFFFF / 実長超えのことがある。残り全部を data とみなす。
      const length = size === 0 || size === 0xffffffff || size > remaining ? remaining : size;
      data = { start: bodyStart, length };
      break;
    }
    offset = bodyStart + size + (size % 2);
  }
  if (!fmt) throw new Error("WAV has no fmt chunk");
  if (!data) throw new Error("WAV has no data chunk");
  if (fmt.format !== 1 && fmt.format !== 0xfffe) throw new Error(`WAV format ${fmt.format} is not PCM`);
  if (fmt.channels !== 1 || fmt.bits !== 16) throw new Error("WAV must be mono PCM16");
  const count = Math.floor(data.length / 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = buf.readInt16LE(data.start + i * 2);
  return { sampleRate: fmt.sampleRate, samples };
}

export function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(samples[i] ?? 0, 44 + i * 2);
  return out;
}

export function durationMs(audio: PcmAudio): number {
  return Math.round((audio.samples.length * 1000) / audio.sampleRate);
}

/** frameMs ごとの無音判定（1 = 無音）。 */
export function silentFrames(audio: PcmAudio, frameMs = SILENCE_FRAME_MS, threshold = SILENCE_THRESHOLD): Uint8Array {
  const perFrame = Math.max(1, Math.round((audio.sampleRate * frameMs) / 1000));
  const frames = Math.ceil(audio.samples.length / perFrame);
  const out = new Uint8Array(frames);
  for (let f = 0; f < frames; f += 1) {
    const end = Math.min(audio.samples.length, (f + 1) * perFrame);
    let silent = 1;
    for (let i = f * perFrame; i < end; i += 1) {
      const v = audio.samples[i] ?? 0;
      if (v > threshold || v < -threshold) {
        silent = 0;
        break;
      }
    }
    out[f] = silent;
  }
  return out;
}

export function isAllSilent(frames: Uint8Array, from = 0, to = frames.length): boolean {
  for (let f = Math.max(0, from); f < Math.min(frames.length, to); f += 1) if (frames[f] === 0) return false;
  return true;
}

export interface TimedText {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * 無音の上の語を捨て、語頭・語尾が無音にかかる分だけ音の出る位置へ寄せる。
 * 範囲外のフレームは無音として扱う。
 */
export function refineWordsWithSilence<T extends TimedText>(
  words: ReadonlyArray<T>,
  frames: Uint8Array,
  frameMs = SILENCE_FRAME_MS,
): { words: T[]; dropped: number } {
  const voiced = (f: number): boolean => f >= 0 && f < frames.length && frames[f] === 0;
  const out: T[] = [];
  let dropped = 0;
  for (const word of words) {
    const first = Math.floor(word.startMs / frameMs);
    const last = Math.max(first, Math.floor((Math.max(word.endMs, word.startMs + 1) - 1) / frameMs));
    let a = first;
    while (a <= last && !voiced(a)) a += 1;
    if (a > last) {
      dropped += 1;
      continue;
    }
    let b = last;
    while (b > a && !voiced(b)) b -= 1;
    const startMs = Math.max(word.startMs, a * frameMs);
    const endMs = Math.max(startMs, Math.min(word.endMs, (b + 1) * frameMs));
    out.push({ ...word, startMs, endMs });
  }
  return { words: out, dropped };
}

export interface ChunkRange {
  readonly startMs: number;
  readonly endMs: number;
}

export function sliceAudio(audio: PcmAudio, range: ChunkRange): Int16Array {
  const a = Math.round((range.startMs * audio.sampleRate) / 1000);
  const b = Math.min(audio.samples.length, Math.round((range.endMs * audio.sampleRate) / 1000));
  return audio.samples.slice(a, b);
}
