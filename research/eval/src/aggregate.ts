/**
 * 集計 CLI（agent D）: --runs <runDir...> [--out <abs md>]
 * 各 run の summary.json と（あれば）judgement.json から、engine × 主要 option ごとの
 * Markdown 表（数値のみ）を stdout に出す。--out があればファイルにも書く。
 */
import { isAbsolute, join } from "node:path";
import type { JudgeDocument, RunSummary } from "./engine.ts";
import { readJsonIfExists, writeText } from "./judge/files.ts";
import { buildRows, renderTable, type RunRecord } from "./judge/runs-table.ts";

export interface AggregateArgs {
  readonly runs: ReadonlyArray<string>;
  readonly out: string | null;
}

export function parseAggregateArgs(argv: ReadonlyArray<string>): AggregateArgs {
  const runs: string[] = [];
  let out: string | null = null;
  for (let k = 0; k < argv.length; k += 1) {
    const flag = argv[k];
    if (flag === "--runs") {
      while (k + 1 < argv.length && !(argv[k + 1] ?? "").startsWith("--")) runs.push(argv[++k] as string);
    } else if (flag === "--out") {
      const value = argv[++k];
      if (!value || !isAbsolute(value)) throw new Error("--out needs an absolute path");
      out = value;
    } else {
      throw new Error(`unknown argument: ${flag ?? ""}`);
    }
  }
  if (runs.length === 0) throw new Error("--runs <runDir...> is required");
  return { runs, out };
}

function isSummary(value: unknown): value is RunSummary {
  const v = value as Partial<RunSummary> | null;
  return !!v && typeof v.engineId === "string" && typeof v.sourceId === "string" && typeof v.config === "object" && v.config !== null;
}

function isJudgement(value: unknown): value is JudgeDocument {
  const v = value as Partial<JudgeDocument> | null;
  return !!v && Array.isArray(v.segments) && typeof v.aggregate === "object";
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseAggregateArgs(argv);
  const records: RunRecord[] = [];
  let skipped = 0;
  for (const dir of args.runs) {
    const summary = await readJsonIfExists(join(dir, "summary.json"));
    if (!isSummary(summary)) {
      skipped += 1;
      continue;
    }
    const judgement = await readJsonIfExists(join(dir, "judgement.json"));
    records.push({ summary, judgement: isJudgement(judgement) ? judgement : null });
  }
  if (skipped > 0) process.stderr.write(`aggregate: skipped ${skipped} run(s) without a readable summary.json\n`);
  const table = renderTable(buildRows(records));
  process.stdout.write(table);
  if (args.out) await writeText(args.out, table);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`aggregate failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
