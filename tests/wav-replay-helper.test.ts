import { describe, expect, it } from "vitest";
import {
  createSummary,
  generatedPcm,
  parseWavReplayArgs,
  PCM_SAMPLE_RATE,
} from "../scripts/wav-replay-helper.ts";

describe("offline WAV replay helper", () => {
  it("accepts only an absolute WAV path and bounded whole seconds", () => {
    expect(parseWavReplayArgs([])).toEqual({ seconds: 10 });
    expect(parseWavReplayArgs(["--seconds", "1", "--wav", "/private/input.wav"]))
      .toEqual({ seconds: 1, wavPath: "/private/input.wav" });
    for (const args of [
      ["--wav", "relative.wav"],
      ["--seconds", "0"],
      ["--seconds", "61"],
      ["--seconds", "1.5"],
      ["--seconds", "1", "--seconds", "2"],
      ["--unknown"],
    ]) {
      expect(() => parseWavReplayArgs(args)).toThrow();
    }
  });

  it("generates bounded in-memory non-speech PCM", () => {
    const pcm = generatedPcm(1);
    expect(pcm).toHaveLength(PCM_SAMPLE_RATE * 2);
    expect(pcm.equals(Buffer.alloc(pcm.length))).toBe(true);
    expect(() => generatedPcm(61)).toThrow();
  });

  it("never includes a source path, filename, PCM, or base64 in the summary", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const summary = createSummary({
      loaded: {
        pcm,
        sourceSampleCount: 2,
        convertedSampleCount: 2,
        sourceKind: "wav",
      },
      durationSeconds: 2 / PCM_SAMPLE_RATE,
      providerExactPcmMatch: true,
      providerInputMatch: true,
      relayJaToEnByteMatch: true,
      relayEnToJaByteMatch: true,
      relaySelfDelivery: false,
      relayAckFlow: true,
      relayPaddingBytes: 956,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("input.wav");
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain(pcm.toString("base64"));
    expect(serialized).not.toContain("pcm");
  });
});
