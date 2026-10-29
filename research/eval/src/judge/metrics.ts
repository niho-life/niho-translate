/**
 * 判定結果から遅延と意味の指標を計算する純関数。
 * 時刻は LLM に出させず、LLM が選んだ語 index から output-words.json の ms を引く。
 */
import {
  CRITICAL_FACT_TYPES,
  type FactType,
  type FactVerdict,
  type JudgeAggregate,
  type JudgedSegment,
  type JudgeFlag,
  type LatencyStats,
  type ReferenceSegment,
} from "../engine.ts";
import type { OutputWord, RawSegmentJudgement } from "./types.ts";

const CRITICAL: ReadonlySet<FactType> = new Set<FactType>(CRITICAL_FACT_TYPES);
/** factErrorsByType のキー順（重大な型を先に）。未知の型は後ろに付く。 */
const FACT_TYPE_ORDER: ReadonlyArray<FactType> = [...CRITICAL_FACT_TYPES, "proper_noun", "tense"];
export const JUDGE_FLAGS: ReadonlyArray<JudgeFlag> = [
  "omission",
  "hallucination",
  "answered_question",
  "repeat",
  "wrong_language",
  "garbled",
];
export const FACT_VERDICTS: ReadonlyArray<FactVerdict> = ["ok", "wrong", "omitted", "unclear"];
export const WITHIN_5S_MS = 5_000;
export const WITHIN_8S_MS = 8_000;

type Kind = ReferenceSegment["kind"];

/** 意味・事実・within の分母に入る区間（statement / question）。 */
export function isScoredKind(kind: Kind): boolean {
  return kind === "statement" || kind === "question";
}

/** 遅延統計に入る区間（backchannel 以外）。 */
export function isLatencyKind(kind: Kind): boolean {
  return kind !== "backchannel";
}

/** 最近傍順位法: 昇順で ceil(p/100 * n) 番目（1 始まり）。空なら null。 */
export function nearestRank(values: ReadonlyArray<number>, p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

function normalizeFlags(flags: ReadonlyArray<JudgeFlag>, kind: Kind, aligned: boolean): JudgeFlag[] {
  const set = new Set(flags.filter((f) => JUDGE_FLAGS.includes(f)));
  if (!isScoredKind(kind)) set.delete("omission"); // 相づち・断片は訳さなくてよい
  else if (!aligned) set.add("omission");
  return JUDGE_FLAGS.filter((f) => set.has(f));
}

function joinNote(...parts: ReadonlyArray<string>): string {
  return parts.map((p) => p.trim()).filter(Boolean).join(" ");
}

/**
 * LLM の判定（語 index）を JudgedSegment にする。index が不正なら未対応として扱う。
 * aligned=false は meaning 0・遅延 null・facts は omitted。
 */
export function resolveSegment(
  ref: ReferenceSegment,
  raw: RawSegmentJudgement | undefined,
  words: ReadonlyArray<OutputWord>,
): JudgedSegment {
  const base = { id: ref.id, kind: ref.kind };
  let note = raw?.note ?? "判定なし";
  let start = raw?.enStartWordIdx ?? null;
  let end = raw?.enEndWordIdx ?? null;
  let aligned = raw?.aligned ?? false;
  if (aligned) {
    if (start === null) start = end;
    if (end === null) end = start;
    if (start !== null && end !== null && start > end) [start, end] = [end, start];
    const valid = (i: number | null): i is number => i !== null && Number.isInteger(i) && i >= 0 && i < words.length;
    if (!valid(start) || !valid(end)) {
      aligned = false;
      note = joinNote(note, "（判定器の語 index が不正のため未対応として扱った）");
    }
  }
  const flags = normalizeFlags(raw?.flags ?? [], ref.kind, aligned);
  if (!aligned || start === null || end === null) {
    return {
      ...base,
      aligned: false,
      enStartMs: null,
      enEndMs: null,
      enText: null,
      lStartMs: null,
      lEndMs: null,
      lTailMs: null,
      meaning: 0,
      facts: ref.facts.map((f) => ({ text: f.text, type: f.type, verdict: "omitted" as const })),
      flags,
      note,
    };
  }
  const first = words[start] as OutputWord;
  const last = words[end] as OutputWord;
  const enStartMs = first.startMs;
  const enEndMs = Math.max(last.endMs, enStartMs);
  const verdictOf = (index: number): FactVerdict => raw?.facts.find((f) => f.index === index)?.verdict ?? "unclear";
  const meaning = Math.min(3, Math.max(0, Math.round(raw?.meaning ?? 0))) as 0 | 1 | 2 | 3;
  return {
    ...base,
    aligned: true,
    enStartMs,
    enEndMs,
    enText: words.slice(start, end + 1).map((w) => w.text).join(" "),
    lStartMs: enStartMs - ref.startMs,
    lEndMs: enStartMs - ref.endMs,
    lTailMs: enEndMs - ref.endMs,
    meaning,
    facts: ref.facts.map((f, index) => ({ text: f.text, type: f.type, verdict: verdictOf(index) })),
    flags,
    note,
  };
}

function round(value: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

/**
 * 遅延統計。p50/p95/max は backchannel 以外で訳が対応した区間の値。
 * within5s/within8s は statement/question の全件（未対応を含む）を分母にした割合。
 */
export function latencyStats(segments: ReadonlyArray<JudgedSegment>, pick: (s: JudgedSegment) => number | null): LatencyStats {
  const values = segments
    .filter((s) => isLatencyKind(s.kind))
    .map(pick)
    .filter((v): v is number => v !== null);
  const scored = segments.filter((s) => isScoredKind(s.kind));
  const within = (limit: number): number | null => {
    if (scored.length === 0) return null;
    const hit = scored.filter((s) => {
      const v = pick(s);
      return v !== null && v <= limit;
    }).length;
    return round(hit / scored.length, 4);
  };
  return {
    n: values.length,
    p50: nearestRank(values, 50),
    p95: nearestRank(values, 95),
    max: values.length > 0 ? Math.max(...values) : null,
    within5s: within(WITHIN_5S_MS),
    within8s: within(WITHIN_8S_MS),
  };
}

/** engine.ts の CRITICAL_FACT_TYPES（地名 place を含み、proper_noun・tense は含まない）の wrong。 */
export function isCriticalFactError(fact: { readonly type: FactType; readonly verdict: FactVerdict }): boolean {
  return fact.verdict === "wrong" && CRITICAL.has(fact.type);
}

function orderByFactType(counts: ReadonlyMap<FactType, number>): Partial<Record<FactType, number>> {
  const rank = (t: FactType): number => {
    const k = FACT_TYPE_ORDER.indexOf(t);
    return k < 0 ? FACT_TYPE_ORDER.length : k;
  };
  const out: Partial<Record<FactType, number>> = {};
  for (const t of [...counts.keys()].sort((a, b) => rank(a) - rank(b))) out[t] = counts.get(t) ?? 0;
  return out;
}

/**
 * 集計。n は全区間、nScored/nAligned/meaning/facts（factErrorsByType を含む）は statement/question、
 * flags は全区間（相づち・断片の omission は normalize で除外済み）。
 */
export function computeAggregate(segments: ReadonlyArray<JudgedSegment>): JudgeAggregate {
  const scored = segments.filter((s) => isScoredKind(s.kind));
  const meaningDist: Record<"0" | "1" | "2" | "3", number> = { "0": 0, "1": 0, "2": 0, "3": 0 };
  for (const s of scored) meaningDist[String(s.meaning) as "0" | "1" | "2" | "3"] += 1;
  const factTotals: Record<FactVerdict, number> = { ok: 0, wrong: 0, omitted: 0, unclear: 0 };
  let criticalFactErrors = 0;
  const wrongByType = new Map<FactType, number>();
  for (const s of scored) {
    for (const f of s.facts) {
      factTotals[f.verdict] += 1;
      if (isCriticalFactError(f)) criticalFactErrors += 1;
      if (f.verdict === "wrong") wrongByType.set(f.type, (wrongByType.get(f.type) ?? 0) + 1);
    }
  }
  const flagCounts: Partial<Record<JudgeFlag, number>> = {};
  for (const s of segments) for (const f of s.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  return {
    n: segments.length,
    nScored: scored.length,
    nAligned: scored.filter((s) => s.aligned).length,
    lStart: latencyStats(segments, (s) => s.lStartMs),
    lEnd: latencyStats(segments, (s) => s.lEndMs),
    lTail: latencyStats(segments, (s) => s.lTailMs),
    meaningMean: scored.length > 0 ? round(scored.reduce((sum, s) => sum + s.meaning, 0) / scored.length, 3) : null,
    meaningDist,
    factTotals,
    criticalFactErrors,
    factErrorsByType: orderByFactType(wrongByType),
    flagCounts,
  };
}

/** 原文の開始時刻で1分帯に分ける。未対応も分母に残し、長時間runの遅延蓄積を見せる。 */
export function minuteDiagnostics(
  reference: ReadonlyArray<ReferenceSegment>,
  judged: ReadonlyArray<JudgedSegment>,
): ReadonlyArray<{ minute: number; scored: number; missing: number; lStart: LatencyStats; meaningMean: number | null; criticalFactErrors: number }> {
  const byId = new Map(judged.map((s) => [s.id, s]));
  const groups = new Map<number, JudgedSegment[]>();
  for (const ref of reference) {
    if (!isScoredKind(ref.kind)) continue;
    const minute = Math.floor(ref.startMs / 60_000) + 1;
    const group = groups.get(minute) ?? [];
    const result = byId.get(ref.id);
    // Missing judge output is a missed translation, never a fast or correct one.
    group.push(result ?? {
      id: ref.id, kind: ref.kind, aligned: false, enStartMs: null, enEndMs: null,
      enText: null, lStartMs: null, lEndMs: null, lTailMs: null, meaning: 0,
      facts: ref.facts.map((f) => ({ ...f, verdict: "omitted" as const })),
      flags: ["omission"], note: "判定なし",
    });
    groups.set(minute, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([minute, group]) => ({
    minute,
    scored: group.length,
    missing: group.filter((s) => !s.aligned).length,
    lStart: latencyStats(group, (s) => s.lStartMs),
    meaningMean: round(group.reduce((sum, s) => sum + s.meaning, 0) / group.length, 3),
    criticalFactErrors: group.flatMap((s) => s.facts).filter(isCriticalFactError).length,
  }));
}
