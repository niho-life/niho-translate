/**
 * 正解原稿（時刻付き日本語区間）を作る CLI。
 *
 *   npm --silent run eval:reference -- --wav <abs.wav> --window <startSec>:<endSec> --source-id <id> \
 *     [--turn-transcript <abs.md>] [--out <abs.json>] [--llm gpt-5.4 | anthropic:claude-opus-5-5] [--reasoning medium] \
 *     [--whisper-cli-model <abs.bin>] [--draft <abs.json>] [--refresh-asr] [--refresh-llm] [--no-vad-trim]
 *
 * 中間物（切り出した WAV、ASR 応答、LLM 下書き）は $EVAL_PRIVATE_DIR/work/agentC/<sourceId>/ に置き、
 * 同じ切り出しなら再利用する。出力は ReferenceDocument（既定 $EVAL_PRIVATE_DIR/reference/<sourceId>.json）と
 * 同じ場所の <sourceId>.review.md。stdout には件数の JSON だけを出す（本文・path・鍵を出さない）。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { buildCharStream, type TimedUnit } from "./align.ts";
import { parseMakeReferenceArgs, type MakeReferenceArgs } from "./args.ts";
import { parseDiarized, parseWhisperCpp, parseWhisperVerbose, readWavPcm16 } from "./asr.ts";
import { buildReference } from "./build.ts";
import { buildDraftRequest, DISCREPANCY_CATEGORIES, isUnresolved, parseDraftSegments, PROMPT_VERSION, type Draft, type DraftInput } from "./draft.ts";
import { createAnthropicResponse, isAnthropicModel } from "./anthropic.ts";
import { createResponse, OpenAIRequestError, redactSecrets, transcribe, type ResponseResult, type ResponseUsage } from "./openai.ts";
import { renderReview } from "./review.ts";
import { referenceStats } from "./stats.ts";
import { applyFactsPass, buildFactsRequest, FACTS_PROMPT_VERSION, parseFactsOutput } from "./facts.ts";
import { excerptForWindow, parseTurnTranscript, type TranscriptExcerpt } from "./transcript.ts";
import { energyEnvelope } from "./vad.ts";

const TRANSCRIBE_USD_PER_MIN = 0.006;
/** USD / 1M tokens（2026-10 公示）。 */
const LLM_PRICES: Readonly<Record<string, { input: number; cached: number; output: number }>> = {
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "anthropic:claude-opus-5-5": { input: 4, cached: 0.2, output: 20 },
  "anthropic:claude-sonnet-5-5": { input: 2, cached: 0.2, output: 10 },
  "anthropic:claude-fable-5-1": { input: 10, cached: 0.25, output: 50 },
};
const DIARIZE_USD_PER_M = { input: 6, output: 10 };

interface CacheMeta {
  clipSha256?: string;
  whisperCppModel?: string;
  draftInputSha256?: string;
  factsInputSha256?: string;
}

const log = (message: string): void => {
  process.stderr.write(`make-reference: ${message}\n`);
};

/** エラー表示から鍵と絶対 path を消す。 */
function sanitize(message: string): string {
  return redactSecrets(message).replace(/(?:\/[^\s'"`:,)]+)+/g, "<path>");
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writePrivate(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}

/** 子プロセスを実行する。出力（本文を含み得る）は表示しない。 */
function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
    });
    child.on("error", error => reject(new Error(`${command} could not start: ${error.message}`)));
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (exit ${String(code)}, stderr ${stderrBytes} bytes)`));
    });
  });
}

async function cachedJson(path: string, useCache: boolean, produce: () => Promise<unknown>): Promise<{ value: unknown; cached: boolean }> {
  if (useCache && (await exists(path))) return { value: await readJson(path), cached: true };
  const value = await produce();
  await writePrivate(path, `${JSON.stringify(value)}\n`);
  return { value, cached: false };
}

function requireKey(name = "OPENAI_API_KEY"): string {
  const key = process.env[name];
  if (key === undefined || key.length === 0) throw new Error(`${name} is required`);
  return key;
}

/** --llm / --facts-llm が anthropic:<id> なら Anthropic、それ以外は OpenAI Responses。 */
function callLlm(request: Record<string, unknown>): Promise<ResponseResult> {
  const model = String(request["model"] ?? "");
  return isAnthropicModel(model) ? createAnthropicResponse(requireKey("ANTHROPIC_API_KEY"), request) : createResponse(requireKey(), request);
}

function llmCost(model: string, usage: ResponseUsage): number | null {
  const price = LLM_PRICES[model];
  if (price === undefined) return null;
  const uncached = usage.inputTokens - usage.cachedInputTokens;
  return (uncached * price.input + usage.cachedInputTokens * price.cached + usage.outputTokens * price.output) / 1_000_000;
}

function diarizeCost(json: unknown, minutes: number): number {
  const usage = (typeof json === "object" && json !== null ? (json as Record<string, unknown>)["usage"] : undefined) as Record<string, unknown> | undefined;
  const byMinute = minutes * TRANSCRIBE_USD_PER_MIN;
  if (usage === undefined || usage["type"] !== "tokens") return byMinute;
  const input = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
  const output = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0;
  return Math.max(byMinute, (input * DIARIZE_USD_PER_M.input + output * DIARIZE_USD_PER_M.output) / 1_000_000);
}

function speakerLabelsFor(excerpt: TranscriptExcerpt | null, diarized: readonly TimedUnit[]): string[] {
  const fromTranscript = [...new Set((excerpt?.utterances ?? []).map(u => u.speaker))];
  if (fromTranscript.length > 0) return fromTranscript.sort();
  const count = new Set(diarized.map(u => u.speaker).filter(s => s !== undefined)).size;
  return Array.from({ length: Math.max(1, count) }, (_, i) => `話者${i}`);
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

async function main(args: MakeReferenceArgs): Promise<void> {
  const privateDir = process.env["EVAL_PRIVATE_DIR"];
  if (privateDir === undefined || !isAbsolute(privateDir)) throw new Error("EVAL_PRIVATE_DIR (absolute path) is required");
  const workDir = join(privateDir, "work", "agentC", args.sourceId);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const outPath = args.out ?? join(privateDir, "reference", `${args.sourceId}.json`);
  const reviewPath = join(dirname(outPath), `${args.sourceId}.review.md`);
  const windowSec = args.windowEndSec - args.windowStartSec;

  // 1) window を 16 kHz mono に切り出す。
  const clipPath = join(workDir, "clip.wav");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(args.windowStartSec), "-t", String(windowSec), "-i", args.wav, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", clipPath]);
  const clip = await readFile(clipPath);
  const pcm = readWavPcm16(clip);
  if (pcm.durationMs < windowSec * 1000 - 50) throw new Error("the window extends beyond the end of the audio");
  const clipSha = sha256(clip);
  const cachePath = join(workDir, "cache.json");
  const cache: CacheMeta = (await exists(cachePath)) ? ((await readJson(cachePath)) as CacheMeta) : {};
  const sameClip = cache.clipSha256 === clipSha;
  const useAsrCache = sameClip && !args.refreshAsr;
  const minutes = windowSec / 60;

  // 2) ASR 3 系統（並行）。
  const whisperFields: Array<readonly [string, string]> = [
    ["model", "whisper-1"],
    ["language", "ja"],
    ["response_format", "verbose_json"],
    ["timestamp_granularities[]", "word"],
    ["timestamp_granularities[]", "segment"],
  ];
  const diarizeFields: Array<readonly [string, string]> = [
    ["model", "gpt-4o-transcribe-diarize"],
    ["language", "ja"],
    ["response_format", "diarized_json"],
    ["chunking_strategy", "auto"],
  ];
  const whisperCppModelKey = args.whisperCliModel !== undefined ? `${args.whisperCliModel.split("/").pop() ?? ""}:${(await stat(args.whisperCliModel)).size}` : undefined;
  const tasks = await Promise.all([
    cachedJson(join(workDir, "whisper1.json"), useAsrCache, () => transcribe(requireKey(), clip, whisperFields)),
    cachedJson(join(workDir, "diarize.json"), useAsrCache, async () => {
      try {
        return await transcribe(requireKey(), clip, diarizeFields);
      } catch (error) {
        if (error instanceof OpenAIRequestError && error.status === 400 && /language/i.test(error.message)) {
          return transcribe(requireKey(), clip, diarizeFields.filter(([k]) => k !== "language"));
        }
        throw error;
      }
    }),
    args.whisperCliModel !== undefined
      ? cachedJson(join(workDir, "whispercpp.json"), useAsrCache && cache.whisperCppModel === whisperCppModelKey, async () => {
          const base = join(workDir, "whispercpp-out");
          await run("whisper-cli", ["-m", args.whisperCliModel!, "-l", "ja", "-oj", "-np", "-of", base, "-f", clipPath]);
          const value = await readJson(`${base}.json`);
          await rm(`${base}.json`, { force: true });
          return value;
        })
      : Promise.resolve(null),
  ]);
  const [whisperTask, diarizeTask, cppTask] = tasks;
  const whisper = parseWhisperVerbose(whisperTask.value);
  const diarized = parseDiarized(diarizeTask.value);
  const whisperCpp = cppTask !== null ? parseWhisperCpp(cppTask.value) : null;
  let cost = 0;
  if (!whisperTask.cached) cost += minutes * TRANSCRIBE_USD_PER_MIN;
  if (!diarizeTask.cached) cost += diarizeCost(diarizeTask.value, minutes);
  log(`asr: whisper-1 ${whisper.words.length} words${whisperTask.cached ? " (cached)" : ""}, diarize ${diarized.length} segments${diarizeTask.cached ? " (cached)" : ""}, whisper.cpp ${whisperCpp?.length ?? "-"} segments${cppTask?.cached === true ? " (cached)" : ""}`);
  const newCache: CacheMeta = { ...cache, clipSha256: clipSha };
  if (whisperCppModelKey !== undefined) newCache.whisperCppModel = whisperCppModelKey;

  // 3) 人手転記から window の部分を本文一致で抜き出す。
  let excerpt: TranscriptExcerpt | null = null;
  if (args.turnTranscript !== undefined) {
    const utterances = parseTurnTranscript(await readFile(args.turnTranscript, "utf8"));
    const byWhisper = excerptForWindow(utterances, buildCharStream(whisper.words).cps, args.windowStartSec, args.windowEndSec);
    const byDiarize = excerptForWindow(utterances, buildCharStream(diarized).cps, args.windowStartSec, args.windowEndSec);
    excerpt = byWhisper.coverage >= byDiarize.coverage ? byWhisper : byDiarize;
    await writePrivate(join(workDir, "transcript-excerpt.json"), `${JSON.stringify(excerpt, null, 1)}\n`);
    log(`transcript: ${excerpt.utterances.length} of ${excerpt.candidates} candidate utterances (bundled ${excerpt.bundledIncluded}), coverage ${excerpt.coverage.toFixed(2)}`);
  }
  const speakerLabels = speakerLabelsFor(excerpt, diarized);

  // 4) LLM の下書き（または与えられた下書き）。
  let draft: Draft;
  let llmCached = false;
  if (args.draft !== undefined) {
    const raw = (await readJson(args.draft)) as Record<string, unknown>;
    draft = {
      version: 1,
      sourceId: args.sourceId,
      promptVersion: typeof raw["promptVersion"] === "string" ? raw["promptVersion"] : PROMPT_VERSION,
      model: typeof raw["model"] === "string" ? raw["model"] : args.llm,
      segments: parseDraftSegments(raw),
      notes: typeof raw["notes"] === "string" ? raw["notes"] : null,
      ...(typeof raw["editedBy"] === "string" ? { editedBy: raw["editedBy"] } : {}),
    };
    llmCached = true;
  } else {
    const draftInput: DraftInput = { durationMs: Math.round(windowSec * 1000), whisperWords: whisper.words, diarized, whisperCpp, transcript: excerpt, transcriptKind: args.transcriptKind, speakerLabels };
    const request = buildDraftRequest(draftInput, args.llm, args.reasoning);
    const inputSha = sha256(JSON.stringify(request));
    const draftPath = join(workDir, "draft.json");
    if (!args.refreshLlm && cache.draftInputSha256 === inputSha && (await exists(draftPath))) {
      const raw = (await readJson(draftPath)) as Record<string, unknown>;
      draft = { ...(raw as unknown as Draft), segments: parseDraftSegments(raw) };
      llmCached = true;
      log("llm: cached draft");
    } else {
      const started = Date.now();
      const response = await callLlm(request);
      if (response.status !== "completed") throw new Error(`llm response ${response.status}`);
      const parsed = JSON.parse(response.text) as Record<string, unknown>;
      draft = {
        version: 1,
        sourceId: args.sourceId,
        promptVersion: PROMPT_VERSION,
        model: args.llm,
        segments: parseDraftSegments(parsed),
        notes: typeof parsed["notes"] === "string" ? parsed["notes"] : null,
      };
      await writePrivate(draftPath, `${JSON.stringify(draft, null, 1)}\n`);
      await writePrivate(join(workDir, "llm-usage.json"), `${JSON.stringify({ model: args.llm, reasoning: args.reasoning, promptVersion: PROMPT_VERSION, usage: response.usage, seconds: (Date.now() - started) / 1000 })}\n`);
      newCache.draftInputSha256 = inputSha;
      const c = llmCost(args.llm, response.usage);
      if (c !== null) cost += c;
      log(`llm: ${draft.segments.length} segments in ${Math.round((Date.now() - started) / 1000)} s (in ${response.usage.inputTokens} / out ${response.usage.outputTokens} tokens, reasoning ${response.usage.reasoningTokens})`);
    }
  }
  // 4b) facts の専用パス（最終本文から抜き出し直し、下書きの facts と和集合）。
  let draftSegments = draft.segments;
  let factsCached: boolean | null = null;
  if (args.factsPass) {
    const request = buildFactsRequest(draft.segments, args.factsLlm, args.factsReasoning);
    const inputSha = sha256(JSON.stringify(request));
    const factsPath = join(workDir, "facts.json");
    let passFacts;
    if (!args.refreshLlm && cache.factsInputSha256 === inputSha && (await exists(factsPath))) {
      passFacts = parseFactsOutput(await readJson(factsPath), draft.segments.length);
      factsCached = true;
    } else {
      const started = Date.now();
      const response = await callLlm(request);
      if (response.status !== "completed") throw new Error(`facts response ${response.status}`);
      const parsed = JSON.parse(response.text) as unknown;
      passFacts = parseFactsOutput(parsed, draft.segments.length);
      await writePrivate(factsPath, `${JSON.stringify(parsed)}\n`);
      newCache.factsInputSha256 = inputSha;
      const c = llmCost(args.factsLlm, response.usage);
      if (c !== null) cost += c;
      factsCached = false;
      log(`facts: ${passFacts.reduce((a, f) => a + (f?.length ?? 0), 0)} facts in ${Math.round((Date.now() - started) / 1000)} s (in ${response.usage.inputTokens} / out ${response.usage.outputTokens} tokens)`);
    }
    draftSegments = applyFactsPass(draft.segments, passFacts);
  }
  await writePrivate(cachePath, `${JSON.stringify(newCache)}\n`);

  // 5) 時刻付けと整合性チェック。
  const transcriptUnits = excerpt !== null && excerpt.utterances.length > 0 ? excerpt.utterances.map(u => ({ text: u.text, startMs: 0, endMs: 0, speaker: u.speaker })) : null;
  const asrLabel = `whisper-1 (verbose_json word+segment, ja) for timing; gpt-4o-transcribe-diarize (diarized_json) for speakers${whisperCpp !== null ? "; whisper.cpp large-v3-turbo as third check" : ""}`;
  const proofread = [
    `${draft.model} (${draft.promptVersion}) collation of the ASR outputs${transcriptUnits !== null ? (args.transcriptKind === "gemini" ? " and a Gemini (Vertex AI) transcript (D)" : " and the unproofread turn transcript") : ""}`,
    ...(args.factsPass ? [`facts completed by ${args.factsLlm} (${FACTS_PROMPT_VERSION}) from the final text and merged with the draft facts`] : []),
    "deterministic word-time alignment (normalized exact match, LCS fallback)",
    ...(draft.editedBy !== undefined ? [`edited by ${draft.editedBy}`] : []),
    "not human-verified",
  ].join("; ");
  const result = buildReference({
    sourceId: args.sourceId,
    windowStartSec: args.windowStartSec,
    windowEndSec: args.windowEndSec,
    draft: draftSegments,
    whisperWords: whisper.words,
    diarized,
    whisperCpp,
    transcript: transcriptUnits,
    envelope: args.vadTrim ? energyEnvelope(pcm.samples, pcm.sampleRate) : null,
    provenance: {
      asr: asrLabel,
      proofread,
      ...(args.vadTrim ? { notes: "segment edges trimmed inward over clear silence only (max 3 s per edge; silence = max(noise floor + 6 dB, median - 25 dB)); segments over 12 s split at clause boundaries" } : {}),
    },
  });
  const stats = referenceStats(result.doc);
  const dLabel = args.transcriptKind === "gemini" ? "Gemini" : "転記";
  await writePrivate(outPath, `${JSON.stringify(result.doc, null, 2)}\n`);
  await writePrivate(
    reviewPath,
    renderReview(result, stats, {
      sourceLabels: { A: "whisper-1", B: "diarize", C: "whisper.cpp", D: dLabel },
      sourceSummary: [
        `系統: A whisper-1 語 ${whisper.words.length}・B diarize 区間 ${diarized.length}（話者 ${new Set(diarized.map(d => d.speaker)).size}）・C whisper.cpp 区間 ${whisperCpp?.length ?? "-"}`,
        excerpt !== null ? `D ${dLabel}: 発話 ${excerpt.utterances.length}/${excerpt.candidates} 候補・ASR 一致 ${excerpt.coverage.toFixed(2)}・時刻の壊れた束から ${excerpt.bundledIncluded}` : `D ${dLabel}: なし`,
      ],
      draftLabel: `${draft.model} / ${draft.promptVersion}${draft.editedBy !== undefined ? ` / 編集 ${draft.editedBy}` : ""}`,
    }),
  );

  const discrepancies = result.reports.flatMap(r => r.discrepancies);
  const byCategory = (filter: (d: (typeof discrepancies)[number]) => boolean): Record<string, number> =>
    Object.fromEntries(DISCREPANCY_CATEGORIES.map(c => [c, discrepancies.filter(d => d.category === c && filter(d)).length]));
  const summary = {
    ...stats,
    timing: countBy(result.reports.map(r => r.timing)),
    trimmed: { start: result.reports.filter(r => r.trimmedStartMs > 0).length, end: result.reports.filter(r => r.trimmedEndMs > 0).length },
    checks: countBy(result.issues.map(i => `${i.code}:${i.action}`)),
    speakerMismatch: result.reports.filter((r, i) => r.diarizeSpeaker !== null && r.diarizeSpeaker !== result.doc.segments[i]!.speaker).length,
    uncoveredRuns: countBy(result.uncovered.map(u => u.source)),
    discrepancies: {
      total: byCategory(() => true),
      unresolved: byCategory(isUnresolved),
      ...(transcriptUnits !== null
        ? {
            transcriptDiffers: byCategory(d => !d.support.includes("D")),
            transcriptOnly: byCategory(d => d.support.length === 1 && d.support[0] === "D"),
          }
        : {}),
    },
    transcript: excerpt !== null ? { utterances: excerpt.utterances.length, bundledIncluded: excerpt.bundledIncluded, coverage: Math.round(excerpt.coverage * 100) / 100 } : null,
    cached: { whisper1: whisperTask.cached, diarize: diarizeTask.cached, whisperCpp: cppTask?.cached ?? null, llm: llmCached, facts: factsCached },
    costUsdEstimate: Math.round(cost * 1000) / 1000,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

try {
  await main(parseMakeReferenceArgs(process.argv.slice(2)));
} catch (error) {
  log(sanitize(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
