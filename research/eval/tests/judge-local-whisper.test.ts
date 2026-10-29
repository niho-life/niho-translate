import { describe, expect, it } from "vitest";
import { parseJudgeArgs } from "../src/judge/judge.ts";
import { wordsFromWhisperCpp } from "../src/judge/local-whisper.ts";

const base = ["--run", "/private/run", "--reference", "/private/reference.json", "--judge-backend", "codex"];

describe("local Whisper ASR", () => {
  it("maps word offsets to the replay timeline, clamps the region, and skips special tokens", () => {
    const words = wordsFromWhisperCpp({ transcription: [
      { text: "", offsets: { from: 0, to: 0 } },
      { text: " Our", offsets: { from: 500, to: 810 } },
      { text: " company", offsets: { from: 810, to: 1_230 } },
      { text: " today.", offsets: { from: 1_230, to: 2_500 } },
    ] }, 10_000, 12_000);
    expect(words).toEqual([
      { text: "Our", startMs: 10_500, endMs: 10_810 },
      { text: "company", startMs: 10_810, endMs: 11_230 },
      { text: "today.", startMs: 11_230, endMs: 12_000 },
    ]);
  });

  it("rejects malformed timestamps instead of silently reporting false latency", () => {
    expect(() => wordsFromWhisperCpp({ transcription: [{ text: " word", offsets: { from: "0", to: 100 } }] }, 0, 1_000)).toThrow("invalid word offsets");
  });

  it("requires an explicit model for fresh local ASR, but permits cached reuse", () => {
    expect(() => parseJudgeArgs([...base, "--asr-backend", "local"])).toThrow("--whisper-model");
    expect(parseJudgeArgs([...base, "--asr-backend", "local", "--whisper-model", "/private/model.bin"]).asrBackend).toBe("local");
    expect(parseJudgeArgs([...base, "--asr-backend", "local", "--skip-asr"]).skipAsr).toBe(true);
  });
});
