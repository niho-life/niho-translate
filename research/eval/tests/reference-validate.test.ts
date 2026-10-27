import { describe, expect, it } from "vitest";
import type { ReferenceDocument, ReferenceSegment } from "../src/engine.ts";
import { referenceStats, unionMs } from "../src/reference/stats.ts";
import { checkReference, formatSegmentId, repairReference } from "../src/reference/validate.ts";

function seg(partial: Partial<ReferenceSegment> & Pick<ReferenceSegment, "startMs" | "endMs">): ReferenceSegment {
  return { id: "s000", speaker: "話者0", text: "駅から歩いて10分です。", kind: "statement", facts: [], ...partial };
}

function doc(segments: ReferenceSegment[], windowSec = 60): ReferenceDocument {
  return {
    sourceId: "synthetic",
    language: "ja",
    windowStartSec: 100,
    windowEndSec: 100 + windowSec,
    segments: segments.map((s, i) => (s.id === "s000" ? { ...s, id: formatSegmentId(i + 1) } : s)),
    provenance: { asr: "synthetic", proofread: "synthetic" },
  };
}

/** 修正後は、残る違反がすべて uncertain による許容になっている。 */
function expectClean(d: ReferenceDocument): void {
  expect(checkReference(d).filter(v => !v.tolerated)).toEqual([]);
}

describe("reference integrity check", () => {
  it("accepts a consistent document as is", () => {
    const d = doc([seg({ startMs: 0, endMs: 3000 }), seg({ startMs: 3200, endMs: 6000, speaker: "話者1", kind: "question", text: "家賃はいくらですか？" })]);
    expect(checkReference(d)).toEqual([]);
    const repaired = repairReference(d);
    expect(repaired.issues).toEqual([]);
    expect(repaired.doc).toEqual(d);
  });

  it("renumbers ids as s001, s002, …", () => {
    const d = doc([seg({ id: "x", startMs: 0, endMs: 1000 }), seg({ id: "s007", startMs: 1000, endMs: 2000 })]);
    expect(checkReference(d).map(v => v.code)).toEqual(["id_sequence", "id_sequence"]);
    const { doc: fixed, issues } = repairReference(d);
    expect(fixed.segments.map(s => s.id)).toEqual(["s001", "s002"]);
    expect(issues.every(i => i.code === "id_sequence" && i.action === "fixed")).toBe(true);
    expectClean(fixed);
  });

  it("clamps times into the window and rounds to integer ms", () => {
    const d = doc([seg({ startMs: -120.4, endMs: 2000.6 }), seg({ startMs: 58_000, endMs: 61_000 })]);
    const { doc: fixed } = repairReference(d);
    expect(fixed.segments.map(s => [s.startMs, s.endMs])).toEqual([[0, 2001], [58_000, 60_000]]);
    expectClean(fixed);
  });

  it("repairs non-positive durations and non-monotonic starts and marks them uncertain", () => {
    const d = doc([seg({ startMs: 5000, endMs: 5000 }), seg({ startMs: 4000, endMs: 8000 })]);
    expect(checkReference(d).map(v => v.code)).toEqual(expect.arrayContaining(["non_positive_duration", "non_monotonic_start"]));
    const { doc: fixed, issues } = repairReference(d);
    expect(fixed.segments[0]).toMatchObject({ startMs: 5000, endMs: 5200, uncertain: true });
    expect(fixed.segments[1]).toMatchObject({ startMs: 5000, endMs: 8000, uncertain: true });
    expect(issues.map(i => i.code)).toEqual(expect.arrayContaining(["non_positive_duration", "non_monotonic_start"]));
    expectClean(fixed);
  });

  it("allows overlaps up to 300 ms", () => {
    const d = doc([seg({ startMs: 0, endMs: 3300 }), seg({ startMs: 3000, endMs: 5000 })]);
    expect(checkReference(d)).toEqual([]);
  });

  it("trims the earlier segment when the same speaker overlaps by more than 300 ms", () => {
    const d = doc([seg({ startMs: 0, endMs: 4000 }), seg({ startMs: 3000, endMs: 6000 })]);
    expect(checkReference(d).map(v => v.code)).toEqual(["overlap"]);
    const { doc: fixed, issues } = repairReference(d);
    expect(fixed.segments.map(s => [s.startMs, s.endMs])).toEqual([[0, 3000], [3000, 6000]]);
    expect(fixed.segments.some(s => s.uncertain === true)).toBe(false);
    expect(issues).toEqual([{ id: "s001", code: "overlap", action: "fixed", detail: "end trimmed to next s002" }]);
    expectClean(fixed);
  });

  it("keeps a real cross-talk overlap but marks the backchannel uncertain", () => {
    const d = doc([
      seg({ startMs: 0, endMs: 8000 }),
      seg({ startMs: 5000, endMs: 5400, speaker: "話者1", text: "はい", kind: "backchannel" }),
      seg({ startMs: 8100, endMs: 10_000 }),
    ]);
    const { doc: fixed } = repairReference(d);
    expect(fixed.segments.map(s => [s.startMs, s.endMs])).toEqual([[0, 8000], [5000, 5400], [8100, 10_000]]);
    expect(fixed.segments.map(s => s.uncertain === true)).toEqual([false, true, false]);
    expectClean(fixed);
  });

  it("marks segments longer than 15 s uncertain", () => {
    const d = doc([seg({ startMs: 0, endMs: 15_001 }), seg({ startMs: 15_001, endMs: 30_000 })]);
    const { doc: fixed, issues } = repairReference(d);
    expect(fixed.segments.map(s => s.uncertain === true)).toEqual([true, false]);
    expect(issues).toEqual([{ id: "s001", code: "too_long", action: "uncertain" }]);
    expectClean(fixed);
  });

  it("requires 2 characters except for backchannels", () => {
    const d = doc([
      seg({ startMs: 0, endMs: 400, text: "え？", kind: "question" }),
      seg({ startMs: 500, endMs: 900, text: "猫。", kind: "fragment" }),
      seg({ startMs: 1000, endMs: 1300, text: "うん", kind: "backchannel" }),
      seg({ startMs: 1400, endMs: 1600, text: "ん", kind: "backchannel" }),
    ]);
    expect(checkReference(d).map(v => [v.id, v.code])).toEqual([["s001", "too_short_text"], ["s002", "too_short_text"]]);
    const { doc: fixed } = repairReference(d);
    expect(fixed.segments.map(s => [s.kind, s.uncertain === true])).toEqual([["backchannel", false], ["fragment", true], ["backchannel", false], ["backchannel", false]]);
    expectClean(fixed);
  });

  it("drops segments without visible text and renumbers the rest", () => {
    const d = doc([seg({ startMs: 0, endMs: 1000, text: "、。" }), seg({ startMs: 1000, endMs: 2000 })]);
    const { doc: fixed, issues } = repairReference(d);
    expect(fixed.segments).toHaveLength(1);
    expect(fixed.segments[0]!.id).toBe("s001");
    expect(issues[0]).toEqual({ id: "s001", code: "empty_text", action: "dropped" });
    expectClean(fixed);
  });

  it("drops facts with empty text", () => {
    const d = doc([seg({ startMs: 0, endMs: 1000, facts: [{ type: "number", text: "10分" }, { type: "time", text: " " }] })]);
    const { doc: fixed } = repairReference(d);
    expect(fixed.segments[0]!.facts).toEqual([{ type: "number", text: "10分" }]);
    expectClean(fixed);
  });
});

describe("reference stats", () => {
  it("counts kinds, facts and uncertain segments and the covered union", () => {
    const d = doc([
      seg({ startMs: 0, endMs: 3000, facts: [{ type: "time", text: "10分" }, { type: "place", text: "駅" }] }),
      seg({ startMs: 2800, endMs: 3200, speaker: "話者1", text: "はい", kind: "backchannel", uncertain: true }),
      seg({ startMs: 5000, endMs: 7000, speaker: "話者1", text: "家賃はいくらですか？", kind: "question" }),
    ]);
    expect(unionMs(d.segments)).toBe(5200);
    expect(referenceStats(d)).toEqual({
      sourceId: "synthetic",
      windowSec: 60,
      segments: 3,
      kinds: { statement: 1, question: 1, backchannel: 1, fragment: 0 },
      facts: { number: 0, time: 1, amount: 0, negation: 0, place: 1, proper_noun: 0, condition: 0, subject: 0, tense: 0 },
      uncertain: 1,
      coveredSec: 5.2,
    });
  });
});
