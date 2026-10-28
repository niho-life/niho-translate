/** 正解原稿の件数統計（本文を含まない。stdout・公開レポートへ出してよい）。 */
import type { FactType, ReferenceDocument, ReferenceSegment } from "../engine.ts";
import { FACT_TYPES, SEGMENT_KINDS } from "./validate.ts";

export interface ReferenceStats {
  readonly sourceId: string;
  readonly windowSec: number;
  readonly segments: number;
  readonly kinds: Readonly<Record<ReferenceSegment["kind"], number>>;
  readonly facts: Readonly<Record<FactType, number>>;
  readonly uncertain: number;
  /** 区間の和集合の長さ（秒、0.1 秒単位）。 */
  readonly coveredSec: number;
}

/** 区間 [startMs, endMs) の和集合の長さ。 */
export function unionMs(segments: ReadonlyArray<Pick<ReferenceSegment, "startMs" | "endMs">>): number {
  const sorted = segments.map(s => [s.startMs, s.endMs] as const).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const [a, b] of sorted) {
    if (Number.isNaN(curStart) || a > curEnd) {
      if (!Number.isNaN(curStart)) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else {
      curEnd = Math.max(curEnd, b);
    }
  }
  if (!Number.isNaN(curStart)) total += curEnd - curStart;
  return total;
}

export function referenceStats(doc: ReferenceDocument): ReferenceStats {
  const kinds = Object.fromEntries(SEGMENT_KINDS.map(k => [k, 0])) as Record<ReferenceSegment["kind"], number>;
  const facts = Object.fromEntries(FACT_TYPES.map(t => [t, 0])) as Record<FactType, number>;
  for (const s of doc.segments) {
    kinds[s.kind] += 1;
    for (const f of s.facts) facts[f.type] += 1;
  }
  return {
    sourceId: doc.sourceId,
    windowSec: Math.round((doc.windowEndSec - doc.windowStartSec) * 10) / 10,
    segments: doc.segments.length,
    kinds,
    facts,
    uncertain: doc.segments.filter(s => s.uncertain === true).length,
    coveredSec: Math.round(unionMs(doc.segments) / 100) / 10,
  };
}
