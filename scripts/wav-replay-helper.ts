import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { MAX_OUTPUT_SILENCE_BYTES } from "../packages/provider-openai/src/index.ts";

export const WAV_REPLAY_DEFAULT_SECONDS = 10;
export const WAV_REPLAY_MAX_SECONDS = 60;
export const PCM_SAMPLE_RATE = 24_000;
export const PCM_BYTES_PER_SAMPLE = 2;

// Independent sample-level oracle: padding timing may change; voice samples may not.
export function normalizePcmSilence(pcm: Buffer): Buffer {
  if (pcm.length % 2 !== 0) throw new WavReplayError("WAV_INVALID_PCM");
  const result = Buffer.alloc(pcm.length);
  let written = 0;
  let seenContent = false;
  let silenceBytes = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    if (pcm.readInt16LE(offset) === 0) {
      if (!seenContent || silenceBytes >= MAX_OUTPUT_SILENCE_BYTES) continue;
      silenceBytes += 2;
    } else {
      seenContent = true;
      silenceBytes = 0;
    }
    pcm.copy(result, written, offset, offset + 2);
    written += 2;
  }
  return result.subarray(0, written);
}

export class WavReplayError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WavReplayError";
  }
}

export interface WavReplayOptions {
  readonly wavPath?: string;
  readonly seconds: number;
}

export interface LoadedPcm {
  readonly pcm: Buffer;
  readonly sourceSampleCount: number;
  readonly convertedSampleCount: number;
  readonly sourceKind: "generated" | "wav";
}

export function parseWavReplayArgs(args: readonly string[]): WavReplayOptions {
  let wavPath: string | undefined;
  let seconds = WAV_REPLAY_DEFAULT_SECONDS;
  let secondsSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--wav") {
      if (!value || value.startsWith("--") || wavPath !== undefined || !isAbsolute(value)) {
        throw new WavReplayError("INVALID_WAV_ARGUMENT");
      }
      wavPath = value;
      index += 1;
    } else if (argument === "--seconds") {
      if (!value || value.startsWith("--") || secondsSeen) throw new WavReplayError("INVALID_SECONDS");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > WAV_REPLAY_MAX_SECONDS) {
        throw new WavReplayError("INVALID_SECONDS");
      }
      seconds = parsed;
      secondsSeen = true;
      index += 1;
    } else {
      throw new WavReplayError("INVALID_ARGUMENT");
    }
  }
  return wavPath === undefined ? { seconds } : { wavPath, seconds };
}

export function generatedPcm(seconds: number): Buffer {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > WAV_REPLAY_MAX_SECONDS) {
    throw new WavReplayError("INVALID_SECONDS");
  }
  return Buffer.alloc(seconds * PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE);
}

export async function loadPcm(options: WavReplayOptions): Promise<LoadedPcm> {
  if (
    !Number.isInteger(options.seconds)
    || options.seconds < 1
    || options.seconds > WAV_REPLAY_MAX_SECONDS
  ) {
    throw new WavReplayError("INVALID_SECONDS");
  }
  if (options.wavPath !== undefined && !isAbsolute(options.wavPath)) {
    throw new WavReplayError("INVALID_WAV_ARGUMENT");
  }
  if (!options.wavPath) {
    const pcm = generatedPcm(options.seconds);
    return {
      pcm,
      sourceSampleCount: pcm.length / PCM_BYTES_PER_SAMPLE,
      convertedSampleCount: pcm.length / PCM_BYTES_PER_SAMPLE,
      sourceKind: "generated",
    };
  }

  const sourceSampleCount = await probeSourceSampleCount(options.wavPath, options.seconds);
  const maximumBytes = options.seconds * PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE;
  const pcm = await runBoundedChild(
    "ffmpeg",
    [
      "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-f", "wav",
      "-t", String(options.seconds), "-i", options.wavPath,
      "-map_metadata", "-1", "-vn", "-ac", "1", "-ar", String(PCM_SAMPLE_RATE),
      "-f", "s16le", "pipe:1",
    ],
    maximumBytes,
    30_000,
    "WAV_CONVERSION_FAILED",
  );
  if (pcm.length === 0 || pcm.length % PCM_BYTES_PER_SAMPLE !== 0) {
    throw new WavReplayError("WAV_INVALID_PCM");
  }
  return {
    pcm,
    sourceSampleCount,
    convertedSampleCount: pcm.length / PCM_BYTES_PER_SAMPLE,
    sourceKind: "wav",
  };
}

async function probeSourceSampleCount(wavPath: string, seconds: number): Promise<number> {
  const output = await runBoundedChild(
    "ffprobe",
    [
      "-v", "error", "-protocol_whitelist", "file,pipe", "-f", "wav",
      "-select_streams", "a:0", "-show_entries",
      "stream=sample_rate,duration:format=duration", "-of", "json", wavPath,
    ],
    8_192,
    10_000,
    "WAV_PROBE_FAILED",
  );
  try {
    const parsed = JSON.parse(output.toString("utf8")) as {
      streams?: Array<{ sample_rate?: string; duration?: string }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    const sampleRate = Number(stream?.sample_rate);
    const duration = Math.min(seconds, Number(stream?.duration ?? parsed.format?.duration));
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(duration) || duration <= 0) {
      throw new Error("invalid metadata");
    }
    return Math.round(sampleRate * duration);
  } catch {
    throw new WavReplayError("WAV_PROBE_FAILED");
  }
}

function runBoundedChild(
  command: string,
  args: readonly string[],
  stdoutLimit: number,
  timeoutMs: number,
  failureCode: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let pendingError: WavReplayError | undefined;
    const finish = (error?: WavReplayError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout, stdoutBytes));
    };
    const abort = (code: string) => {
      if (settled || pendingError) return;
      pendingError = new WavReplayError(code);
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => abort("WAV_CHILD_TIMEOUT"), timeoutMs);
    child.stdout.on("data", (value: Buffer) => {
      stdoutBytes += value.length;
      if (stdoutBytes > stdoutLimit) {
        abort("WAV_OUTPUT_LIMIT");
        return;
      }
      stdout.push(value);
    });
    child.stderr.on("data", (value: Buffer) => {
      stderrBytes += value.length;
      if (stderrBytes > 16_384) abort("WAV_STDERR_LIMIT");
    });
    child.on("error", () => {
      pendingError = new WavReplayError(failureCode);
    });
    child.on("close", code => {
      if (settled) return;
      if (pendingError) finish(pendingError);
      else if (code !== 0) finish(new WavReplayError(failureCode));
      else finish();
    });
  });
}

export function createSummary(input: {
  loaded: LoadedPcm;
  durationSeconds: number;
  providerNormalizedPcmMatch: boolean;
  providerInputMatch: boolean;
  relayJaToEnByteMatch: boolean;
  relayEnToJaByteMatch: boolean;
  relaySelfDelivery: boolean;
  relayAckFlow: boolean;
  relayPaddingBytes: number;
}): Record<string, unknown> {
  return {
    ok: true,
    mode: "offline/mock",
    source: input.loaded.sourceKind,
    durationSeconds: input.durationSeconds,
    sourceSampleCount: input.loaded.sourceSampleCount,
    convertedSampleCount: input.loaded.convertedSampleCount,
    provider: {
      silenceNormalizedPcmMatch: input.providerNormalizedPcmMatch,
      inputFrameMatch: input.providerInputMatch,
    },
    relay: {
      jaToEnByteMatch: input.relayJaToEnByteMatch,
      enToJaByteMatch: input.relayEnToJaByteMatch,
      selfDelivery: input.relaySelfDelivery,
      ackFlow: input.relayAckFlow,
      paddingBytes: input.relayPaddingBytes,
    },
    notTested: [
      "external OpenAI API",
      "translation meaning accuracy",
      "iPhone AVAudioConverter or playback",
      "earphone latency",
      "real-device 10-second acceptance",
      "60-minute endurance",
    ],
  };
}
