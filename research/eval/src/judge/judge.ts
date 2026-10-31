/**
 * 判定 CLI（agent D）。
 *   --run <runDir> --reference <abs json> [--judge-backend openai|agy|anthropic|codex] [--model <id>] [--skip-asr]
 *   [--word-source audio|subtitle]
 *   [--batch 15（agy / codex は 8）] [--prompt-version v3] [--effort medium] [--out-name judgement.json]
 * --model の既定は openai なら gpt-5.4、agy なら claude-opus-4-6-thinking、anthropic なら claude-opus-5-5
 *（judge.model は "agy:<id>" / "anthropic:<id>"）。anthropic は Anthropic API を直接呼ぶ第二審判（鍵は ANTHROPIC_API_KEY）。
 * --effort の既定は openai medium / anthropic high / agy なし。--judge-backend の既定は anthropic（2026-10-28 から。gpt-5.4 は openai で第二審判）。
 * 出力: runDir/output-words.json と、--out-name（既定 judgement.json）・対応する report*.md（いずれも private）。
 * stdout は JudgeAggregate の JSON だけ。本文・path・鍵を出さない。
 */
import { isAbsolute, join, resolve } from "node:path";
import type { JudgeDocument, JudgedSegment, ReferenceSegment } from "../engine.ts";
import { isCurrentOutputWords, parseOutputWords, transcribeTimeline } from "./asr.ts";
import { AGY_DEFAULT_MODEL, AGY_EFFORTS, agyPrompt, isAgyQuotaError, runAgy, type AgySchemaMode } from "./agy.ts";
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_EFFORTS, createAnthropicJsonResponse } from "./anthropic.ts";
import { runCodexJudge } from "./codex.ts";
import { transcribeTimelineLocal } from "./local-whisper.ts";
import { outputNames, parseReference, readBytes, readJson, readJsonIfExists, readRunMeta, readTextIfExists, writeText, type RunMeta } from "./files.ts";
import { computeAggregate, resolveSegment } from "./metrics.ts";
import { createJsonResponse, redactSecrets, supportsReasoning, type Usage } from "./openai.ts";
import {
  buildBatchInput,
  DEFAULT_PROMPT_VERSION,
  judgeInstructions,
  planBatches,
  portableResponseSchema,
  responseSchema,
  validateBatchResponse,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
} from "./prompt.ts";
import { renderReport } from "./report.ts";
import { groupSentences } from "./sentences.ts";
import { parseTranscript, subtitleWords } from "./transcript.ts";
import type { BatchPlan, EnSentence, OutputWord, OutputWordsDocument, RawSegmentJudgement } from "./types.ts";
import { parseWav } from "./wav.ts";

export type JudgeBackend = "openai" | "agy" | "anthropic" | "codex";

export interface JudgeArgs {
  readonly runDir: string;
  readonly referencePath: string;
  readonly backend: JudgeBackend;
  /** 判定ファイル名（report の名前はここから決まる）。 */
  readonly outName: string;
  readonly model: string;
  readonly skipAsr: boolean;
  readonly asrOnly: boolean;
  readonly asrBackend: "openai" | "local";
  readonly whisperModel: string | null;
  /** subtitle はエンジン字幕到着時刻を用いる安価な暫定判定。音声開始の遅延ではない。 */
  readonly wordSource: "audio" | "subtitle";
  readonly batch: number;
  readonly promptVersion: string;
  /** openai は既定 medium、anthropic は既定 high。agy はモデルごとに対応が違うので、明示したときだけ渡す（null = 渡さない）。 */
  readonly effort: string | null;
  /** agy の出力の形の強制方法（prompt = schema を prompt に書いて 1 回で答えさせる）。 */
  readonly agySchema: AgySchemaMode;
}

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const OPENAI_DEFAULT_MODEL = "gpt-5.4";
/** agy は 1 回 10〜60 秒かかり、並列は 2 まで。 */
const CONCURRENCY: Readonly<Record<JudgeBackend, number>> = { openai: 3, agy: 2, anthropic: 3, codex: 1 };
/** 出力が溜まった run では、最大 queue より後ろまで英語を見せる。 */
const QUEUE_MARGIN_MS = 15_000;

export function parseJudgeArgs(argv: ReadonlyArray<string>): JudgeArgs {
  const values = new Map<string, string>();
  let skipAsr = false;
  let asrOnly = false;
  for (let k = 0; k < argv.length; k += 1) {
    const flag = argv[k];
    if (flag === "--skip-asr") {
      skipAsr = true;
      continue;
    }
    if (flag === "--asr-only") {
      asrOnly = true;
      continue;
    }
    if (!flag || !["--run", "--reference", "--judge-backend", "--model", "--batch", "--prompt-version", "--effort", "--out-name", "--agy-schema", "--word-source", "--asr-backend", "--whisper-model"].includes(flag)) {
      throw new Error(`unknown argument: ${flag ?? ""}`);
    }
    const value = argv[k + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (values.has(flag)) throw new Error(`${flag} given twice`);
    values.set(flag, value);
    k += 1;
  }
  const runDir = values.get("--run");
  const referencePath = values.get("--reference");
  if (!runDir) throw new Error("--run <runDir> is required");
  if (!referencePath || !isAbsolute(referencePath)) throw new Error("--reference <absolute json path> is required");
  const backend = values.get("--judge-backend") ?? "anthropic";
  if (backend !== "openai" && backend !== "agy" && backend !== "anthropic" && backend !== "codex") throw new Error("--judge-backend must be openai, agy, anthropic or codex");
  // agy は 1 回の応答が長いと時間上限に掛かるので、既定の区間数を小さくする
  const batch = Number(values.get("--batch") ?? (backend === "agy" || backend === "codex" ? "8" : "15"));
  if (!Number.isInteger(batch) || batch < 1 || batch > 50) throw new Error("--batch must be an integer in 1..50");
  const effort = values.get("--effort") ?? (backend === "agy" || backend === "codex" ? null : backend === "anthropic" ? "high" : "medium");
  if (backend === "codex" && effort !== null) throw new Error("--effort is not supported for codex app-server");
  const allowed = backend === "agy" ? AGY_EFFORTS : backend === "anthropic" ? ANTHROPIC_EFFORTS : EFFORTS;
  if (effort !== null && !allowed.has(effort)) throw new Error(`--effort must be one of ${[...allowed].join(", ")} for ${backend}`);
  const wordSource = values.get("--word-source") ?? "audio";
  if (wordSource !== "audio" && wordSource !== "subtitle") throw new Error("--word-source must be audio or subtitle");
  const outName = values.get("--out-name") ?? (wordSource === "subtitle" ? "judgement-subtitle.json" : "judgement.json");
  outputNames(outName);
  const asrBackend = values.get("--asr-backend") ?? "openai";
  if (asrBackend !== "openai" && asrBackend !== "local") throw new Error("--asr-backend must be openai or local");
  const whisperModel = values.get("--whisper-model") ?? null;
  if (asrBackend === "local" && wordSource === "audio" && !skipAsr && (!whisperModel || !isAbsolute(whisperModel))) {
    throw new Error("--asr-backend local requires --whisper-model <absolute path>");
  }
  if (whisperModel && asrBackend !== "local") throw new Error("--whisper-model requires --asr-backend local");
  // enforce が既定: prompt モードは 1 回で済むが、実測で壊れた JSON を返した
  const agySchema = values.get("--agy-schema") ?? "enforce";
  if (agySchema !== "prompt" && agySchema !== "enforce") throw new Error("--agy-schema must be prompt or enforce");
  return {
    runDir: resolve(runDir),
    referencePath,
    backend,
    outName,
    model: values.get("--model") ?? (backend === "agy" ? AGY_DEFAULT_MODEL : backend === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : backend === "codex" ? "gpt-6-astra" : OPENAI_DEFAULT_MODEL),
    skipAsr,
    asrOnly,
    asrBackend,
    whisperModel,
    wordSource,
    batch,
    promptVersion: values.get("--prompt-version") ?? DEFAULT_PROMPT_VERSION,
    effort,
    agySchema,
  };
}

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

async function mapPool<T, R>(items: ReadonlyArray<T>, limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const k = next;
      next += 1;
      results[k] = await fn(items[k] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function noWordsJudgement(seg: ReferenceSegment): RawSegmentJudgement {
  return {
    id: seg.id,
    aligned: false,
    enStartWordIdx: null,
    enEndWordIdx: null,
    meaning: 0,
    facts: [],
    flags: [],
    note: "対象の時間範囲に英語の語が無い",
  };
}

interface BatchResult {
  readonly judgements: Map<string, RawSegmentJudgement>;
  readonly calls: number;
  readonly usage: Usage;
  /** 呼び出しごとの所要時間（秒）。 */
  readonly seconds: ReadonlyArray<number>;
}

/** 選んだ backend で 1 回判定する（構造化出力の JSON を返す）。 */
async function callJudge(
  ctx: { apiKey: string; anthropicKey: string; args: JudgeArgs; instructions: string },
  input: string,
  schema: Record<string, unknown>,
): Promise<{ value: unknown; usage: Usage }> {
  if (ctx.args.backend === "agy") {
    return runAgy({
      model: ctx.args.model,
      prompt: agyPrompt(ctx.instructions, input, ctx.args.agySchema === "prompt" ? schema : undefined),
      schema,
      schemaMode: ctx.args.agySchema,
      ...(ctx.args.effort ? { effort: ctx.args.effort } : {}),
    });
  }
  if (ctx.args.backend === "anthropic") {
    return createAnthropicJsonResponse({
      apiKey: ctx.anthropicKey,
      model: ctx.args.model,
      instructions: ctx.instructions,
      input,
      schema,
      ...(ctx.args.effort ? { effort: ctx.args.effort } : {}),
    });
  }
  if (ctx.args.backend === "codex") {
    return runCodexJudge({ model: ctx.args.model, instructions: ctx.instructions, input, schema });
  }
  return createJsonResponse({
    apiKey: ctx.apiKey,
    model: ctx.args.model,
    instructions: ctx.instructions,
    input,
    schemaName: "segment_judgements",
    schema,
    ...(ctx.args.effort ? { effort: ctx.args.effort } : {}),
  });
}

async function judgeBatch(
  plan: BatchPlan,
  ctx: { apiKey: string; anthropicKey: string; args: JudgeArgs; instructions: string; words: ReadonlyArray<OutputWord>; sentences: ReadonlyArray<EnSentence>; total: number },
): Promise<BatchResult> {
  const zero: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  if (plan.wordLo > plan.wordHi) {
    log(`judge: batch ${plan.index + 1}/${ctx.total} has no English words, skipped`);
    return { judgements: new Map(plan.targets.map((s) => [s.id, noWordsJudgement(s)])), calls: 0, usage: zero, seconds: [] };
  }
  const baseInput = buildBatchInput(plan, ctx.words, ctx.sentences);
  const ids = plan.targets.map((s) => s.id);
  const schema = ctx.args.backend === "agy" ? portableResponseSchema(ids) : responseSchema(ids);
  let input = baseInput;
  let usage = zero;
  const seconds: number[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    log(`judge: batch ${plan.index + 1}/${ctx.total} attempt ${attempt} (${plan.targets.length} segments, ${plan.wordHi - plan.wordLo + 1} words)`);
    const started = performance.now();
    try {
      const res = await callJudge(ctx, input, schema);
      seconds.push(Math.round((performance.now() - started) / 100) / 10);
      log(`judge: batch ${plan.index + 1} answered in ${seconds.at(-1)} s`);
      usage = addUsage(usage, res.usage);
      const { judgements, problems } = validateBatchResponse(res.value, plan);
      if (problems.length === 0 || attempt === 2) {
        if (problems.length > 0) log(`judge: batch ${plan.index + 1} kept ${problems.length} problem(s) after retry`);
        return { judgements, calls: attempt, usage, seconds };
      }
      log(`judge: batch ${plan.index + 1} has ${problems.length} problem(s), retrying`);
      input = `${baseInput}\n\nYour previous answer had these problems. Fix them and answer again:\n- ${problems.join("\n- ")}`;
    } catch (error) {
      // 利用上限は再試行しても通らない
      if (attempt === 2 || isAgyQuotaError(error instanceof Error ? error.message : String(error))) throw error;
      log(`judge: batch ${plan.index + 1} failed (${redactSecrets(error instanceof Error ? error.message : String(error))}), retrying`);
    }
  }
  throw new Error("unreachable");
}

/** --skip-asr は現行版（v2）の output-words.json だけ再利用し、無い・古い場合は課金を避けるため失敗させる。 */
async function loadWords(args: JudgeArgs, apiKey: string | undefined, meta: RunMeta): Promise<OutputWordsDocument> {
  if (args.wordSource === "subtitle") {
    const transcript = await readTextIfExists(join(args.runDir, "output-transcript.txt"));
    if (transcript === null) throw new Error("output-transcript.txt is required for --word-source subtitle");
    const deltas = parseTranscript(transcript);
    const words = subtitleWords(deltas);
    if (words.length === 0) throw new Error("output-transcript.txt has no words");
    return {
      version: 2,
      asr: { model: "engine-subtitle", language: "en", prompt: "none" },
      audioMs: meta.windowEndSec === null || meta.windowStartSec === null ? 0 : Math.round((meta.windowEndSec - meta.windowStartSec) * 1000),
      sentMs: 0,
      thresholdDb: null,
      regions: [],
      droppedSilentWords: 0,
      agreement: null,
      words,
    };
  }
  const wordsPath = join(args.runDir, args.asrBackend === "local" ? "output-words-local.json" : "output-words.json");
  if (args.skipAsr) {
    const existing = await readJsonIfExists(wordsPath);
    if (isCurrentOutputWords(existing)) return parseOutputWords(existing);
    throw new Error(`--skip-asr requires an existing v2 ${args.asrBackend === "local" ? "output-words-local.json" : "output-words.json"}`);
  }
  const transcript = await readTextIfExists(join(args.runDir, "output-transcript.txt"));
  const deltas = transcript === null ? null : parseTranscript(transcript);
  const audio = parseWav(await readBytes(join(args.runDir, "output-timeline.wav")));
  const doc = args.asrBackend === "local"
    ? await transcribeTimelineLocal(audio, args.runDir, args.whisperModel as string, log, { deltas, queueMaxMs: meta.queueMaxMs })
    : await transcribeTimeline(apiKey, audio, log, { deltas, queueMaxMs: meta.queueMaxMs });
  await writeText(wordsPath, `${JSON.stringify(doc, null, 2)}\n`);
  const agreement = doc.agreement?.agreement;
  log(`asr: ${doc.words.length} words (${doc.droppedSilentWords} dropped on digital silence)${agreement == null ? "" : `, agreement with engine transcript ${Math.round(agreement * 100)}%`}`);
  return doc;
}

export async function main(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseJudgeArgs(argv);
  const instructions = judgeInstructions(args.promptVersion);
  const apiKey = process.env.OPENAI_API_KEY?.trim() || undefined;
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  const meta = await readRunMeta(args.runDir);
  const reference = parseReference(await readJson(args.referencePath));
  if (reference.sourceId !== meta.sourceId) throw new Error("reference sourceId does not match the run sourceId");
  if (
    meta.windowStartSec !== null &&
    Number.isFinite(reference.windowStartSec) &&
    Math.abs(meta.windowStartSec - reference.windowStartSec) > 0.001
  ) {
    throw new Error("reference window does not match the run window");
  }
  const wordsDoc = await loadWords(args, apiKey, meta);
  if (args.asrOnly) {
    process.stdout.write(`${JSON.stringify({ asr: wordsDoc.asr.model, words: wordsDoc.words.length, agreement: wordsDoc.agreement?.agreement ?? null })}\n`);
    return;
  }
  const words = wordsDoc.words;
  const sentences = groupSentences(words);
  const windowAfterMs = Math.max(WINDOW_AFTER_MS, meta.queueMaxMs + QUEUE_MARGIN_MS);
  const plans = planBatches(reference.segments, words, { batchSize: args.batch, beforeMs: WINDOW_BEFORE_MS, afterMs: windowAfterMs });
  const needsLlm = plans.some((p) => p.wordLo <= p.wordHi);
  if (needsLlm && args.backend === "openai" && !apiKey) throw new Error("OPENAI_API_KEY is not set");
  if (needsLlm && args.backend === "anthropic" && !anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const results = await mapPool(plans, CONCURRENCY[args.backend], (plan) =>
    judgeBatch(plan, { apiKey: apiKey ?? "", anthropicKey: anthropicKey ?? "", args, instructions, words, sentences, total: plans.length }),
  );
  const raw = new Map<string, RawSegmentJudgement>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let calls = 0;
  const callSeconds: number[] = [];
  for (const r of results) {
    for (const [id, j] of r.judgements) raw.set(id, j);
    usage = addUsage(usage, r.usage);
    calls += r.calls;
    callSeconds.push(...r.seconds);
  }
  const segments: JudgedSegment[] = reference.segments.map((seg) => resolveSegment(seg, raw.get(seg.id), words));
  const aggregate = computeAggregate(segments);
  // asrAgreement は JudgeDocument の型に無い欄（judge.asr の横に置く。stdout の aggregate には出さない）。
  const agreement = wordsDoc.agreement;
  const effortUsed = args.effort !== null && (args.backend !== "openai" || supportsReasoning(args.model));
  const judgeInfo = {
    model: args.backend === "openai" ? args.model : `${args.backend}:${args.model}`,
    promptVersion: args.promptVersion,
    asr: wordsDoc.asr.model,
    ...(effortUsed ? { effort: args.effort } : {}),
    asrAgreement: agreement
      ? {
          agreement: agreement.agreement,
          coverage: agreement.coverage,
          perMinute: agreement.perMinute.map((m) => ({ minute: m.minute, agreement: m.agreement, coverage: m.coverage })),
        }
      : null,
  };
  const doc: JudgeDocument = {
    runId: meta.runId,
    sourceId: meta.sourceId,
    engineId: meta.engineId,
    judge: judgeInfo,
    segments,
    aggregate,
  };
  const names = outputNames(args.outName);
  await writeText(join(args.runDir, names.judgement), `${JSON.stringify(doc, null, 2)}\n`);
  await writeText(
    join(args.runDir, names.report),
    renderReport({
      doc,
      reference,
      words: wordsDoc,
      sentences,
      windowBeforeMs: WINDOW_BEFORE_MS,
      windowAfterMs,
      batches: plans.length,
      llmCalls: calls,
      callSeconds,
      usage,
      generatedAtIso: new Date().toISOString(),
    }),
  );
  log(`judge: ${calls} call(s), tokens in ${usage.inputTokens} / out ${usage.outputTokens}`);
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    log(`judge failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  });
}
