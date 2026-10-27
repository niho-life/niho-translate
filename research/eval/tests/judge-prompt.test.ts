import { describe, expect, it } from "vitest";
import type { ReferenceSegment } from "../src/engine.ts";
import {
  buildBatchInput,
  judgeInstructions,
  planBatches,
  responseSchema,
  validateBatchResponse,
} from "../src/judge/prompt.ts";
import { groupSentences } from "../src/judge/sentences.ts";
import type { OutputWord } from "../src/judge/types.ts";

function seg(k: number): ReferenceSegment {
  return {
    id: `s${k}`,
    kind: "statement",
    startMs: k * 5_000,
    endMs: k * 5_000 + 4_000,
    speaker: "A",
    text: `合成の原文${k}`,
    facts: [{ type: "number", text: `${k}件` }],
  };
}

const segments = Array.from({ length: 10 }, (_, k) => seg(k));
// one English word every 500 ms from 1 s to 80 s
const words: OutputWord[] = Array.from({ length: 159 }, (_, i) => ({
  i,
  text: i % 6 === 5 ? `w${i}.` : `w${i}`,
  startMs: 1_000 + i * 500,
  endMs: 1_000 + i * 500 + 400,
}));

describe("planBatches", () => {
  it("splits into batches with 3 context segments and a −2 s / +25 s word window", () => {
    const plans = planBatches(segments, words, { batchSize: 4 });
    expect(plans.map((p) => p.targets.map((s) => s.id))).toEqual([
      ["s0", "s1", "s2", "s3"],
      ["s4", "s5", "s6", "s7"],
      ["s8", "s9"],
    ]);
    const second = plans[1]!;
    expect(second.before.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(second.after.map((s) => s.id)).toEqual(["s8", "s9"]);
    expect(second.windowStartMs).toBe(20_000 - 2_000);
    expect(second.windowEndMs).toBe(39_000 + 25_000);
    // first word starting at or after 18 000 ms, last word starting at or before 64 000 ms
    expect(words[second.wordLo]?.startMs).toBe(18_000);
    expect(words[second.wordHi]?.startMs).toBe(64_000);
    expect(plans[0]?.before).toEqual([]);
  });

  it("reports an empty word range when no English falls in the window", () => {
    const plans = planBatches(segments, [], { batchSize: 15 });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.wordLo).toBeGreaterThan(plans[0]!.wordHi);
  });

  it("uses a wider window when asked (queued output)", () => {
    const plan = planBatches(segments.slice(0, 1), words, { batchSize: 15, afterMs: 40_000 })[0]!;
    expect(plan.windowEndMs).toBe(44_000);
  });
});

describe("buildBatchInput", () => {
  it("lists JUDGE and CONTEXT segments with facts and indexed, timed words", () => {
    const plan = planBatches(segments, words, { batchSize: 4 })[1]!;
    const text = buildBatchInput(plan, words, groupSentences(words));
    expect(text).toContain("CONTEXT id=s3 kind=statement speaker=A 15000–19000 ms");
    expect(text).toContain("JUDGE id=s4 kind=statement speaker=A 20000–24000 ms");
    expect(text).toContain("facts: [0] number: 4件");
    expect(text).toContain(`[${plan.wordLo}] 18000 w${plan.wordLo}`);
    expect(text).toContain(`[${plan.wordHi}] 64000 w${plan.wordHi}`);
    expect(text).not.toContain(`[${plan.wordHi + 1}] `);
    expect(text).toContain("(cut at the range edge)");
    expect(text).toContain("Judge these ids in order: s4, s5, s6, s7");
  });

  it("says so when there are no English words", () => {
    const plan = planBatches(segments.slice(0, 2), [], { batchSize: 15 })[0]!;
    expect(buildBatchInput(plan, [], [])).toContain("(no English words in this time range)");
  });
});

describe("responseSchema", () => {
  it("is strict-mode compatible (every object closes and requires all keys) and limits ids", () => {
    const visit = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "object") {
        expect(obj.additionalProperties).toBe(false);
        expect([...(obj.required as string[])].sort()).toEqual(Object.keys(obj.properties as object).sort());
      }
      for (const child of Object.values(obj)) visit(child);
    };
    const schema = responseSchema(["s1", "s2"]);
    visit(schema);
    const item = (schema.properties as any).segments.items.properties;
    expect(item.id.enum).toEqual(["s1", "s2"]);
    expect(item.enStartWordIdx.type).toEqual(["integer", "null"]);
  });
});

describe("validateBatchResponse", () => {
  const plan = planBatches(segments, words, { batchSize: 4 })[1]!;
  const ok = (id: string, start: number | null, end: number | null) => ({
    id,
    aligned: start !== null,
    enStartWordIdx: start,
    enEndWordIdx: end,
    meaning: 3,
    facts: [{ index: 0, verdict: "ok" }],
    flags: [],
    note: "合成",
  });

  it("accepts a complete answer", () => {
    const { judgements, problems } = validateBatchResponse(
      { segments: [ok("s4", 40, 45), ok("s5", 50, 55), ok("s6", null, null), ok("s7", 70, 75)] },
      plan,
    );
    expect(problems).toEqual([]);
    expect(judgements.get("s4")).toMatchObject({ enStartWordIdx: 40, enEndWordIdx: 45, facts: [{ index: 0, verdict: "ok" }] });
    expect(judgements.get("s6")).toMatchObject({ aligned: false, enStartWordIdx: null });
  });

  it("reports out-of-window indices, unknown, duplicate and missing ids", () => {
    const { judgements, problems } = validateBatchResponse(
      {
        segments: [
          ok("s4", plan.wordLo - 1, 45),
          ok("s4", 40, 45),
          ok("s99", 40, 45),
          { ...ok("s5", 50, 55), facts: [{ index: 7, verdict: "ok" }, { index: 0, verdict: "bogus" }] },
        ],
      },
      plan,
    );
    expect(judgements.get("s4")?.enStartWordIdx).toBeNull();
    expect(judgements.get("s5")?.facts).toEqual([]);
    expect(problems.join("\n")).toMatch(/s4: word indices/);
    expect(problems.join("\n")).toMatch(/s4 appears twice/);
    expect(problems.join("\n")).toMatch(/s99 is not a JUDGE segment/);
    expect(problems.join("\n")).toMatch(/s5: verdicts missing/);
    expect(problems.join("\n")).toMatch(/s6 is missing/);
    expect(problems.join("\n")).toMatch(/s7 is missing/);
  });

  it("rejects a response without segments", () => {
    expect(validateBatchResponse({}, plan).problems).toEqual(["response has no segments array"]);
  });
});

describe("judgeInstructions", () => {
  it("states the rubric, the first-meaning-word rule and the flags", () => {
    const text = judgeInstructions("v1");
    for (const phrase of [
      "3 = the meaning of the Japanese is conveyed",
      "2 = slight omission or unnatural wording, but every fact is correct",
      "1 = an important part is missing or wrong",
      "0 = mistranslation, no translation, or fabricated content",
      'the first word is "Our"',
      `starts at "Tomorrow's"`,
      "place (place names)",
      `鎌倉 → "Kyoto"`,
      "answered_question",
      "hallucination",
      "wrong_language",
      "garbled",
      "repeat",
      "omission",
    ]) {
      expect(text).toContain(phrase);
    }
    expect(() => judgeInstructions("v0")).toThrow(/unknown prompt version/);
  });
});
