import { describe, expect, it } from "vitest";
import { indexWords, wordsFromWhisper } from "../src/judge/asr.ts";
import { durationMs, encodeWav, isAllSilent, parseWav, refineWordsWithSilence, silentFrames, type PcmAudio } from "../src/judge/wav.ts";

const RATE = 24_000;

/** 指定 ms 区間だけ振幅 1000 の矩形、ほかは完全無音。 */
function audioWith(totalMs: number, voiced: ReadonlyArray<[number, number]>): PcmAudio {
  const samples = new Int16Array((totalMs * RATE) / 1000);
  for (const [a, b] of voiced) for (let i = (a * RATE) / 1000; i < (b * RATE) / 1000; i += 1) samples[i] = i % 2 === 0 ? 1000 : -1000;
  return { sampleRate: RATE, samples };
}

describe("WAV io", () => {
  it("round-trips mono PCM16 and tolerates an unknown data size", () => {
    const audio = audioWith(100, [[20, 40]]);
    const wav = encodeWav(audio.samples, RATE);
    const parsed = parseWav(wav);
    expect(parsed.sampleRate).toBe(RATE);
    expect(Array.from(parsed.samples)).toEqual(Array.from(audio.samples));
    expect(durationMs(parsed)).toBe(100);
    const streamed = Buffer.from(wav);
    streamed.writeUInt32LE(0xffffffff, 40);
    expect(parseWav(streamed).samples.length).toBe(audio.samples.length);
  });

  it("rejects non-WAV and stereo input", () => {
    expect(() => parseWav(Buffer.from("not a wav file at all"))).toThrow();
    const stereo = encodeWav(new Int16Array(4), RATE);
    stereo.writeUInt16LE(2, 22);
    expect(() => parseWav(stereo)).toThrow();
  });

  it("handles an all-silent (no output) timeline", () => {
    const frames = silentFrames(audioWith(1_000, []));
    expect(frames.length).toBe(100);
    expect(isAllSilent(frames)).toBe(true);
    expect(isAllSilent(silentFrames(audioWith(1_000, [[500, 510]])))).toBe(false);
  });
});

describe("refineWordsWithSilence", () => {
  const frames = silentFrames(audioWith(3_000, [[1_000, 2_000]]));

  it("drops words placed entirely on digital silence (ASR hallucination)", () => {
    const { words, dropped } = refineWordsWithSilence([{ text: "Thanks.", startMs: 2_300, endMs: 2_700 }], frames);
    expect(dropped).toBe(1);
    expect(words).toEqual([]);
  });

  it("moves a start or end that lies on silence to the voiced edge", () => {
    const { words, dropped } = refineWordsWithSilence(
      [
        { text: "Early", startMs: 700, endMs: 1_300 },
        { text: "inside", startMs: 1_400, endMs: 1_600 },
        { text: "late.", startMs: 1_800, endMs: 2_400 },
      ],
      frames,
    );
    expect(dropped).toBe(0);
    expect(words.map((w) => [w.startMs, w.endMs])).toEqual([
      [1_000, 1_300],
      [1_400, 1_600],
      [1_800, 2_000],
    ]);
  });
});

describe("wordsFromWhisper", () => {
  it("converts seconds to ms, adds the chunk offset and restores punctuation", () => {
    const words = wordsFromWhisper(
      {
        text: " Hello there. Next one?",
        words: [
          { word: "Hello", start: 0.5, end: 0.8 },
          { word: "there", start: 0.8, end: 1.25 },
          { word: "Next", start: 2.0, end: 2.3 },
          { word: "one", start: 2.3, end: 2.29 },
        ],
      },
      60_000,
    );
    expect(words).toEqual([
      { text: "Hello", startMs: 60_500, endMs: 60_800 },
      { text: "there.", startMs: 60_800, endMs: 61_250 },
      { text: "Next", startMs: 62_000, endMs: 62_300 },
      { text: "one?", startMs: 62_300, endMs: 62_300 },
    ]);
    const indexed = indexWords([words[2]!, words[0]!]);
    expect(indexed.map((w) => [w.i, w.text])).toEqual([
      [0, "Hello"],
      [1, "Next"],
    ]);
  });
});
