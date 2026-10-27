import { describe, expect, it } from "vitest";
import { detectVoicedRegions, frameLevelsDb, voicedThresholdDb } from "../src/judge/regions.ts";

const SILENT = -120;
const SPEECH = -25;

/** 10 ms フレームの dB 列。voiced は [startMs, endMs) の組。 */
function levels(totalMs: number, voiced: ReadonlyArray<[number, number]>, base = SILENT): Float32Array {
  const out = new Float32Array(totalMs / 10).fill(base);
  for (const [a, b] of voiced) out.fill(SPEECH, a / 10, b / 10);
  return out;
}

describe("detectVoicedRegions", () => {
  it("merges gaps shorter than 1.5 s and pads the outer edges by 0.3 s", () => {
    const lv = levels(20_000, [[1_000, 3_000], [4_400, 5_000], [6_600, 8_000]]);
    // 3.0→4.4 s (1.4 s) merges; 5.0→6.6 s (1.6 s) does not
    expect(detectVoicedRegions(lv, -45, 20_000)).toEqual([
      { startMs: 700, endMs: 5_300 },
      { startMs: 6_300, endMs: 8_300 },
    ]);
  });

  it("clamps padding to the file and drops click-like regions", () => {
    const lv = levels(5_000, [[0, 1_000], [3_000, 3_050], [4_800, 5_000]]);
    expect(detectVoicedRegions(lv, -45, 5_000)).toEqual([
      { startMs: 0, endMs: 1_300 },
      { startMs: 4_500, endMs: 5_000 },
    ]);
  });

  it("splits regions longer than 25 s at the lowest-energy point, without padding at the cut", () => {
    // 0–40 s of speech; a dip at 18.0–18.3 s (still above the threshold, so not a gap)
    const lv = levels(40_000, [[0, 40_000]]);
    lv.fill(-40, 1_800, 1_830);
    const regions = detectVoicedRegions(lv, -45, 40_000);
    expect(regions).toHaveLength(2);
    expect(regions[0]?.startMs).toBe(0);
    expect(regions[0]?.endMs).toBeGreaterThanOrEqual(18_000);
    expect(regions[0]?.endMs).toBeLessThanOrEqual(18_300);
    expect(regions[1]?.startMs).toBe(regions[0]?.endMs);
    expect(regions[1]?.endMs).toBe(40_000);
    for (const r of regions) expect(r.endMs - r.startMs).toBeLessThanOrEqual(25_600);
  });

  it("keeps every piece within 25 s for a long flat region", () => {
    const regions = detectVoicedRegions(levels(70_000, [[5_000, 70_000]]), -45, 70_000);
    expect(regions.length).toBeGreaterThanOrEqual(3);
    for (const r of regions) expect(r.endMs - r.startMs).toBeLessThanOrEqual(25_300);
    for (let k = 1; k < regions.length; k += 1) expect(regions[k]?.startMs).toBe(regions[k - 1]?.endMs);
  });

  it("returns nothing for silence", () => {
    expect(detectVoicedRegions(levels(5_000, []), -45, 5_000)).toEqual([]);
    expect(voicedThresholdDb(levels(5_000, []))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("voicedThresholdDb and frameLevelsDb", () => {
  it("sets the threshold 25 dB under the loud frames, within -60..-45 dBFS", () => {
    expect(voicedThresholdDb(levels(10_000, [[0, 5_000]]))).toBe(-50); // -25 - 25
    expect(voicedThresholdDb(Float32Array.from([-5, -5, -5, -5]))).toBe(-45);
    expect(voicedThresholdDb(Float32Array.from([-80, -80, -80]))).toBe(-60);
  });

  it("measures mean power per 10 ms frame", () => {
    const samples = new Int16Array(480);
    samples.fill(16_384, 240); // second frame at half scale
    const lv = frameLevelsDb({ sampleRate: 24_000, samples });
    expect(lv[0]).toBe(-120);
    expect(lv[1]).toBeCloseTo(-6.02, 1);
  });
});
