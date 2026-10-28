/**
 * 判定器（agent D）の内部型。engine.ts の公開契約（JudgeDocument など）は変えない。
 * output-words.json は private（英語本文を含む）。
 */
import type { FactVerdict, JudgeFlag, ReferenceSegment } from "../engine.ts";
import type { AsrAgreement } from "./transcript.ts";

/** whisper-1 の英単語 1 語。startMs/endMs はハーネスの t（output-timeline.wav のファイル内時刻）。 */
export interface OutputWord {
  readonly i: number;
  /** whisper の text から復元した句読点つきの表記。 */
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** ASR に送った有声区間（timeline の t、余白込み）。 */
export interface OutputWordsRegion {
  readonly startMs: number;
  readonly endMs: number;
  readonly words: number;
  /** whisper の prompt に渡したエンジン字幕の文字数（0 = prompt なし）。 */
  readonly promptChars: number;
}

/** runDir/output-words.json（v2: 有声区間ごとの whisper-1 ＋エンジン字幕の prompt）。 */
export interface OutputWordsDocument {
  readonly version: 2;
  readonly asr: { readonly model: string; readonly language: "en"; readonly prompt: "engine-transcript" | "none" };
  readonly audioMs: number;
  /** ASR に送った音声の合計（ms）。 */
  readonly sentMs: number;
  readonly thresholdDb: number | null;
  readonly regions: ReadonlyArray<OutputWordsRegion>;
  /** 全体が完全無音の上に置かれ、ASR の幻聴として捨てた語の数。 */
  readonly droppedSilentWords: number;
  /** ASR の語とエンジン字幕の一致率（字幕が無い run は null）。 */
  readonly agreement: AsrAgreement | null;
  readonly words: ReadonlyArray<OutputWord>;
}

/** 句読点と 0.6 秒超の間でまとめた英語の文。wordStart/wordEnd は両端を含む語 index。 */
export interface EnSentence {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly wordStart: number;
  readonly wordEnd: number;
  readonly text: string;
}

/** LLM が区間ごとに返す判定。時刻は持たせず、語 index からコードで決める。 */
export interface RawSegmentJudgement {
  readonly id: string;
  readonly aligned: boolean;
  readonly enStartWordIdx: number | null;
  readonly enEndWordIdx: number | null;
  readonly meaning: 0 | 1 | 2 | 3;
  /** index は区間の facts 配列の位置。 */
  readonly facts: ReadonlyArray<{ readonly index: number; readonly verdict: FactVerdict }>;
  readonly flags: ReadonlyArray<JudgeFlag>;
  readonly note: string;
}

/** LLM 1 回ぶんの区間と、その呼び出しに渡す英単語の範囲。 */
export interface BatchPlan {
  readonly index: number;
  readonly targets: ReadonlyArray<ReferenceSegment>;
  readonly before: ReadonlyArray<ReferenceSegment>;
  readonly after: ReadonlyArray<ReferenceSegment>;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /** 渡す語 index の範囲（両端含む）。語が無ければ wordLo > wordHi。 */
  readonly wordLo: number;
  readonly wordHi: number;
}
