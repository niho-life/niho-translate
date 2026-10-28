/**
 * output-timeline.wav → 英単語と ms（output-words.json v2）。
 * 有声区間（25 s 以下）ごとに whisper-1 を 1 窓で呼び、prompt にその時間帯のエンジン字幕を渡す。
 * 語の時刻は区間の開始を足して timeline の t に戻す（ファイル内時刻 = ハーネスの t）。
 */
import { transcribeText, transcribeWav, type WhisperVerbose } from "./openai.ts";
import { detectVoicedRegions, frameLevelsDb, voicedThresholdDb, type RegionOptions } from "./regions.ts";
import { attachPunctuation } from "./sentences.ts";
import {
  asrTokens,
  computeAgreement,
  DEFAULT_PROMPT_WINDOW,
  normalizeTokens,
  orderedAgreement,
  promptKeywords,
  subtitleTokens,
  type AsrAgreement,
  type MatchBand,
  type MinuteAgreement,
  type PromptWindow,
  type TimedToken,
  type TranscriptDelta,
} from "./transcript.ts";
import type { OutputWord, OutputWordsDocument, OutputWordsRegion } from "./types.ts";
import { durationMs, encodeWav, refineWordsWithSilence, silentFrames, sliceAudio, type PcmAudio, type TimedText } from "./wav.ts";

export const ASR_MODEL = "whisper-1";
/** 一致率が低い分を読み直す別の ASR。 */
export const CROSS_CHECK_MODEL = "gpt-4o-transcribe";
/** 1 分ごとの一致率がこれ未満なら警告し、別の ASR で読み直す。 */
export const AGREEMENT_WARN_BELOW = 0.6;
/** 読み直しの対象にする最少の語数。 */
const CROSS_CHECK_MIN_TOKENS = 10;
export const OUTPUT_WORDS_VERSION = 2;
const ASR_CONCURRENCY = 4;

/** whisper の verbose_json を、句読点つきの語（offset 加算済み ms）にする。 */
export function wordsFromWhisper(resp: WhisperVerbose, offsetMs: number): TimedText[] {
  const raw = (resp.words ?? []).filter((w) => typeof w.word === "string" && w.word.trim() !== "");
  const texts = attachPunctuation(
    raw.map((w) => w.word),
    resp.text,
  );
  return raw.map((w, k) => {
    const startMs = offsetMs + Math.round(Math.max(0, w.start) * 1000);
    const endMs = Math.max(startMs, offsetMs + Math.round(Math.max(0, w.end) * 1000));
    return { text: texts[k] ?? w.word.trim(), startMs, endMs };
  });
}

/** 時刻順に並べ、i を振り直す。 */
export function indexWords(words: ReadonlyArray<TimedText>): OutputWord[] {
  return [...words]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((w, i) => ({ i, text: w.text, startMs: w.startMs, endMs: w.endMs }));
}

/** 字幕が音声より先に届く分（queue）を含めた prompt の時間帯。 */
export function promptWindowFor(queueMaxMs: number): PromptWindow {
  return { ...DEFAULT_PROMPT_WINDOW, beforeMs: DEFAULT_PROMPT_WINDOW.beforeMs + Math.max(0, queueMaxMs) };
}

/** 一致率の照合で許す時刻差（字幕は音声より先に届く）。 */
export function agreementBandFor(queueMaxMs: number): MatchBand {
  return { beforeMs: 10_000 + Math.max(0, queueMaxMs), afterMs: 10_000 };
}

export interface TranscribeOptions {
  /** エンジン自身の訳字幕。無い run は null（prompt なし・一致率なし）。 */
  readonly deltas: ReadonlyArray<TranscriptDelta> | null;
  readonly queueMaxMs: number;
  readonly regionOptions?: Partial<RegionOptions>;
}

async function mapPool<T, R>(items: ReadonlyArray<T>, limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const k = next;
      next += 1;
      results[k] = await fn(items[k] as T, k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function transcribeTimeline(
  apiKey: string | undefined,
  audio: PcmAudio,
  log: (line: string) => void,
  options: TranscribeOptions,
): Promise<OutputWordsDocument> {
  const totalMs = durationMs(audio);
  const levels = frameLevelsDb(audio);
  const thresholdDb = voicedThresholdDb(levels);
  const ranges = Number.isFinite(thresholdDb) ? detectVoicedRegions(levels, thresholdDb, totalMs, options.regionOptions) : [];
  const deltas = options.deltas && options.deltas.length > 0 ? options.deltas : null;
  const window = promptWindowFor(options.queueMaxMs);
  if (ranges.length > 0 && !apiKey) throw new Error("OPENAI_API_KEY is not set");
  log(`asr: ${ranges.length} voiced region(s), ${Math.round(ranges.reduce((n, r) => n + r.endMs - r.startMs, 0) / 1000)} s to send`);
  const perRegion = await mapPool(ranges, ASR_CONCURRENCY, async (range, k) => {
    const prompt = deltas ? promptKeywords(deltas, range.startMs, range.endMs, window) : "";
    const resp = await transcribeWav(apiKey as string, encodeWav(sliceAudio(audio, range), audio.sampleRate), ASR_MODEL, "en", prompt);
    const words = wordsFromWhisper(resp, range.startMs).map((w) => ({
      ...w,
      startMs: Math.min(w.startMs, range.endMs),
      endMs: Math.min(w.endMs, range.endMs),
    }));
    if ((k + 1) % 10 === 0 || k + 1 === ranges.length) log(`asr: ${k + 1}/${ranges.length} regions done`);
    return { words, promptChars: prompt.length };
  });
  const refined = refineWordsWithSilence(
    perRegion.flatMap((r) => r.words),
    silentFrames(audio),
  );
  const words = indexWords(refined.words);
  const band = agreementBandFor(options.queueMaxMs);
  const subtitles = deltas ? subtitleTokens(deltas) : [];
  const agreement = deltas
    ? await crossCheckLowMinutes(apiKey, audio, ranges, words, subtitles, band, computeAgreement(asrTokens(words), subtitles, band), log)
    : null;
  const regions: OutputWordsRegion[] = ranges.map((r, k) => ({
    startMs: r.startMs,
    endMs: r.endMs,
    words: words.filter((w) => w.startMs >= r.startMs && w.startMs < r.endMs).length,
    promptChars: perRegion[k]?.promptChars ?? 0,
  }));
  return {
    version: OUTPUT_WORDS_VERSION,
    asr: { model: ASR_MODEL, language: "en", prompt: deltas ? "engine-transcript" : "none" },
    audioMs: totalMs,
    sentMs: ranges.reduce((n, r) => n + r.endMs - r.startMs, 0),
    thresholdDb: Number.isFinite(thresholdDb) ? Math.round(thresholdDb * 10) / 10 : null,
    regions,
    droppedSilentWords: refined.dropped,
    agreement,
    words,
  };
}

/**
 * 一致率が AGREEMENT_WARN_BELOW 未満の分は、その分に始まる有声区間の範囲（間の無音ごと。詰めると別 ASR が語を落とす）を
 * 別の ASR（prompt なし）で読み直し、その語が whisper と字幕のそれぞれにどれだけあるか（順序だけ）を残す。
 */
async function crossCheckLowMinutes(
  apiKey: string | undefined,
  audio: PcmAudio,
  ranges: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>,
  words: ReadonlyArray<OutputWord>,
  subtitles: ReadonlyArray<TimedToken>,
  band: MatchBand,
  agreement: AsrAgreement,
  log: (line: string) => void,
): Promise<AsrAgreement> {
  const perMinute: MinuteAgreement[] = [];
  for (const m of agreement.perMinute) {
    const inMinute = ranges.filter((r) => Math.floor(r.startMs / 60_000) === m.minute);
    const first = inMinute[0];
    const last = inMinute.at(-1);
    if (!apiKey || !first || !last || m.agreement === null || m.agreement >= AGREEMENT_WARN_BELOW || m.asrTokens < CROSS_CHECK_MIN_TOKENS) {
      perMinute.push(m);
      continue;
    }
    const span = { startMs: first.startMs, endMs: last.endMs };
    log(`asr: minute ${m.minute} agrees ${Math.round(m.agreement * 100)}% with the engine transcript, cross-checking with ${CROSS_CHECK_MODEL}`);
    const other = normalizeTokens(await transcribeText(apiKey, encodeWav(sliceAudio(audio, span), audio.sampleRate), CROSS_CHECK_MODEL));
    const whisperTokens = words.filter((w) => w.startMs >= span.startMs && w.startMs < span.endMs).flatMap((w) => normalizeTokens(w.text));
    const subtitleWindow = subtitles.filter((t) => t.t >= span.startMs - band.beforeMs && t.t <= span.endMs + band.afterMs).map((t) => t.token);
    perMinute.push({
      ...m,
      crossCheck: {
        model: CROSS_CHECK_MODEL,
        tokens: other.length,
        inWhisper: orderedAgreement(other, whisperTokens),
        withTranscript: orderedAgreement(other, subtitleWindow),
      },
    });
  }
  return { ...agreement, perMinute };
}

/** 現行版（v2）の output-words.json か。古い版は --skip-asr でも作り直す。 */
export function isCurrentOutputWords(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { version?: unknown }).version === OUTPUT_WORDS_VERSION;
}

export function parseOutputWords(value: unknown): OutputWordsDocument {
  const doc = value as Partial<OutputWordsDocument> | null;
  if (!doc || !isCurrentOutputWords(doc) || !Array.isArray(doc.words)) throw new Error("output-words.json has an unexpected shape");
  for (const [k, w] of doc.words.entries()) {
    if (w.i !== k || typeof w.text !== "string" || !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) {
      throw new Error("output-words.json has an invalid word entry");
    }
  }
  return doc as OutputWordsDocument;
}
