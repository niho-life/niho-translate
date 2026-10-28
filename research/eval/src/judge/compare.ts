/**
 * 2 つの判定（例: OpenAI の judgement.json と agy の judgement-agy.json）の一致を数値だけで出す。
 *   node --experimental-transform-types research/eval/src/judge/compare.ts --a <judgement.json> --b <judgement-agy.json>
 * 判定器の偏りの確認用。本文・path は出さない。
 */
import type { JudgeDocument, JudgeFlag } from "../engine.ts";
import { readJson } from "./files.ts";
import { JUDGE_FLAGS } from "./metrics.ts";

export interface JudgeComparison {
  readonly modelA: string;
  readonly modelB: string;
  /** 両方にある区間の数。 */
  readonly n: number;
  readonly meaningMeanA: number | null;
  readonly meaningMeanB: number | null;
  /** B − A（statement/question の意味平均）。 */
  readonly meaningMeanDiff: number | null;
  /** 全区間のうち意味の点が同じ数 / ±1 以内の数。 */
  readonly meaningSame: number;
  readonly meaningWithin1: number;
  readonly alignedA: number;
  readonly alignedB: number;
  /** 片方だけが対応ありとした区間の数。 */
  readonly alignedDisagree: number;
  /** 両方が対応ありとした区間のうち、開始語（enStartMs）が同じ数。 */
  readonly bothAligned: number;
  readonly sameEnStart: number;
  /** 両方が対応ありで開始語が違う区間の |差| の最大（ms）。 */
  readonly maxEnStartDiffMs: number | null;
  readonly lStartP50A: number | null;
  readonly lStartP50B: number | null;
  readonly criticalFactErrorsA: number;
  readonly criticalFactErrorsB: number;
  /** B − A の flags の件数差（0 は省く）。 */
  readonly flagDiff: Readonly<Partial<Record<JudgeFlag, number>>>;
  /** fact の verdict が同じ数 / 両方にある fact の数。 */
  readonly factSame: number;
  readonly factTotal: number;
}

export function compareJudgements(a: JudgeDocument, b: JudgeDocument): JudgeComparison {
  const byId = new Map(b.segments.map((s) => [s.id, s]));
  let n = 0;
  let meaningSame = 0;
  let meaningWithin1 = 0;
  let alignedDisagree = 0;
  let bothAligned = 0;
  let sameEnStart = 0;
  let maxEnStartDiffMs: number | null = null;
  let factSame = 0;
  let factTotal = 0;
  for (const sa of a.segments) {
    const sb = byId.get(sa.id);
    if (!sb) continue;
    n += 1;
    if (sa.meaning === sb.meaning) meaningSame += 1;
    if (Math.abs(sa.meaning - sb.meaning) <= 1) meaningWithin1 += 1;
    if (sa.aligned !== sb.aligned) alignedDisagree += 1;
    if (sa.aligned && sb.aligned && sa.enStartMs !== null && sb.enStartMs !== null) {
      bothAligned += 1;
      if (sa.enStartMs === sb.enStartMs) sameEnStart += 1;
      else maxEnStartDiffMs = Math.max(maxEnStartDiffMs ?? 0, Math.abs(sa.enStartMs - sb.enStartMs));
    }
    sa.facts.forEach((f, k) => {
      const g = sb.facts[k];
      if (!g || g.text !== f.text) return;
      factTotal += 1;
      if (g.verdict === f.verdict) factSame += 1;
    });
  }
  const flagDiff: Partial<Record<JudgeFlag, number>> = {};
  for (const flag of JUDGE_FLAGS) {
    const d = (b.aggregate.flagCounts[flag] ?? 0) - (a.aggregate.flagCounts[flag] ?? 0);
    if (d !== 0) flagDiff[flag] = d;
  }
  const ma = a.aggregate.meaningMean;
  const mb = b.aggregate.meaningMean;
  return {
    modelA: a.judge.model,
    modelB: b.judge.model,
    n,
    meaningMeanA: ma,
    meaningMeanB: mb,
    meaningMeanDiff: ma === null || mb === null ? null : Math.round((mb - ma) * 1000) / 1000,
    meaningSame,
    meaningWithin1,
    alignedA: a.segments.filter((s) => s.aligned).length,
    alignedB: b.segments.filter((s) => s.aligned).length,
    alignedDisagree,
    bothAligned,
    sameEnStart,
    maxEnStartDiffMs,
    lStartP50A: a.aggregate.lStart.p50,
    lStartP50B: b.aggregate.lStart.p50,
    criticalFactErrorsA: a.aggregate.criticalFactErrors,
    criticalFactErrorsB: b.aggregate.criticalFactErrors,
    flagDiff,
    factSame,
    factTotal,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const k = argv.indexOf(flag);
    return k >= 0 ? argv[k + 1] : undefined;
  };
  const pa = get("--a");
  const pb = get("--b");
  if (!pa || !pb) {
    process.stderr.write("usage: compare.ts --a <judgement.json> --b <judgement-agy.json>\n");
    process.exitCode = 1;
  } else {
    Promise.all([readJson(pa), readJson(pb)])
      .then(([a, b]) => process.stdout.write(`${JSON.stringify(compareJudgements(a as JudgeDocument, b as JudgeDocument), null, 2)}\n`))
      .catch((error: unknown) => {
        process.stderr.write(`compare failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
