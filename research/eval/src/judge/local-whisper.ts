/**
 * 課金なしの英語音声 ASR。モデルファイルと成果物は private の run directory に置く。
 * whisper.cpp の JSON は有声区間ごとに生成し、時刻を replay timeline に戻す。
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { detectVoicedRegions, frameLevelsDb, voicedThresholdDb } from "./regions.ts";
import { agreementBandFor, indexWords, OUTPUT_WORDS_VERSION } from "./asr.ts";
import { asrTokens, computeAgreement, subtitleTokens, type TranscriptDelta } from "./transcript.ts";
import type { OutputWordsDocument, OutputWordsRegion } from "./types.ts";
import { durationMs, encodeWav, refineWordsWithSilence, silentFrames, sliceAudio, type PcmAudio, type TimedText } from "./wav.ts";

interface WhisperSegment {
  readonly text?: unknown;
  readonly offsets?: { readonly from?: unknown; readonly to?: unknown };
}

/** -ml 1 -sow -ojf の transcription を ms 付き英単語へ変換する。 */
export function wordsFromWhisperCpp(value: unknown, offsetMs: number, endMs: number): TimedText[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { transcription?: unknown }).transcription)) {
    throw new Error("whisper.cpp JSON has no transcription array");
  }
  const segments = (value as { transcription: WhisperSegment[] }).transcription;
  const words: TimedText[] = [];
  for (const segment of segments) {
    if (typeof segment.text !== "string" || !/[\p{L}\p{N}]/u.test(segment.text)) continue;
    const start = segment.offsets?.from;
    const end = segment.offsets?.to;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error("whisper.cpp JSON has invalid word offsets");
    }
    const startMs = Math.min(endMs, Math.max(offsetMs, offsetMs + Math.round(start)));
    const endWordMs = Math.min(endMs, Math.max(startMs, offsetMs + Math.round(end)));
    words.push({ text: segment.text.trim(), startMs, endMs: endWordMs });
  }
  return words;
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, 120_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error(`${command} could not start`)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export async function transcribeTimelineLocal(
  audio: PcmAudio,
  runDir: string,
  modelPath: string,
  log: (line: string) => void,
  options: { readonly deltas: ReadonlyArray<TranscriptDelta> | null; readonly queueMaxMs: number },
): Promise<OutputWordsDocument> {
  try { await access(modelPath); } catch { throw new Error("local Whisper model file is unavailable"); }
  const totalMs = durationMs(audio);
  const levels = frameLevelsDb(audio);
  const thresholdDb = voicedThresholdDb(levels);
  const ranges = Number.isFinite(thresholdDb) ? detectVoicedRegions(levels, thresholdDb, totalMs) : [];
  const tempDir = await mkdtemp(join(runDir, ".local-asr-"));
  const perRegion: TimedText[][] = [];
  log(`local-asr: ${ranges.length} voiced region(s), ${Math.round(ranges.reduce((n, r) => n + r.endMs - r.startMs, 0) / 1000)} s to process`);
  try {
    for (const [k, range] of ranges.entries()) {
      const source = join(tempDir, "source.wav");
      const converted = join(tempDir, "converted.wav");
      const output = join(tempDir, "result");
      await writeFile(source, encodeWav(sliceAudio(audio, range), audio.sampleRate));
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-ar", "16000", "-ac", "1", converted]);
      await run("whisper-cli", ["-m", modelPath, "-f", converted, "-l", "en", "-ml", "1", "-sow", "-ojf", "-of", output, "-np"]);
      perRegion.push(wordsFromWhisperCpp(JSON.parse(await readFile(`${output}.json`, "utf8")), range.startMs, range.endMs));
      if ((k + 1) % 5 === 0 || k + 1 === ranges.length) log(`local-asr: ${k + 1}/${ranges.length} regions done`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  const refined = refineWordsWithSilence(perRegion.flat(), silentFrames(audio));
  const words = indexWords(refined.words);
  const deltas = options.deltas?.length ? options.deltas : null;
  const agreement = deltas
    ? computeAgreement(asrTokens(words), subtitleTokens(deltas), agreementBandFor(options.queueMaxMs))
    : null;
  const regions: OutputWordsRegion[] = ranges.map((r, k) => ({
    startMs: r.startMs,
    endMs: r.endMs,
    words: words.filter((w) => w.startMs >= r.startMs && w.startMs < r.endMs).length,
    promptChars: 0,
  }));
  return {
    version: OUTPUT_WORDS_VERSION,
    asr: { model: `whisper.cpp/${basename(modelPath)}`, language: "en", prompt: "none" },
    audioMs: totalMs,
    sentMs: ranges.reduce((n, r) => n + r.endMs - r.startMs, 0),
    thresholdDb: Number.isFinite(thresholdDb) ? Math.round(thresholdDb * 10) / 10 : null,
    regions,
    droppedSilentWords: refined.dropped,
    agreement,
    words,
  };
}
