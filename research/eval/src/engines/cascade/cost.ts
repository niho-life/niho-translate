/**
 * 費用の推定（USD）。単価は OpenAI の公式 pricing / model ページ（2026-10-28 確認）。
 * - ASR: 分単価 × item の課金秒（completed の usage.seconds。無ければ送った音声長）。
 * - LLM: token 単価（cached input は別単価）。
 * - gpt-4o-mini-tts: 音声 token は応答に無いので音声長から推定（公式の目安 $0.015/分 = 1,250 token/分）、
 *   text 入力 token は 4 文字 = 1 token で近似。
 * - realtime-mini: response.done の usage から。
 */
import type { AsrModel, TtsEngineId } from "./options.ts";

export const ASR_USD_PER_MINUTE: Readonly<Record<AsrModel, number>> = {
  "gpt-live-transcribe": 0.017,
  "gpt-transcribe": 0.0045,
};

/** USD per 1M tokens: [input, cached input, output] */
export const LLM_USD_PER_MTOK: Readonly<Record<string, readonly [number, number, number]>> = {
  "gpt-5.4-mini": [0.75, 0.075, 4.5],
  "gpt-4.1-mini": [0.4, 0.1, 1.6],
  "gpt-5.4": [2.5, 0.25, 15],
  // fused（訳も realtime-mini）: token は realtime の usage 側で数える。
  "realtime-mini": [0, 0, 0],
};

/** Fast mode（service_tier=priority）の単価。 */
export const LLM_PRIORITY_USD_PER_MTOK: Readonly<Record<string, readonly [number, number, number]>> = {
  "gpt-5.4-mini": [1.5, 0.15, 9],
  "gpt-4.1-mini": [0.7, 0.175, 2.8],
  "gpt-5.4": [5, 0.5, 30],
  "realtime-mini": [0, 0, 0],
};

export const MINI_TTS_TEXT_USD_PER_MTOK = 0.6;
export const MINI_TTS_AUDIO_USD_PER_MTOK = 12;
export const MINI_TTS_AUDIO_TOKENS_PER_SECOND = 1_250 / 60;
export const REALTIME_MINI_USD_PER_MTOK = { textInput: 0.6, cachedInput: 0.06, textOutput: 2.4, audioOutput: 20 } as const;

export interface CascadeUsage {
  readonly asrModel: AsrModel;
  readonly asrBilledSeconds: number;
  readonly llmModel: string;
  readonly llmTier: "default" | "priority";
  readonly llmInputTokens: number;
  readonly llmCachedTokens: number;
  readonly llmOutputTokens: number;
  readonly tts: TtsEngineId;
  readonly ttsAudioMs: number;
  readonly ttsInputChars: number;
  readonly realtimeTextInputTokens: number;
  readonly realtimeCachedInputTokens: number;
  readonly realtimeTextOutputTokens: number;
  readonly realtimeAudioOutputTokens: number;
}

export function estimateCascadeCostUsd(usage: CascadeUsage): number | undefined {
  const llm = (usage.llmTier === "priority" ? LLM_PRIORITY_USD_PER_MTOK : LLM_USD_PER_MTOK)[usage.llmModel];
  if (!llm) return undefined;
  const asr = (usage.asrBilledSeconds / 60) * ASR_USD_PER_MINUTE[usage.asrModel];
  const uncached = Math.max(0, usage.llmInputTokens - usage.llmCachedTokens);
  const llmCost = (uncached * llm[0] + usage.llmCachedTokens * llm[1] + usage.llmOutputTokens * llm[2]) / 1_000_000;
  let tts: number;
  if (usage.tts === "gpt-4o-mini-tts") {
    const audioTokens = (usage.ttsAudioMs / 1_000) * MINI_TTS_AUDIO_TOKENS_PER_SECOND;
    const textTokens = usage.ttsInputChars / 4;
    tts = (audioTokens * MINI_TTS_AUDIO_USD_PER_MTOK + textTokens * MINI_TTS_TEXT_USD_PER_MTOK) / 1_000_000;
  } else {
    const p = REALTIME_MINI_USD_PER_MTOK;
    const uncachedText = Math.max(0, usage.realtimeTextInputTokens - usage.realtimeCachedInputTokens);
    tts = (uncachedText * p.textInput + usage.realtimeCachedInputTokens * p.cachedInput
      + usage.realtimeTextOutputTokens * p.textOutput + usage.realtimeAudioOutputTokens * p.audioOutput) / 1_000_000;
  }
  return asr + llmCost + tts;
}
