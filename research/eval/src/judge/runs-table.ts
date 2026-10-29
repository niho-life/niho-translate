/**
 * 複数 run の summary.json / judgement.json を engine × 主要 option ごとの 1 行にまとめる純関数。
 * 出力は数値だけ（本文・path を含めない）。
 */
import type { EngineConfig, FactType, JudgeDocument, JudgedSegment, RunSummary } from "../engine.ts";
import { computeAggregate } from "./metrics.ts";

export interface RunRecord {
  readonly summary: RunSummary;
  readonly judgement: JudgeDocument | null;
}

export interface TableRow {
  readonly engine: string;
  readonly options: string;
  readonly runs: number;
  readonly judgedRuns: number;
  readonly sources: number;
  /** statement/question 区間数（within8s・meaning の分母）。判定なしなら null。 */
  readonly n: number | null;
  readonly lStartP50Ms: number | null;
  readonly lStartP95Ms: number | null;
  readonly lStartMaxMs: number | null;
  readonly within8s: number | null;
  readonly meaningMean: number | null;
  readonly criticalFactErrors: number | null;
  /** 型ごとの wrong 件数（place を含む）。判定なしなら null。 */
  readonly factErrorsByType: Readonly<Partial<Record<FactType, number>>> | null;
  readonly omission: number | null;
  readonly hallucination: number | null;
  /** run ごとの最大値。 */
  readonly firstAudioOutMs: number | null;
  readonly queueMaxMs: number | null;
  /** run の合計。 */
  readonly over2000Count: number;
  readonly costUsd: number | null;
  /** 費用が不明な run がある。 */
  readonly costPartial: boolean;
}

const MAX_OPTION_VALUE = 24;

/** frameMs と config.options を k=v（キー順）で短く並べる。 */
export function optionLabel(config: EngineConfig): string {
  const entries = Object.entries(config.options ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v.length > MAX_OPTION_VALUE ? `${v.slice(0, MAX_OPTION_VALUE - 1)}…` : v}`);
  return [`frame=${config.frameMs}`, ...entries].join(" ");
}

function maxOrNull(values: ReadonlyArray<number | null | undefined>): number | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return xs.length > 0 ? Math.max(...xs) : null;
}

export function buildRows(runs: ReadonlyArray<RunRecord>): TableRow[] {
  const groups = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const key = `${run.summary.engineId}\u0000${optionLabel(run.summary.config)}`;
    const list = groups.get(key) ?? [];
    list.push(run);
    groups.set(key, list);
  }
  const rows: TableRow[] = [];
  for (const list of groups.values()) {
    const first = list[0] as RunRecord;
    // 旧 run で judgement.json に保存された字幕代理判定も、音声遅延へ混ぜない。
    const judged = list.filter((r) => r.judgement !== null && r.judgement.judge.asr !== "engine-subtitle");
    const segments: JudgedSegment[] = judged.flatMap((r) => [...(r.judgement as JudgeDocument).segments]);
    const agg = judged.length > 0 ? computeAggregate(segments) : null;
    const costs = list.map((r) => r.summary.costUsdEstimate);
    const knownCosts = costs.filter((c): c is number => typeof c === "number" && Number.isFinite(c));
    rows.push({
      engine: first.summary.engineId,
      options: optionLabel(first.summary.config),
      runs: list.length,
      judgedRuns: judged.length,
      sources: new Set(list.map((r) => r.summary.sourceId)).size,
      n: agg ? agg.nScored : null,
      lStartP50Ms: agg ? agg.lStart.p50 : null,
      lStartP95Ms: agg ? agg.lStart.p95 : null,
      lStartMaxMs: agg ? agg.lStart.max : null,
      within8s: agg ? agg.lStart.within8s : null,
      meaningMean: agg ? agg.meaningMean : null,
      criticalFactErrors: agg ? agg.criticalFactErrors : null,
      factErrorsByType: agg ? (agg.factErrorsByType ?? {}) : null,
      omission: agg ? (agg.flagCounts.omission ?? 0) : null,
      hallucination: agg ? (agg.flagCounts.hallucination ?? 0) : null,
      firstAudioOutMs: maxOrNull(list.map((r) => r.summary.firstAudioOutMs)),
      queueMaxMs: maxOrNull(list.map((r) => r.summary.queue?.maxMs)),
      over2000Count: list.reduce((sum, r) => sum + (r.summary.queue?.over2000Count ?? 0), 0),
      costUsd: knownCosts.length > 0 ? knownCosts.reduce((a, b) => a + b, 0) : null,
      costPartial: knownCosts.length > 0 && knownCosts.length < list.length,
    });
  }
  return rows.sort((a, b) => (a.engine === b.engine ? (a.options < b.options ? -1 : 1) : a.engine < b.engine ? -1 : 1));
}

const dash = "—";
const s1 = (ms: number | null): string => (ms === null ? dash : (ms / 1000).toFixed(1));
const int = (v: number | null): string => (v === null ? dash : String(Math.round(v)));
const esc = (text: string): string => text.replace(/\|/g, "\\|");
/** 例: "number=1 place=2"。wrong が無ければ "0"。 */
export function factErrorsLabel(byType: Readonly<Partial<Record<FactType, number>>> | null): string {
  if (byType === null) return dash;
  const parts = Object.entries(byType)
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? parts.join(" ") : "0";
}

export function renderTable(rows: ReadonlyArray<TableRow>): string {
  const lines = [
    "| engine | options | judged/runs | sources | n | lStart p50 (s) | lStart p95 (s) | lStart max (s) | within8s | meaning | criticalFactErrors | factErrorsByType | omission | hallucination | firstAudioOutMs | queue.maxMs | over2000Count | costUsd |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows) {
    const cost = r.costUsd === null ? dash : `${r.costPartial ? "≥" : ""}${r.costUsd.toFixed(3)}`;
    lines.push(
      `| ${esc(r.engine)} | ${esc(r.options)} | ${r.judgedRuns}/${r.runs} | ${r.sources} | ${int(r.n)} | ${s1(r.lStartP50Ms)} | ${s1(r.lStartP95Ms)} | ${s1(r.lStartMaxMs)} | ${r.within8s === null ? dash : `${Math.round(r.within8s * 100)}%`} | ${r.meaningMean === null ? dash : r.meaningMean.toFixed(2)} | ${int(r.criticalFactErrors)} | ${factErrorsLabel(r.factErrorsByType)} | ${int(r.omission)} | ${int(r.hallucination)} | ${int(r.firstAudioOutMs)} | ${int(r.queueMaxMs)} | ${r.over2000Count} | ${cost} |`,
    );
  }
  lines.push(
    "",
    "n = statement/question の区間数（within8s・meaning・criticalFactErrors の分母。未訳を含む）。criticalFactErrors は number/time/amount/negation/place/condition/subject の wrong、factErrorsByType は型ごとの wrong（proper_noun・tense を含む）。lStart の p50/p95（最近傍順位法）/max は backchannel 以外で訳が対応した区間の値。複数 run の行は区間を合算し、firstAudioOutMs・queue.maxMs は run ごとの最大値、over2000Count・costUsd は合計（≥ は費用不明の run を含む）。",
  );
  return `${lines.join("\n")}\n`;
}
