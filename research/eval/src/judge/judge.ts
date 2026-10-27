/**
 * 判定 CLI（agent D）。
 *   --run <runDir> --reference <abs json> [--model gpt-5.4] [--skip-asr] [--batch 15]
 *   [--prompt-version v1] [--effort medium]
 * 出力: runDir/output-words.json, judgement.json, report.md（いずれも private）。
 * stdout は JudgeAggregate の JSON だけ。本文・path・鍵を出さない。
 */
import { isAbsolute, join, resolve } from "node:path";
import type { JudgeDocument, JudgedSegment, ReferenceSegment } from "../engine.ts";
import { isCurrentOutputWords, parseOutputWords, transcribeTimeline } from "./asr.ts";
import { parseReference, readBytes, readJson, readJsonIfExists, readRunMeta, readTextIfExists, writeText, type RunMeta } from "./files.ts";
import { computeAggregate, resolveSegment } from "./metrics.ts";
import { createJsonResponse, redactSecrets, supportsReasoning, type Usage } from "./openai.ts";
import {
  buildBatchInput,
  DEFAULT_PROMPT_VERSION,
  judgeInstructions,
  planBatches,
  responseSchema,
  validateBatchResponse,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
} from "./prompt.ts";
import { renderReport } from "./report.ts";
import { groupSentences } from "./sentences.ts";
import { parseTranscript } from "./transcript.ts";
import type { BatchPlan, EnSentence, OutputWord, OutputWordsDocument, RawSegmentJudgement } from "./types.ts";
import { parseWav } from "./wav.ts";

export interface JudgeArgs {
  readonly runDir: string;
  readonly referencePath: string;
  readonly model: string;
  readonly skipAsr: boolean;
  readonly batch: number;
  readonly promptVersion: string;
  readonly effort: string;
}

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const CONCURRENCY = 3;
/** 出力が溜まった run では、最大 queue より後ろまで英語を見せる。 */
const QUEUE_MARGIN_MS = 15_000;

export function parseJudgeArgs(argv: ReadonlyArray<string>): JudgeArgs {
  const values = new Map<string, string>();
  let skipAsr = false;
  for (let k = 0; k < argv.length; k += 1) {
    const flag = argv[k];
    if (flag === "--skip-asr") {
      skipAsr = true;
      continue;
    }
    if (!flag || !["--run", "--reference", "--model", "--batch", "--prompt-version", "--effort"].includes(flag)) {
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
  const batch = Number(values.get("--batch") ?? "15");
  if (!Number.isInteger(batch) || batch < 1 || batch > 50) throw new Error("--batch must be an integer in 1..50");
  const effort = values.get("--effort") ?? "medium";
  if (!EFFORTS.has(effort)) throw new Error(`--effort must be one of ${[...EFFORTS].join(", ")}`);
  return {
    runDir: resolve(runDir),
    referencePath,
    model: values.get("--model") ?? "gpt-5.4",
    skipAsr,
    batch,
    promptVersion: values.get("--prompt-version") ?? DEFAULT_PROMPT_VERSION,
    effort,
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
}

async function judgeBatch(
  plan: BatchPlan,
  ctx: { apiKey: string; args: JudgeArgs; instructions: string; words: ReadonlyArray<OutputWord>; sentences: ReadonlyArray<EnSentence>; total: number },
): Promise<BatchResult> {
  const zero: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  if (plan.wordLo > plan.wordHi) {
    log(`judge: batch ${plan.index + 1}/${ctx.total} has no English words, skipped`);
    return { judgements: new Map(plan.targets.map((s) => [s.id, noWordsJudgement(s)])), calls: 0, usage: zero };
  }
  const baseInput = buildBatchInput(plan, ctx.words, ctx.sentences);
  let input = baseInput;
  let usage = zero;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    log(`judge: batch ${plan.index + 1}/${ctx.total} attempt ${attempt} (${plan.targets.length} segments, ${plan.wordHi - plan.wordLo + 1} words)`);
    try {
      const res = await createJsonResponse({
        apiKey: ctx.apiKey,
        model: ctx.args.model,
        instructions: ctx.instructions,
        input,
        schemaName: "segment_judgements",
        schema: responseSchema(plan.targets.map((s) => s.id)),
        effort: ctx.args.effort,
      });
      usage = addUsage(usage, res.usage);
      const { judgements, problems } = validateBatchResponse(res.value, plan);
      if (problems.length === 0 || attempt === 2) {
        if (problems.length > 0) log(`judge: batch ${plan.index + 1} kept ${problems.length} problem(s) after retry`);
        return { judgements, calls: attempt, usage };
      }
      log(`judge: batch ${plan.index + 1} has ${problems.length} problem(s), retrying`);
      input = `${baseInput}\n\nYour previous answer had these problems. Fix them and answer again:\n- ${problems.join("\n- ")}`;
    } catch (error) {
      if (attempt === 2) throw error;
      log(`judge: batch ${plan.index + 1} failed (${redactSecrets(error instanceof Error ? error.message : String(error))}), retrying`);
    }
  }
  throw new Error("unreachable");
}

/** --skip-asr は現行版（v2）の output-words.json だけ再利用し、無い・古い場合は作り直す。 */
async function loadWords(args: JudgeArgs, apiKey: string | undefined, meta: RunMeta): Promise<OutputWordsDocument> {
  const wordsPath = join(args.runDir, "output-words.json");
  if (args.skipAsr) {
    const existing = await readJsonIfExists(wordsPath);
    if (isCurrentOutputWords(existing)) return parseOutputWords(existing);
    log("asr: output-words.json is missing or from an older version, regenerating");
  }
  const transcript = await readTextIfExists(join(args.runDir, "output-transcript.txt"));
  const deltas = transcript === null ? null : parseTranscript(transcript);
  const audio = parseWav(await readBytes(join(args.runDir, "output-timeline.wav")));
  const doc = await transcribeTimeline(apiKey, audio, log, { deltas, queueMaxMs: meta.queueMaxMs });
  await writeText(wordsPath, `${JSON.stringify(doc, null, 2)}\n`);
  const agreement = doc.agreement?.agreement;
  log(`asr: ${doc.words.length} words (${doc.droppedSilentWords} dropped on digital silence)${agreement == null ? "" : `, agreement with engine transcript ${Math.round(agreement * 100)}%`}`);
  return doc;
}

export async function main(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseJudgeArgs(argv);
  const instructions = judgeInstructions(args.promptVersion);
  const apiKey = process.env.OPENAI_API_KEY?.trim() || undefined;
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
  const words = wordsDoc.words;
  const sentences = groupSentences(words);
  const windowAfterMs = Math.max(WINDOW_AFTER_MS, meta.queueMaxMs + QUEUE_MARGIN_MS);
  const plans = planBatches(reference.segments, words, { batchSize: args.batch, beforeMs: WINDOW_BEFORE_MS, afterMs: windowAfterMs });
  const needsLlm = plans.some((p) => p.wordLo <= p.wordHi);
  if (needsLlm && !apiKey) throw new Error("OPENAI_API_KEY is not set");
  const results = await mapPool(plans, CONCURRENCY, (plan) =>
    judgeBatch(plan, { apiKey: apiKey ?? "", args, instructions, words, sentences, total: plans.length }),
  );
  const raw = new Map<string, RawSegmentJudgement>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let calls = 0;
  for (const r of results) {
    for (const [id, j] of r.judgements) raw.set(id, j);
    usage = addUsage(usage, r.usage);
    calls += r.calls;
  }
  const segments: JudgedSegment[] = reference.segments.map((seg) => resolveSegment(seg, raw.get(seg.id), words));
  const aggregate = computeAggregate(segments);
  // asrAgreement は JudgeDocument の型に無い欄（judge.asr の横に置く。stdout の aggregate には出さない）。
  const agreement = wordsDoc.agreement;
  const judgeInfo = {
    model: args.model,
    promptVersion: args.promptVersion,
    asr: wordsDoc.asr.model,
    ...(supportsReasoning(args.model) ? { effort: args.effort } : {}),
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
  await writeText(join(args.runDir, "judgement.json"), `${JSON.stringify(doc, null, 2)}\n`);
  await writeText(
    join(args.runDir, "report.md"),
    renderReport({
      doc,
      reference,
      words: wordsDoc,
      sentences,
      windowBeforeMs: WINDOW_BEFORE_MS,
      windowAfterMs,
      batches: plans.length,
      llmCalls: calls,
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
