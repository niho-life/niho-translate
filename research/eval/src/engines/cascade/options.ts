/** cascade エンジンのオプション（CLI の --option k=v）。未知のキーと不正な値はエラーにする。 */
import type { TtsChunkMode } from "./text-stream.ts";

export type AsrModel = "gpt-live-transcribe" | "gpt-transcribe";
export type AsrDelay = "minimal" | "low" | "medium";
export type AsrVad = "client" | "semantic";
export type VadEagerness = "low" | "medium" | "high" | "auto";
export type NoiseReduction = "near_field" | "far_field" | "none";
export type TtsEngineId = "gpt-4o-mini-tts" | "realtime-mini";
export type BackchannelMode = "short" | "drop";
export type SegmenterMode = "clause" | "sentence";

export interface CascadeOptions {
  readonly asr: AsrModel;
  readonly asrDelay: AsrDelay;
  /** gpt-live-transcribe は client だけ。gpt-transcribe は semantic（server の semantic_vad）か client。 */
  readonly asrVad: AsrVad;
  readonly vadEagerness: VadEagerness;
  readonly noiseReduction: NoiseReduction;
  /** client VAD: 発話後この無音で input_audio_buffer.commit。 */
  readonly commitSilenceMs: number;
  /** (c) 話者の間とみなす無音の長さ。 */
  readonly pauseMs: number;
  readonly segmenter: SegmenterMode;
  readonly minClauseChars: number;
  readonly minClauseMs: number;
  readonly softMaxMs: number;
  readonly hardMaxMs: number;
  readonly llm: string;
  /** priority = OpenAI Fast mode（単価は約 2 倍、TTFT のばらつきが小さい）。 */
  readonly llmTier: "default" | "priority";
  /** 最初の token がこの時間で来なければ同じ要求をもう 1 本出し、先に token を返した方を使う（0 で無効）。 */
  readonly llmHedgeMs: number;
  readonly context: number;
  readonly glossary: boolean;
  readonly domain: boolean;
  readonly tts: TtsEngineId;
  readonly voice: string;
  readonly ttsChunk: TtsChunkMode;
  readonly ttsConcurrency: number;
  readonly ttsFirstByteTimeoutMs: number;
  /** tts=realtime-mini の最初の音声がこの時間で来なければ gpt-4o-mini-tts を並行して始め、先に鳴った方を使う（0 で無効）。 */
  readonly ttsHedgeMs: number;
  readonly backchannel: BackchannelMode;
  readonly paceAheadMs: number;
  readonly finishTimeoutMs: number;
}

export const DEFAULT_CASCADE_OPTIONS: CascadeOptions = {
  asr: "gpt-live-transcribe",
  asrDelay: "low",
  asrVad: "client",
  vadEagerness: "high",
  noiseReduction: "near_field",
  commitSilenceMs: 500,
  pauseMs: 700,
  segmenter: "clause",
  minClauseChars: 12,
  minClauseMs: 2_000,
  softMaxMs: 8_000,
  hardMaxMs: 10_000,
  llm: "gpt-5.4-mini",
  llmTier: "priority",
  llmHedgeMs: 1_000,
  context: 6,
  glossary: true,
  domain: true,
  tts: "realtime-mini",
  voice: "marin",
  ttsChunk: "sentence",
  ttsConcurrency: 3,
  ttsFirstByteTimeoutMs: 3_000,
  ttsHedgeMs: 1_500,
  backchannel: "short",
  paceAheadMs: 1_500,
  finishTimeoutMs: 18_000,
};

/** realtime-mini = 訳と発話を gpt-realtime-2.1-mini の 1 応答で行う（fused。tts は realtime-mini に固定）。 */
export const KNOWN_LLMS = ["gpt-5.4-mini", "gpt-4.1-mini", "gpt-5.4", "realtime-mini"] as const;
const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];

function oneOf<T extends string>(key: string, value: string, allowed: ReadonlyArray<T>): T {
  if ((allowed as ReadonlyArray<string>).includes(value)) return value as T;
  throw new Error(`cascade option ${key} must be one of ${allowed.join("|")}`);
}

function int(key: string, value: string, min: number, max: number): number {
  if (!/^\d+$/u.test(value)) throw new Error(`cascade option ${key} must be an integer`);
  const n = Number(value);
  if (n < min || n > max) throw new Error(`cascade option ${key} must be ${min}..${max}`);
  return n;
}

function flag(key: string, value: string): boolean {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`cascade option ${key} must be 0|1`);
}

export function parseCascadeOptions(raw: Readonly<Record<string, string>>): CascadeOptions {
  const o: { -readonly [K in keyof CascadeOptions]: CascadeOptions[K] } = { ...DEFAULT_CASCADE_OPTIONS };
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "asr": o.asr = oneOf(key, value, ["gpt-live-transcribe", "gpt-transcribe"] as const); break;
      case "asrDelay": o.asrDelay = oneOf(key, value, ["minimal", "low", "medium"] as const); break;
      case "asrVad": o.asrVad = oneOf(key, value, ["client", "semantic"] as const); break;
      case "vadEagerness": o.vadEagerness = oneOf(key, value, ["low", "medium", "high", "auto"] as const); break;
      case "noiseReduction": o.noiseReduction = oneOf(key, value, ["near_field", "far_field", "none"] as const); break;
      case "commitSilenceMs": o.commitSilenceMs = int(key, value, 200, 3_000); break;
      case "pauseMs": o.pauseMs = int(key, value, 200, 5_000); break;
      case "segmenter": o.segmenter = oneOf(key, value, ["clause", "sentence"] as const); break;
      case "minClauseChars": o.minClauseChars = int(key, value, 1, 200); break;
      case "minClauseMs": o.minClauseMs = int(key, value, 0, 30_000); break;
      case "softMaxMs": o.softMaxMs = int(key, value, 1_000, 60_000); break;
      case "hardMaxMs": o.hardMaxMs = int(key, value, 1_000, 60_000); break;
      case "llm": o.llm = oneOf(key, value, KNOWN_LLMS); break;
      case "llmTier": o.llmTier = oneOf(key, value, ["default", "priority"] as const); break;
      case "llmHedgeMs": o.llmHedgeMs = int(key, value, 0, 30_000); break;
      case "context": o.context = int(key, value, 0, 50); break;
      case "glossary": o.glossary = flag(key, value); break;
      case "domain": o.domain = flag(key, value); break;
      case "tts": o.tts = oneOf(key, value, ["gpt-4o-mini-tts", "realtime-mini"] as const); break;
      case "voice": o.voice = oneOf(key, value, VOICES); break;
      case "ttsChunk": o.ttsChunk = oneOf(key, value, ["sentence", "clause", "unit"] as const); break;
      case "ttsConcurrency": o.ttsConcurrency = int(key, value, 1, 8); break;
      case "ttsFirstByteTimeoutMs": o.ttsFirstByteTimeoutMs = int(key, value, 500, 30_000); break;
      case "ttsHedgeMs": o.ttsHedgeMs = int(key, value, 0, 30_000); break;
      case "backchannel": o.backchannel = oneOf(key, value, ["short", "drop"] as const); break;
      case "paceAheadMs": o.paceAheadMs = int(key, value, 0, 10_000); break;
      case "finishTimeoutMs": o.finishTimeoutMs = int(key, value, 1_000, 120_000); break;
      default: throw new Error(`unknown cascade option: ${key}`);
    }
  }
  if (o.hardMaxMs < o.softMaxMs) throw new Error("cascade option hardMaxMs must be >= softMaxMs");
  if (o.asr === "gpt-live-transcribe" && o.asrVad !== "client") {
    throw new Error("gpt-live-transcribe does not support server VAD; use asrVad=client");
  }
  if (o.llm === "realtime-mini") {
    if (raw.tts === "gpt-4o-mini-tts") throw new Error("llm=realtime-mini speaks by itself; tts must be realtime-mini");
    o.tts = "realtime-mini";
  }
  // gpt-transcribe の既定は server の semantic_vad（明示した asrVad はそのまま）。
  if (o.asr === "gpt-transcribe" && !Object.hasOwn(raw, "asrVad")) o.asrVad = "semantic";
  return o;
}
