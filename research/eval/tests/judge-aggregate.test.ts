import { describe, expect, it } from "vitest";
import type { JudgeDocument, JudgedSegment, RunSummary } from "../src/engine.ts";
import { computeAggregate } from "../src/judge/metrics.ts";
import { buildRows, factErrorsLabel, optionLabel, renderTable, type RunRecord } from "../src/judge/runs-table.ts";

function summary(over: { engineId: string; options?: Record<string, string>; frameMs?: number; sourceId?: string; firstAudioOutMs?: number | null; queueMaxMs?: number; over2000Count?: number; cost?: number | null }): RunSummary {
  return {
    runId: "20261028-000000-x-src-abcd",
    engineId: over.engineId,
    sourceId: over.sourceId ?? "src1-w1",
    config: { engineId: over.engineId, sourceLanguage: "ja", targetLanguage: "en", frameMs: over.frameMs ?? 200, options: over.options ?? {} },
    windowStartSec: 0,
    windowEndSec: 60,
    durationMs: 60_000,
    tailSilenceMs: 6_000,
    engineReadyMs: -300,
    firstAudioOutMs: over.firstAudioOutMs === undefined ? 2_500 : over.firstAudioOutMs,
    firstTranscriptOutMs: 2_000,
    outputAudioMs: 40_000,
    outputTranscriptChars: 500,
    queue: { maxMs: over.queueMaxMs ?? 1_000, p95Ms: 800, over2000Count: over.over2000Count ?? 0, over2000TotalMs: 0 },
    perMinute: [],
    frames: { count: 300, maxLateMs: 3, meanLateMs: 1 },
    fatal: null,
    drained: true,
    finishWaitMs: 1_000,
    costUsdEstimate: over.cost === undefined ? 0.05 : over.cost,
    wallMs: 70_000,
  };
}

function seg(id: string, lStartMs: number | null, over: Partial<JudgedSegment> = {}): JudgedSegment {
  return {
    id,
    kind: "statement",
    aligned: lStartMs !== null,
    enStartMs: null,
    enEndMs: null,
    enText: null,
    lStartMs,
    lEndMs: null,
    lTailMs: null,
    meaning: lStartMs === null ? 0 : 3,
    facts: [],
    flags: lStartMs === null ? ["omission"] : [],
    note: "",
    ...over,
  };
}

function judgement(segments: JudgedSegment[]): JudgeDocument {
  return {
    runId: "r",
    sourceId: "src1-w1",
    engineId: "e",
    judge: { model: "gpt-5.4", promptVersion: "v1", asr: "whisper-1" },
    segments,
    aggregate: computeAggregate(segments),
  };
}

describe("optionLabel", () => {
  it("prefixes frameMs, sorts keys and shortens long values", () => {
    expect(optionLabel(summary({ engineId: "e", options: { vad: "semantic:high", model: "gpt-realtime-2.1" } }).config)).toBe(
      "frame=200 model=gpt-realtime-2.1 vad=semantic:high",
    );
    expect(optionLabel(summary({ engineId: "e", options: { x: "a".repeat(40) } }).config)).toBe(`frame=200 x=${"a".repeat(23)}…`);
    expect(optionLabel(summary({ engineId: "e", frameMs: 100 }).config)).toBe("frame=100");
  });
});

describe("factErrorsLabel", () => {
  it("summarizes wrong counts per fact type", () => {
    expect(factErrorsLabel(null)).toBe("—");
    expect(factErrorsLabel({})).toBe("0");
    expect(factErrorsLabel({ number: 0 })).toBe("0");
    expect(factErrorsLabel({ number: 1, place: 2 })).toBe("number=1 place=2");
  });
});

describe("buildRows", () => {
  const runs: RunRecord[] = [
    {
      summary: summary({ engineId: "openai-translate", firstAudioOutMs: 2_000, queueMaxMs: 1_500, over2000Count: 1, cost: 0.1 }),
      judgement: judgement([seg("a1", 3_000), seg("a2", 9_000, { meaning: 1, facts: [{ text: "3件", type: "number", verdict: "wrong" }] })]),
    },
    {
      summary: summary({ engineId: "openai-translate", sourceId: "src2-w1", firstAudioOutMs: 3_000, queueMaxMs: 2_500, over2000Count: 2, cost: null }),
      judgement: judgement([
        seg("b1", 4_000),
        seg("b2", null),
        seg("b3", 6_000, { flags: ["hallucination"], facts: [{ text: "逗子", type: "place", verdict: "wrong" }] }),
      ]),
    },
    {
      summary: summary({ engineId: "openai-translate", options: { noiseReduction: "far_field" } }),
      judgement: null,
    },
    { summary: summary({ engineId: "cascade", firstAudioOutMs: null, cost: 0.02 }), judgement: judgement([seg("c1", 5_000)]) },
  ];
  const rows = buildRows(runs);

  it("groups by engine and options and pools segments across runs", () => {
    expect(rows.map((r) => [r.engine, r.options, r.runs, r.judgedRuns])).toEqual([
      ["cascade", "frame=200", 1, 1],
      ["openai-translate", "frame=200", 2, 2],
      ["openai-translate", "frame=200 noiseReduction=far_field", 1, 0],
    ]);
    const pooled = rows[1]!;
    expect(pooled.sources).toBe(2);
    expect(pooled.n).toBe(5);
    // pooled lStart values 3000, 4000, 6000, 9000 (b2 unaligned)
    expect(pooled.lStartP50Ms).toBe(4_000);
    expect(pooled.lStartP95Ms).toBe(9_000);
    expect(pooled.lStartMaxMs).toBe(9_000);
    expect(pooled.within8s).toBe(0.6);
    expect(pooled.meaningMean).toBe(2); // (3 + 1 + 3 + 0 + 3) / 5
    expect(pooled.criticalFactErrors).toBe(2);
    expect(pooled.factErrorsByType).toEqual({ number: 1, place: 1 });
    expect(pooled.omission).toBe(1);
    expect(pooled.hallucination).toBe(1);
    expect(pooled.firstAudioOutMs).toBe(3_000);
    expect(pooled.queueMaxMs).toBe(2_500);
    expect(pooled.over2000Count).toBe(3);
    expect(pooled.costUsd).toBeCloseTo(0.1);
    expect(pooled.costPartial).toBe(true);
  });

  it("leaves judge columns empty for runs without judgement.json", () => {
    expect(rows[2]).toMatchObject({ n: null, lStartP50Ms: null, within8s: null, meaningMean: null, criticalFactErrors: null, factErrorsByType: null });
    expect(rows[0]?.factErrorsByType).toEqual({});
    expect(rows[0]?.firstAudioOutMs).toBeNull();
  });

  it("renders a numeric Markdown table without text or paths", () => {
    const table = renderTable(rows);
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^\| engine \| options \| judged\/runs/);
    expect(lines[3]).toBe(
      "| openai-translate | frame=200 | 2/2 | 2 | 5 | 4.0 | 9.0 | 9.0 | 60% | 2.00 | 2 | number=1 place=1 | 1 | 1 | 3000 | 2500 | 3 | ≥0.100 |",
    );
    expect(lines[4]).toContain("| openai-translate | frame=200 noiseReduction=far_field | 0/1 | 1 | — | — | — | — | — | — | — | — | — | — | 2500 | 1000 | 0 | 0.050 |");
    // cascade: criticalFactErrors 0, factErrorsByType "0"（判定ありで wrong なし）
    expect(lines[2]).toBe("| cascade | frame=200 | 1/1 | 1 | 1 | 5.0 | 5.0 | 5.0 | 100% | 3.00 | 0 | 0 | 0 | 0 | — | 1000 | 0 | 0.020 |");
    expect(table).not.toMatch(/src1-w1|src2-w1|\/Users\/|whisper|gpt-5/);
  });
});
