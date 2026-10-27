/**
 * 人が見直すための Markdown（本文を含む。private の EVAL_PRIVATE_DIR にだけ書く）。
 */
import type { ReferenceDocument } from "../engine.ts";
import type { BuildResult, SegmentReport } from "./build.ts";
import { isUnresolved, SOURCE_KEYS, type Discrepancy, type SourceKey } from "./draft.ts";
import type { ReferenceStats } from "./stats.ts";

export interface ReviewMeta {
  readonly sourceLabels: Readonly<Record<SourceKey, string>>;
  readonly sourceSummary: readonly string[];
  readonly draftLabel: string;
}

const s1 = (ms: number): string => (ms / 1000).toFixed(2);
const pct = (v: number | null): string => (v === null ? "-" : `${Math.round(v * 100)}`);
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function countBy<T extends string>(values: readonly T[]): string {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k} ${n}`).join(" / ") || "なし";
}

function discrepancyLabel(d: Discrepancy): string {
  return `${d.category} 採用=${d.support.join("") || "なし"} 対立=${d.rivalSupport}${isUnresolved(d) ? " 未確定" : ""}`;
}

function segmentBlock(doc: ReferenceDocument, report: SegmentReport, meta: ReviewMeta): string {
  const s = doc.segments.find(x => x.id === report.id)!;
  const lines = [
    `### ${s.id} ${s1(s.startMs)}–${s1(s.endMs)} s ${s.speaker} ${s.kind}（下書き #${report.draftIndex}${report.splitPart !== null ? ` の分割 ${report.splitPart + 1}` : ""}）`,
    "",
    `- 本文: ${s.text}`,
    `- 理由: ${report.reasons.length > 0 ? report.reasons.join(" / ") : "（なし）"}`,
  ];
  for (const key of SOURCE_KEYS) {
    const span = report.spans[key];
    if (span === null) continue;
    lines.push(`- ${key} ${meta.sourceLabels[key]}（一致 ${pct(report.coverage[key])}%）: ${span.length > 0 ? span : "（対応なし）"}`);
  }
  if (report.diarizeSpeaker !== null && report.diarizeSpeaker !== s.speaker) lines.push(`- 話者: B では ${report.diarizeSpeaker}`);
  lines.push(`- facts: ${s.facts.length > 0 ? s.facts.map(f => `${f.type}「${f.text}」${f.note !== undefined ? `(${f.note})` : ""}`).join("、") : "なし"}`);
  if (report.droppedFacts.length > 0) lines.push(`- 本文に無いので捨てた facts: ${report.droppedFacts.join("、")}`);
  for (const d of report.discrepancies) lines.push(`- 食い違い: ${discrepancyLabel(d)} — ${d.detail}`);
  return lines.join("\n");
}

export function renderReview(result: BuildResult, stats: ReferenceStats, meta: ReviewMeta): string {
  const { doc, reports } = result;
  const trimmedStart = reports.filter(r => r.trimmedStartMs > 0).length;
  const trimmedEnd = reports.filter(r => r.trimmedEndMs > 0).length;
  const speakerMismatch = reports.filter(r => r.diarizeSpeaker !== null && r.diarizeSpeaker !== doc.segments.find(s => s.id === r.id)!.speaker);
  const durations = doc.segments.map(s => s.endMs - s.startMs);
  const out: string[] = [
    `# 正解原稿の見直し: ${doc.sourceId}（private）`,
    "",
    `- window: ${doc.windowStartSec}–${doc.windowEndSec} 秒（${stats.windowSec} 秒）`,
    `- 区間 ${stats.segments}（${Object.entries(stats.kinds).map(([k, n]) => `${k} ${n}`).join(" / ")}）・uncertain ${stats.uncertain}・カバー ${stats.coveredSec} 秒`,
    `- 区間長: 2 秒未満 ${durations.filter(d => d < 2000).length}・12 秒超 ${durations.filter(d => d > 12000).length}・最長 ${s1(Math.max(0, ...durations))} 秒`,
    `- facts: ${Object.entries(stats.facts).map(([k, n]) => `${k} ${n}`).join(" / ")}`,
    `- 時刻の決め方: ${countBy(reports.map(r => r.timing))}・無音で詰めた区間 先頭 ${trimmedStart} / 末尾 ${trimmedEnd}`,
    `- 整合性: ${countBy(result.issues.map(i => i.action))}`,
    `- 話者の対応（B→原稿）: ${Object.entries(result.speakerMap).map(([b, r]) => `${b}→${r}`).join(", ") || "なし"}・B と食い違う区間 ${speakerMismatch.length}`,
    ...meta.sourceSummary.map(line => `- ${line}`),
    `- 下書き: ${meta.draftLabel}${result.droppedDraft > 0 ? `（空の区間 ${result.droppedDraft} を除外）` : ""}`,
    "",
    `## uncertain 区間（${stats.uncertain}）`,
    "",
  ];
  for (const r of reports) {
    const s = doc.segments.find(x => x.id === r.id)!;
    if (s.uncertain !== true) continue;
    out.push(segmentBlock(doc, r, meta), "");
  }
  out.push("## 未収録の可能性（どの区間にも割り当たらなかった 6 文字以上の連続）", "");
  if (result.uncovered.length === 0) out.push("（なし）");
  for (const u of result.uncovered) {
    out.push(`- ${u.source}${u.startMs !== null ? ` ${s1(u.startMs)}–${s1(u.endMs ?? u.startMs)} s` : ""}（${u.chars} 文字）: ${u.text}`);
  }
  out.push("", "## LLM が記録した系統間の食い違い", "", "| id | 種別 | 採った読みの系統 | 対立する読みの系統数 | 確定 | 内容 |", "|---|---|---|---|---|---|");
  for (const r of reports) {
    for (const d of r.discrepancies) out.push(`| ${r.id} | ${d.category} | ${d.support.join("") || "なし"} | ${d.rivalSupport} | ${isUnresolved(d) ? "未確定" : "多数"} | ${cell(d.detail)} |`);
  }
  if (speakerMismatch.length > 0) {
    out.push("", "## 話者が B と食い違う区間", "");
    for (const r of speakerMismatch) {
      const s = doc.segments.find(x => x.id === r.id)!;
      out.push(`- ${s.id} ${s1(s.startMs)}–${s1(s.endMs)} s 原稿 ${s.speaker} / B ${r.diarizeSpeaker}: ${s.text}`);
    }
  }
  out.push("", "## 全区間", "", "| id | 下書き | 時刻 (s) | 話者 | kind | A | B | C | D | 時刻の決め方 | 本文 |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of reports) {
    const s = doc.segments.find(x => x.id === r.id)!;
    out.push(
      `| ${s.id}${s.uncertain === true ? " ⚠" : ""} | #${r.draftIndex}${r.splitPart !== null ? `.${r.splitPart + 1}` : ""} | ${s1(s.startMs)}–${s1(s.endMs)} | ${s.speaker} | ${s.kind} | ${pct(r.coverage.A)} | ${pct(r.coverage.B)} | ${pct(r.coverage.C)} | ${pct(r.coverage.D)} | ${r.timing} | ${cell(s.text)} |`,
    );
  }
  out.push("", "## 整合性チェック", "");
  if (result.issues.length === 0) out.push("（なし）");
  for (const issue of result.issues) out.push(`- ${issue.id} ${issue.code} → ${issue.action}${issue.detail !== undefined ? `（${issue.detail}）` : ""}`);
  return `${out.join("\n")}\n`;
}
