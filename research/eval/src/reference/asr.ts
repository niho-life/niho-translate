/**
 * ASR 応答（whisper-1 verbose_json / gpt-4o-transcribe-diarize diarized_json / whisper.cpp JSON）を
 * 内部の時刻付き単位へ変換する純関数と、WAV の読み取り。時刻はすべて clip（window）先頭からの ms。
 */
import type { TimedUnit } from "./align.ts";

export interface WhisperVerbose {
  readonly words: readonly TimedUnit[];
  readonly segments: readonly TimedUnit[];
  readonly text: string;
  readonly durationMs: number | null;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what}: object expected`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) : null;
}

function unit(text: unknown, startMs: number | null, endMs: number | null, speaker?: unknown): TimedUnit | null {
  if (typeof text !== "string" || startMs === null || endMs === null) return null;
  const base = { text, startMs, endMs: Math.max(endMs, startMs) };
  return typeof speaker === "string" && speaker.length > 0 ? { ...base, speaker } : base;
}

export function parseWhisperVerbose(json: unknown): WhisperVerbose {
  const root = asRecord(json, "whisper-1");
  const words = asArray(root["words"])
    .map(w => {
      const r = asRecord(w, "whisper-1 word");
      return unit(r["word"], seconds(r["start"]), seconds(r["end"]));
    })
    .filter((w): w is TimedUnit => w !== null);
  const segments = asArray(root["segments"])
    .map(s => {
      const r = asRecord(s, "whisper-1 segment");
      return unit(r["text"], seconds(r["start"]), seconds(r["end"]));
    })
    .filter((s): s is TimedUnit => s !== null);
  return { words, segments, text: typeof root["text"] === "string" ? root["text"] : "", durationMs: seconds(root["duration"]) };
}

export function parseDiarized(json: unknown): TimedUnit[] {
  const root = asRecord(json, "diarize");
  return asArray(root["segments"])
    .map(s => {
      const r = asRecord(s, "diarize segment");
      return unit(r["text"], seconds(r["start"]), seconds(r["end"]), r["speaker"]);
    })
    .filter((s): s is TimedUnit => s !== null && s.text.trim().length > 0);
}

export function parseWhisperCpp(json: unknown): TimedUnit[] {
  const root = asRecord(json, "whisper.cpp");
  return asArray(root["transcription"])
    .map(s => {
      const r = asRecord(s, "whisper.cpp segment");
      const offsets = asRecord(r["offsets"], "whisper.cpp offsets");
      const from = typeof offsets["from"] === "number" ? offsets["from"] : null;
      const to = typeof offsets["to"] === "number" ? offsets["to"] : null;
      return unit(typeof r["text"] === "string" ? r["text"].trim() : null, from, to);
    })
    .filter((s): s is TimedUnit => s !== null && s.text.length > 0);
}

export interface WavPcm {
  readonly sampleRate: number;
  readonly channels: number;
  readonly samples: Int16Array;
  readonly durationMs: number;
}

/** PCM16 の WAV を読む（mono を想定。多チャンネルなら 1 チャンネル目）。 */
export function readWavPcm16(buffer: Buffer): WavPcm {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (format !== 1 || bits !== 16 || channels < 1 || sampleRate <= 0) throw new Error("PCM16 WAV expected");
      const end = Math.min(buffer.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = buffer.readInt16LE(body + i * 2 * channels);
      return { sampleRate, channels, samples, durationMs: Math.round((frames / sampleRate) * 1000) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV data chunk not found");
}
