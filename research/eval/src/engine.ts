/**
 * 同時通訳の比較評価ハーネス: エンジン共通契約。
 * ハーネス (run.ts) が時刻を打つので、エンジンは時計を持たない。
 * 音声は常に 24 kHz mono PCM16 little-endian。
 */

export type Language = "ja" | "en";

export interface EngineConfig {
  /** "openai-translate" | "openai-live" | "openai-realtime" | "cascade" | "gemini-live-translate" | "qwen-live-translate" | "kotoba-live-translate" */
  readonly engineId: string;
  readonly sourceLanguage: Language;
  readonly targetLanguage: Language;
  /** appendPcm 1 回あたりの音声長。100 または 200。 */
  readonly frameMs: number;
  /** エンジン固有オプション。CLI の --option key=value から。 */
  readonly options: Readonly<Record<string, string>>;
}

export interface EngineSecrets {
  readonly openaiApiKey: string;
  /** Vertex AI（Gemini Live）のアクセストークン。gemini-* エンジンだけが使う。 */
  readonly googleAccessToken?: string;
  /** Alibaba Cloud Model Studio。qwen-live-translate のみ使用。 */
  readonly qwenApiKey?: string;
  /** fal.ai。kotoba-live-translate のみ使用。 */
  readonly falApiKey?: string;
}

export interface TranscriptMeta {
  readonly final?: boolean;
  readonly itemId?: string;
  readonly segmentId?: string;
}

/**
 * エンジンからハーネスへの出力。呼び出し時刻をハーネスが記録する。
 * text を含む呼び出しは private な events.jsonl にだけ残る。
 */
export interface EngineSink {
  /** 訳音声。到着したそのままの区切りで渡す（結合・分割しない）。 */
  outputAudio(pcm: Buffer): void;
  /** 訳字幕の差分。 */
  outputTranscript(text: string, meta?: TranscriptMeta): void;
  /** 原文字幕の差分（取れるエンジンだけ）。 */
  inputTranscript(text: string, meta?: TranscriptMeta): void;
  /**
   * エンジン内部の節目。kind 例: "vad.speech_started", "segment.committed",
   * "llm.request", "llm.first_token", "tts.request", "tts.first_audio", "usage".
   * data に原文・訳文を入れる場合は kind を ".text" で終える（private 扱い）。
   */
  diag(kind: string, data?: Readonly<Record<string, unknown>>): void;
  /** 回復不能。ハーネスは記録して finish へ進む。 */
  fatal(code: string, detail?: string): void;
}

export interface Engine {
  /** 接続と初期設定。音声を受け付けられる状態になったら resolve。 */
  start(): Promise<void>;
  /** frameMs ぶんの PCM を実時間で渡す。無音も渡す。 */
  appendPcm(pcm: Buffer): void;
  /** 入力終端。残りの出力を flush し、全出力の受領（または上限時間）で resolve。 */
  finish(): Promise<void>;
  /** 推定費用 (USD)。不明なら undefined。finish 後に読む。 */
  readonly costUsd?: number;
}

export type EngineFactory = (
  config: EngineConfig,
  sink: EngineSink,
  secrets: EngineSecrets,
) => Engine;

export const PCM_SAMPLE_RATE = 24_000;
export const PCM_BYTES_PER_SAMPLE = 2;
export const BYTES_PER_MS = (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE) / 1_000; // 48

/** events.jsonl の 1 行。t は最初の frame 送信時刻 (t0) からの ms。 */
export type RunEvent =
  | { type: "run.start"; t: number; runId: string; engineId: string; sourceId: string; config: EngineConfig; durationMs: number; startedAtIso: string }
  | { type: "engine.ready"; t: number }
  | { type: "frame.sent"; t: number; idx: number; scheduledT: number; bytes: number }
  | { type: "audio.out"; t: number; bytes: number; playStartT: number; playEndT: number; queueMs: number }
  | { type: "transcript.out"; t: number; text: string; final?: boolean; itemId?: string; segmentId?: string }
  | { type: "transcript.in"; t: number; text: string; final?: boolean; itemId?: string; segmentId?: string }
  | { type: "diag"; t: number; kind: string; data?: Readonly<Record<string, unknown>> }
  | { type: "fatal"; t: number; code: string; detail?: string }
  | { type: "finish.begin"; t: number }
  | { type: "finish.end"; t: number; drained: boolean }
  | { type: "run.end"; t: number };

/** summary.json。本文（原文・訳文・path）を含めない。 */
export interface RunSummary {
  readonly runId: string;
  readonly engineId: string;
  readonly sourceId: string;
  readonly config: EngineConfig;
  readonly windowStartSec: number;
  readonly windowEndSec: number;
  readonly durationMs: number;
  readonly tailSilenceMs: number;
  readonly engineReadyMs: number;
  readonly firstAudioOutMs: number | null;
  readonly firstTranscriptOutMs: number | null;
  readonly outputAudioMs: number;
  readonly outputTranscriptChars: number;
  readonly queue: { readonly maxMs: number; readonly p95Ms: number; readonly over2000Count: number; readonly over2000TotalMs: number };
  readonly perMinute: ReadonlyArray<{ readonly minute: number; readonly maxQueueMs: number; readonly outputAudioMs: number }>;
  readonly frames: { readonly count: number; readonly maxLateMs: number; readonly meanLateMs: number };
  readonly fatal: { readonly code: string } | null;
  readonly drained: boolean;
  /** Last voiced packet to session close; near-zero means the tail may have cut off speech. */
  readonly tailVoicedGapMs?: number | null;
  readonly tailTruncationRisk?: boolean;
  readonly finishWaitMs: number;
  readonly costUsdEstimate: number | null;
  readonly wallMs: number;
}

/** 正解原稿（private）。startMs/endMs は window 先頭からの ms。 */
export type FactType = "number" | "time" | "amount" | "negation" | "place" | "legal_right" | "proper_noun" | "condition" | "subject" | "tense";
/** 重大誤訳として数える fact の型（権利関係を含む）。 */
export const CRITICAL_FACT_TYPES: ReadonlyArray<FactType> = ["number", "time", "amount", "negation", "place", "legal_right", "condition", "subject", "tense"];
export interface ReferenceFact { readonly type: FactType; readonly text: string; readonly note?: string }
export interface ReferenceSegment {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker: string;
  readonly text: string;
  readonly kind: "statement" | "question" | "backchannel" | "fragment";
  readonly facts: ReadonlyArray<ReferenceFact>;
  readonly uncertain?: boolean;
}
export interface ReferenceDocument {
  readonly sourceId: string;
  readonly language: Language;
  readonly windowStartSec: number;
  readonly windowEndSec: number;
  readonly segments: ReadonlyArray<ReferenceSegment>;
  readonly provenance: { readonly asr: string; readonly proofread: string; readonly notes?: string };
}

/** 判定結果（private）。aggregate だけが公開可。 */
export type FactVerdict = "ok" | "wrong" | "omitted" | "unclear";
export type JudgeFlag = "omission" | "hallucination" | "answered_question" | "repeat" | "wrong_language" | "garbled";
export interface JudgedSegment {
  readonly id: string;
  readonly kind: ReferenceSegment["kind"];
  readonly aligned: boolean;
  readonly enStartMs: number | null;
  readonly enEndMs: number | null;
  readonly enText: string | null;
  /** enStartMs - startMs */
  readonly lStartMs: number | null;
  /** enStartMs - endMs（負なら話し終わる前に訳が始まった） */
  readonly lEndMs: number | null;
  /** enEndMs - endMs */
  readonly lTailMs: number | null;
  /** 3 = 文意が伝わる, 2 = 軽い欠落/不自然だが正しい, 1 = 重要部分が欠落/誤り, 0 = 誤訳/無/創作 */
  readonly meaning: 0 | 1 | 2 | 3;
  readonly facts: ReadonlyArray<{ readonly text: string; readonly type: FactType; readonly verdict: FactVerdict }>;
  readonly flags: ReadonlyArray<JudgeFlag>;
  readonly note: string;
}
export interface LatencyStats { readonly n: number; readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly within5s: number | null; readonly within8s: number | null }
export interface JudgeAggregate {
  readonly n: number;
  readonly nScored: number;
  readonly nAligned: number;
  readonly lStart: LatencyStats;
  readonly lEnd: LatencyStats;
  readonly lTail: LatencyStats;
  readonly meaningMean: number | null;
  readonly meaningDist: Readonly<Record<"0" | "1" | "2" | "3", number>>;
  readonly factTotals: Readonly<Record<FactVerdict, number>>;
  readonly criticalFactErrors: number;
  /** 型ごとの verdict=wrong 件数。 */
  readonly factErrorsByType?: Readonly<Partial<Record<FactType, number>>>;
  readonly flagCounts: Readonly<Partial<Record<JudgeFlag, number>>>;
}
export interface JudgeDocument {
  readonly runId: string;
  readonly sourceId: string;
  readonly engineId: string;
  readonly judge: { readonly model: string; readonly promptVersion: string; readonly asr: string; readonly effort?: string };
  readonly segments: ReadonlyArray<JudgedSegment>;
  readonly aggregate: JudgeAggregate;
}
