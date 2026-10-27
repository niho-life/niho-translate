/**
 * 音声の入出力: ffmpeg による window 変換、WAV 書き出し、stereo 合成。
 * 音声は常に 24 kHz mono PCM16 little-endian（engine.ts と同じ）。
 * エラーの detail に path・鍵・本文を入れない。
 */
import { spawn } from "node:child_process";
import { BYTES_PER_MS, PCM_BYTES_PER_SAMPLE, PCM_SAMPLE_RATE } from "./engine.ts";

/** CLI が英語コードで返すエラー。 */
export class HarnessError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "HarnessError";
    this.code = code;
    this.detail = detail;
  }
}

/** Realtime / Live のセッション上限（60 分）に合わせた window の上限。 */
export const MAX_WINDOW_SEC = 3_600;

export interface AudioWindow {
  readonly startSec: number;
  readonly endSec: number;
}

/** `--window <startSec>:<endSec>`（小数可）。 */
export function parseWindow(value: string): AudioWindow {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u.exec(value.trim());
  if (!match) throw new HarnessError("INVALID_WINDOW");
  const startSec = Number(match[1]);
  const endSec = Number(match[2]);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    throw new HarnessError("INVALID_WINDOW");
  }
  if (endSec - startSec > MAX_WINDOW_SEC) throw new HarnessError("WINDOW_TOO_LONG");
  return { startSec, endSec };
}

export function pcmDurationMs(bytes: number): number {
  return bytes / BYTES_PER_MS;
}

export interface DecodeOptions {
  readonly ffmpeg?: string;
  readonly timeoutMs?: number;
}

/** window を ffmpeg で 24 kHz mono s16le に変換する。window が入力の末尾を越えた分は短くなる。 */
export async function decodeWindowPcm(inputPath: string, window: AudioWindow, options: DecodeOptions = {}): Promise<Buffer> {
  const durationSec = window.endSec - window.startSec;
  const expectedBytes = Math.ceil(durationSec * PCM_SAMPLE_RATE) * PCM_BYTES_PER_SAMPLE;
  const limitBytes = expectedBytes + PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE;
  const args = [
    "-v", "error", "-nostdin", "-hide_banner",
    "-protocol_whitelist", "file,pipe",
    "-ss", formatSeconds(window.startSec), "-t", formatSeconds(durationSec),
    "-i", inputPath,
    "-map", "0:a:0", "-map_metadata", "-1", "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", String(PCM_SAMPLE_RATE), "-acodec", "pcm_s16le",
    "-f", "s16le", "pipe:1",
  ];
  const timeoutMs = options.timeoutMs ?? 60_000 + Math.ceil(durationSec * 200);
  const pcm = await runBounded(options.ffmpeg ?? "ffmpeg", args, limitBytes, timeoutMs);
  const evenBytes = pcm.length - (pcm.length % PCM_BYTES_PER_SAMPLE);
  if (evenBytes === 0) throw new HarnessError("WINDOW_EMPTY");
  return evenBytes === pcm.length ? pcm : pcm.subarray(0, evenBytes);
}

function formatSeconds(value: number): string {
  return String(Number(value.toFixed(3)));
}

function runBounded(command: string, args: readonly string[], stdoutLimit: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let pending: HarnessError | undefined;
    const settle = (error: HarnessError | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, total));
    };
    const abort = (code: string) => {
      if (settled || pending) return;
      pending = new HarnessError(code);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => abort("FFMPEG_TIMEOUT"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > stdoutLimit) {
        abort("FFMPEG_OUTPUT_LIMIT");
        return;
      }
      chunks.push(chunk);
    });
    // stderr は入力 path を含みうるので読み捨てる。
    child.stderr.resume();
    child.on("error", error => {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "FFMPEG_NOT_FOUND" : "FFMPEG_FAILED";
      settle(pending ?? new HarnessError(code));
    });
    child.on("close", (code, signal) => {
      if (pending) settle(pending);
      else if (code !== 0) settle(new HarnessError("FFMPEG_FAILED", signal ? `signal_${signal}` : `exit_${code}`));
      else settle(undefined);
    });
  });
}

/** PCM16 little-endian の WAV（44 byte header）。 */
export function encodeWav(pcm: Buffer, channels: 1 | 2, sampleRate: number = PCM_SAMPLE_RATE): Buffer {
  const blockAlign = channels * PCM_BYTES_PER_SAMPLE;
  if (pcm.length % blockAlign !== 0) throw new HarnessError("WAV_UNALIGNED_PCM");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** mono 2 本を interleave した stereo PCM16。長さは長い方。短い方は無音で埋める。 */
export function mixStereo(left: Buffer, right: Buffer, leftGain = 1, rightGain = 1): Buffer {
  const leftSamples = Math.floor(left.length / PCM_BYTES_PER_SAMPLE);
  const rightSamples = Math.floor(right.length / PCM_BYTES_PER_SAMPLE);
  const frames = Math.max(leftSamples, rightSamples);
  const out = Buffer.alloc(frames * 2 * PCM_BYTES_PER_SAMPLE);
  for (let index = 0; index < frames; index += 1) {
    const l = index < leftSamples ? left.readInt16LE(index * 2) * leftGain : 0;
    const r = index < rightSamples ? right.readInt16LE(index * 2) * rightGain : 0;
    out.writeInt16LE(clampInt16(l), index * 4);
    out.writeInt16LE(clampInt16(r), index * 4 + 2);
  }
  return out;
}

function clampInt16(value: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}
