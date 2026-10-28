import { describe, expect, it } from "vitest";
import type { JudgeDocument, JudgedSegment } from "../src/engine.ts";
import { compareJudgements } from "../src/judge/compare.ts";
import { computeAggregate } from "../src/judge/metrics.ts";

function seg(id: string, meaning: 0 | 1 | 2 | 3, enStartMs: number | null, over: Partial<JudgedSegment> = {}): JudgedSegment {
  return {
    id,
    kind: "statement",
    aligned: enStartMs !== null,
    enStartMs,
    enEndMs: enStartMs === null ? null : enStartMs + 2_000,
    enText: null,
    lStartMs: enStartMs === null ? null : enStartMs - 1_000,
    lEndMs: null,
    lTailMs: null,
    meaning,
    facts: [],
    flags: enStartMs === null ? ["omission"] : [],
    note: "",
    ...over,
  };
}

function doc(model: string, segments: JudgedSegment[]): JudgeDocument {
  return { runId: "r", sourceId: "s", engineId: "e", judge: { model, promptVersion: "v1", asr: "whisper-1" }, segments, aggregate: computeAggregate(segments) };
}

describe("compareJudgements", () => {
  const a = doc("gpt-5.4", [
    seg("s1", 3, 4_000, { facts: [{ text: "2年半", type: "number", verdict: "wrong" }] }),
    seg("s2", 2, 9_000),
    seg("s3", 0, null),
    seg("s4", 3, 15_000, { flags: ["repeat"] }),
  ]);
  const b = doc("agy:claude-opus-4-6-thinking", [
    seg("s1", 1, 4_000, { facts: [{ text: "2年半", type: "number", verdict: "wrong" }] }),
    seg("s2", 2, 9_400),
    seg("s3", 1, 13_000, { flags: ["hallucination"] }),
    seg("s4", 3, 15_000),
    seg("s9", 3, 20_000),
  ]);

  it("counts per-segment agreement of meaning, alignment and the start word", () => {
    const c = compareJudgements(a, b);
    expect(c).toMatchObject({
      modelA: "gpt-5.4",
      modelB: "agy:claude-opus-4-6-thinking",
      n: 4,
      meaningSame: 2, // s2, s4
      meaningWithin1: 3, // s3 (0 vs 1) also
      alignedA: 3,
      alignedB: 5,
      alignedDisagree: 1, // s3
      bothAligned: 3,
      sameEnStart: 2,
      maxEnStartDiffMs: 400,
      criticalFactErrorsA: 1,
      criticalFactErrorsB: 1,
      factSame: 1,
      factTotal: 1,
    });
    // B − A: omission 1 → 0, repeat 1 → 0, hallucination 0 → 1
    expect(c.flagDiff).toEqual({ omission: -1, hallucination: 1, repeat: -1 });
    expect(c.meaningMeanA).toBe(2);
    expect(c.meaningMeanB).toBe(2);
    expect(c.meaningMeanDiff).toBe(0);
  });
});
