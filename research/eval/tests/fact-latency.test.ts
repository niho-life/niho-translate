import { describe, expect, it } from "vitest";
import type { ReferenceDocument } from "../src/engine.ts";
import { measureFacts, summarizeFacts } from "../src/fact-latency.ts";

const reference: ReferenceDocument = {
  sourceId: "synthetic", language: "ja", windowStartSec: 0, windowEndSec: 10,
  provenance: { asr: "synthetic", proofread: "synthetic" },
  segments: [{ id: "s001", startMs: 0, endMs: 3_000, speaker: "a", kind: "statement", text: "5年で終わりません", facts: [
    { type: "time", text: "5年" }, { type: "negation", text: "ません" },
  ] }],
};
const source = [
  { text: "5年", startMs: 500, endMs: 1_000 },
  { text: "で", startMs: 1_000, endMs: 1_300 },
  { text: "終わりません", startMs: 1_300, endMs: 2_700 },
];
const target = [
  { text: "five", startMs: 2_000, endMs: 2_300 },
  { text: "years", startMs: 2_300, endMs: 2_700 },
  { text: "ended", startMs: 4_000, endMs: 4_500 },
];

describe("fact latency", () => {
  it("times only correctly rendered facts from source fact completion to target fact onset", () => {
    const result = measureFacts(reference, source, target, [
      { segmentId: "s001", factIndex: 0, sourceWordLo: 0, sourceWordHi: 0, targetWordLo: 0, targetWordHi: 1, verdict: "ok", review: "asr-reviewed" },
      { segmentId: "s001", factIndex: 1, sourceWordLo: 2, sourceWordHi: 2, targetWordLo: 2, targetWordHi: 2, verdict: "wrong", review: "asr-reviewed" },
    ]);
    expect(result[0]?.lFactMs).toBe(1_000);
    expect(result[0]?.lFactOnsetMs).toBe(1_500);
    expect(result[1]?.lFactMs).toBeNull();
    expect(summarizeFacts(result)).toMatchObject({ total: 2, correctTimed: 1, preSourceEnd: 0, wrong: 1, lFactP50Ms: 1_000 });
  });

  it("counts a fact spoken before its source completion even when the wording is correct", () => {
    const result = measureFacts(reference, source, [{ text: "not", startMs: 2_000, endMs: 2_300 }], [
      { segmentId: "s001", factIndex: 1, sourceWordLo: 2, sourceWordHi: 2, targetWordLo: 0, targetWordHi: 0, verdict: "ok", review: "asr-reviewed" },
    ]);
    expect(result[0]?.lFactMs).toBe(-700);
    expect(summarizeFacts(result)).toMatchObject({ correctTimed: 1, preSourceEnd: 1 });
  });

  it("rejects a fact anchor outside its source meaning unit", () => {
    expect(() => measureFacts(reference, [{ text: "5年", startMs: 10_000, endMs: 10_500 }], target, [
      { segmentId: "s001", factIndex: 0, sourceWordLo: 0, sourceWordHi: 0, targetWordLo: 0, targetWordHi: 1, verdict: "ok", review: "asr-reviewed" },
    ])).toThrow("outside segment");
  });
});
