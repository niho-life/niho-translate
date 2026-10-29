import { describe, expect, it } from "vitest";
import { CRITICAL_FACT_TYPES, type JudgedSegment, type ReferenceSegment } from "../src/engine.ts";
import { computeAggregate, isCriticalFactError, latencyStats, minuteDiagnostics, nearestRank, resolveSegment } from "../src/judge/metrics.ts";
import type { OutputWord, RawSegmentJudgement } from "../src/judge/types.ts";

const words: OutputWord[] = [
  ["Well,", 2_000, 2_300],
  ["Tomorrow's", 3_050, 3_500],
  ["viewing", 3_500, 3_900],
  ["is", 3_900, 4_000],
  ["off", 4_000, 4_300],
  ["if", 4_300, 4_400],
  ["it", 4_400, 4_500],
  ["rains.", 4_500, 5_100],
].map(([text, startMs, endMs], i) => ({ i, text: text as string, startMs: startMs as number, endMs: endMs as number }));

function ref(id: string, kind: ReferenceSegment["kind"], startMs: number, endMs: number, facts: ReferenceSegment["facts"] = []): ReferenceSegment {
  return { id, kind, startMs, endMs, speaker: "A", text: "合成の原文", facts };
}

function raw(id: string, over: Partial<RawSegmentJudgement> = {}): RawSegmentJudgement {
  return { id, aligned: true, enStartWordIdx: 1, enEndWordIdx: 7, meaning: 3, facts: [], flags: [], note: "ok", ...over };
}

function judged(id: string, kind: JudgedSegment["kind"], lStartMs: number | null, over: Partial<JudgedSegment> = {}): JudgedSegment {
  return {
    id,
    kind,
    aligned: lStartMs !== null,
    enStartMs: null,
    enEndMs: null,
    enText: null,
    lStartMs,
    lEndMs: lStartMs === null ? null : lStartMs - 4_000,
    lTailMs: lStartMs === null ? null : lStartMs - 1_000,
    meaning: lStartMs === null ? 0 : 3,
    facts: [],
    flags: lStartMs === null && (kind === "statement" || kind === "question") ? ["omission"] : [],
    note: "",
    ...over,
  };
}

describe("nearestRank", () => {
  it("uses the ceil(p/100 * n)-th smallest value", () => {
    const values = Array.from({ length: 20 }, (_, k) => 20 - k); // 20..1, unsorted on purpose
    expect(nearestRank(values, 50)).toBe(10);
    expect(nearestRank(values, 95)).toBe(19);
    expect(nearestRank([7], 50)).toBe(7);
    expect(nearestRank([7], 95)).toBe(7);
    expect(nearestRank([1, 2, 3], 50)).toBe(2);
    expect(nearestRank([1, 2, 3], 95)).toBe(3);
    expect(nearestRank([], 50)).toBeNull();
  });
});

describe("minuteDiagnostics", () => {
  it("groups by source onset and retains omitted segments in the 8-second denominator", () => {
    const references = [
      ref("a", "statement", 0, 3_000),
      ref("b", "question", 59_900, 62_000),
      ref("c", "statement", 60_000, 64_000),
      ref("d", "statement", 61_000, 65_000, [{ type: "negation", text: "しません" }]),
      ref("e", "backchannel", 62_000, 62_300),
    ];
    const output = [
      judged("a", "statement", 4_000),
      judged("b", "question", 9_000, { meaning: 2 }),
      judged("c", "statement", 6_000),
      judged("d", "statement", null, { facts: [{ type: "negation", text: "しません", verdict: "wrong" }] }),
      judged("e", "backchannel", 1_000),
    ];
    expect(minuteDiagnostics(references, output)).toEqual([
      { minute: 1, scored: 2, missing: 0, lStart: { n: 2, p50: 4_000, p95: 9_000, max: 9_000, within5s: 0.5, within8s: 0.5 }, meaningMean: 2.5, criticalFactErrors: 0 },
      { minute: 2, scored: 2, missing: 1, lStart: { n: 1, p50: 6_000, p95: 6_000, max: 6_000, within5s: 0, within8s: 0.5 }, meaningMean: 1.5, criticalFactErrors: 1 },
    ]);
  });
});

describe("resolveSegment", () => {
  const seg = ref("s1", "statement", 0, 4_000, [
    { type: "time", text: "明日" },
    { type: "condition", text: "雨の場合" },
    { type: "negation", text: "しません" },
  ]);

  it("maps word indices to ms and computes lStart / lEnd / lTail", () => {
    const out = resolveSegment(
      seg,
      raw("s1", { facts: [{ index: 0, verdict: "ok" }, { index: 2, verdict: "wrong" }] }),
      words,
    );
    expect(out).toMatchObject({
      aligned: true,
      enStartMs: 3_050,
      enEndMs: 5_100,
      enText: "Tomorrow's viewing is off if it rains.",
      lStartMs: 3_050,
      lEndMs: -950,
      lTailMs: 1_100,
      meaning: 3,
    });
    expect(out.facts.map((f) => f.verdict)).toEqual(["ok", "unclear", "wrong"]);
  });

  it("swaps reversed indices and fills a missing end from the start", () => {
    expect(resolveSegment(seg, raw("s1", { enStartWordIdx: 4, enEndWordIdx: 2 }), words)).toMatchObject({ enStartMs: 3_500, enEndMs: 4_300 });
    expect(resolveSegment(seg, raw("s1", { enStartWordIdx: 3, enEndWordIdx: null }), words)).toMatchObject({ enStartMs: 3_900, enEndMs: 4_000 });
  });

  it("treats an unaligned or invalid answer as a miss: meaning 0, null latency, facts omitted, omission flag", () => {
    for (const r of [raw("s1", { aligned: false, enStartWordIdx: null, enEndWordIdx: null, meaning: 2 }), raw("s1", { enStartWordIdx: 99, enEndWordIdx: 100 }), undefined]) {
      const out = resolveSegment(seg, r, words);
      expect(out).toMatchObject({ aligned: false, enStartMs: null, lStartMs: null, lEndMs: null, lTailMs: null, meaning: 0, flags: ["omission"] });
      expect(out.facts.every((f) => f.verdict === "omitted")).toBe(true);
    }
  });

  it("does not flag omission for backchannel or fragment segments", () => {
    const out = resolveSegment(ref("b1", "backchannel", 5_000, 5_400), raw("b1", { aligned: false, enStartWordIdx: null, enEndWordIdx: null, flags: ["omission"] }), words);
    expect(out.flags).toEqual([]);
  });
});

describe("aggregate", () => {
  const segments: JudgedSegment[] = [
    judged("s1", "statement", 3_000),
    judged("s2", "statement", 4_800, {
      meaning: 1,
      facts: [
        { text: "2年半", type: "number", verdict: "wrong" },
        { text: "カナダ", type: "proper_noun", verdict: "wrong" },
        { text: "住んでいました", type: "tense", verdict: "ok" },
      ],
    }),
    judged("s3", "question", 7_900, { facts: [{ text: "しません", type: "negation", verdict: "omitted" }] }),
    judged("s4", "statement", null, { facts: [{ text: "12分", type: "number", verdict: "omitted" }] }),
    judged("s5", "statement", 12_000, { meaning: 2, flags: ["repeat"], facts: [{ text: "鎌倉", type: "place", verdict: "wrong" }] }),
    judged("b1", "backchannel", 900, { flags: ["hallucination"] }),
    judged("f1", "fragment", 6_000),
  ];

  it("excludes backchannel from latency stats and keeps misses in the within denominators", () => {
    const stats = latencyStats(segments, (s) => s.lStartMs);
    // values: 3000, 4800, 7900, 12000 (statement/question) + 6000 (fragment); backchannel 900 excluded
    expect(stats.n).toBe(5);
    expect(stats.p50).toBe(6_000);
    expect(stats.p95).toBe(12_000);
    expect(stats.max).toBe(12_000);
    // denominator: 5 statement/question (s4 unaligned counts as not within)
    expect(stats.within5s).toBe(0.4);
    expect(stats.within8s).toBe(0.6);
  });

  it("computes meaning, facts, critical errors and flags", () => {
    const agg = computeAggregate(segments);
    expect(agg.n).toBe(7);
    expect(agg.nScored).toBe(5);
    expect(agg.nAligned).toBe(4);
    expect(agg.meaningMean).toBe(1.8); // (3 + 1 + 3 + 0 + 2) / 5
    expect(agg.meaningDist).toEqual({ "0": 1, "1": 1, "2": 1, "3": 2 });
    expect(agg.factTotals).toEqual({ ok: 1, wrong: 3, omitted: 2, unclear: 0 });
    // number と place の wrong は重大、proper_noun の wrong は重大ではない
    expect(agg.criticalFactErrors).toBe(2);
    expect(agg.factErrorsByType).toEqual({ number: 1, place: 1, proper_noun: 1 });
    expect(Object.keys(agg.factErrorsByType ?? {})).toEqual(["number", "place", "proper_noun"]);
    expect(agg.flagCounts).toEqual({ omission: 1, repeat: 1, hallucination: 1 });
    expect(agg.lStart.n).toBe(5);
  });

  it("returns empty stats for no segments", () => {
    const agg = computeAggregate([]);
    expect(agg.lStart).toEqual({ n: 0, p50: null, p95: null, max: null, within5s: null, within8s: null });
    expect(agg.meaningMean).toBeNull();
    expect(agg.factErrorsByType).toEqual({});
  });

  it("counts only the contract's critical fact types (including place) as critical", () => {
    expect([...CRITICAL_FACT_TYPES].sort()).toEqual(["amount", "condition", "negation", "number", "place", "subject", "tense", "time"]);
    for (const type of CRITICAL_FACT_TYPES) {
      expect(isCriticalFactError({ type, verdict: "wrong" })).toBe(true);
      expect(isCriticalFactError({ type, verdict: "omitted" })).toBe(false);
    }
    expect(isCriticalFactError({ type: "proper_noun", verdict: "wrong" })).toBe(false);
    expect(isCriticalFactError({ type: "tense", verdict: "wrong" })).toBe(true);
  });
});
