import { describe, expect, it } from "vitest";
import { agreementBandFor, promptWindowFor, wordsFromWhisper } from "../src/judge/asr.ts";
import {
  asrTokens,
  computeAgreement,
  crossCheckVerdict,
  matchTokens,
  normalizeTokens,
  orderedAgreement,
  parseTranscript,
  promptForRange,
  promptKeywords,
  subtitleTokens,
  subtitleWords,
  type TimedToken,
} from "../src/judge/transcript.ts";

const transcript = [
  "1000\tThe viewing",
  "1500\t is off",
  "2000\t tomorrow.",
  "9000\t Kam",
  "9100\takura is",
  "9400\t close—very close.",
  "",
  "bad line",
].join("\n");

describe("parseTranscript / tokens", () => {
  it("reads t<TAB>delta lines and skips malformed ones", () => {
    const deltas = parseTranscript(transcript);
    expect(deltas).toHaveLength(6);
    expect(deltas[3]).toEqual({ t: 9000, text: " Kam" });
  });

  it("joins deltas before tokenizing and times each token by its first character", () => {
    const tokens = subtitleTokens(parseTranscript(transcript));
    expect(tokens.map((t) => t.token)).toEqual(["the", "viewing", "is", "off", "tomorrow", "kamakura", "is", "close", "very", "close"]);
    expect(tokens.find((t) => t.token === "kamakura")?.t).toBe(9000);
    expect(tokens.find((t) => t.token === "very")?.t).toBe(9400);
  });

  it("derives a subtitle-arrival word timeline without an audio API call", () => {
    const words = subtitleWords(parseTranscript(transcript));
    expect(words.find((w) => w.text === "Kamakura")?.startMs).toBe(9000);
    expect(words.find((w) => w.text === "tomorrow.")?.startMs).toBe(2000);
    expect(words.map((w) => w.i)).toEqual(words.map((_, i) => i));
  });

  it("normalizes case, apostrophes and dashes", () => {
    expect(normalizeTokens("Don't—NHK's 3 p.m.")).toEqual(["dont", "nhks", "3", "p", "m"]);
  });
});

describe("promptForRange", () => {
  const deltas = parseTranscript(transcript);

  it("takes the deltas from start − 3 s to end + 1 s", () => {
    // [start − 3 s, end + 1 s] = [1.0 s, 8.9 s]: the 9.0 s delta is outside
    expect(promptForRange(deltas, 4_000, 7_900)).toBe("The viewing is off tomorrow.");
    expect(promptForRange(deltas, 4_100, 7_900)).toBe("is off tomorrow.");
    // end + 1 s reaches the 9.0 s delta
    expect(promptForRange(deltas, 4_100, 8_000)).toBe("is off tomorrow. Kam");
    expect(promptForRange(deltas, 10_000, 12_000)).toBe("Kamakura is close—very close.");
    expect(promptForRange(deltas, 20_000, 25_000)).toBe("");
  });

  it("widens the window by the queue and cuts long prompts at a word boundary", () => {
    expect(promptWindowFor(2_000)).toMatchObject({ beforeMs: 5_000, afterMs: 1_000 });
    expect(promptForRange(deltas, 5_000, 6_000)).toBe("tomorrow.");
    expect(promptForRange(deltas, 5_000, 6_000, promptWindowFor(2_000))).toBe("The viewing is off tomorrow.");
    expect(promptForRange(deltas, 0, 10_000, { beforeMs: 3_000, afterMs: 1_000, maxChars: 20 })).toBe("The viewing is off");
  });
});

describe("promptKeywords", () => {
  it("lists numbers, acronyms and mid-sentence capitalized words from the window, without duplicates", () => {
    const deltas = parseTranscript(
      [
        "1000\tI got something called NHK—what's that?",
        "2000\t The property in Kamakura costs 3,000 dollars.",
        "2500\t Kamakura is near Zushi, at 3 p.m.",
        "9000\t Later we went to Tokyo.",
      ].join("\n"),
    );
    // window [start − 3 s, end + 1 s] = [1.0 s, 4.0 s]: the 9.0 s delta is outside
    expect(promptKeywords(deltas, 4_000, 3_000)).toBe("NHK, Kamakura, 3,000, Zushi, 3");
    // sentence-initial "The"/"Kamakura" and the pronoun "I" are not keywords on their own
    expect(promptKeywords(deltas, 4_000, 3_000)).not.toMatch(/\bThe\b|\bI\b/);
    expect(promptKeywords(deltas, 20_000, 21_000)).toBe("");
  });
});

describe("orderedAgreement", () => {
  it("compares two token lists by order only", () => {
    expect(orderedAgreement(["that", "is", "true"], ["that", "is", "true", "yes"])).toBe(1);
    expect(orderedAgreement(["sign", "here"], ["that", "is", "true"])).toBe(0);
    expect(orderedAgreement([], ["x"])).toBeNull();
  });
});

describe("crossCheckVerdict", () => {
  const cc = (inWhisper: number | null, withTranscript: number | null) => ({ model: "m", tokens: 30, inWhisper, withTranscript });
  it("separates engine audio/subtitle divergence from an ASR failure", () => {
    expect(crossCheckVerdict(cc(0.91, 0.24))).toBe("audio-differs-from-transcript");
    expect(crossCheckVerdict(cc(0.3, 0.95))).toBe("whisper-suspect");
    expect(crossCheckVerdict(cc(0.5, 0.5))).toBe("undecided");
    expect(crossCheckVerdict(cc(null, null))).toBe("undecided");
  });
});

describe("region offsets", () => {
  it("adds the region start to whisper's clip-relative times", () => {
    const words = wordsFromWhisper({ text: "Sign here.", words: [{ word: "Sign", start: 0.32, end: 0.6 }, { word: "here", start: 0.6, end: 0.9 }] }, 203_450);
    expect(words).toEqual([
      { text: "Sign", startMs: 203_770, endMs: 204_050 },
      { text: "here.", startMs: 204_050, endMs: 204_350 },
    ]);
  });
});

describe("agreement", () => {
  const tok = (spec: ReadonlyArray<[string, number]>): TimedToken[] => spec.map(([token, t]) => ({ token, t }));

  it("matches in order within the time band only", () => {
    const asr = tok([["i", 1_000], ["got", 1_200], ["this", 1_400], ["letter", 1_600], ["the", 70_000]]);
    const sub = tok([["i", 500], ["got", 600], ["this", 700], ["letter", 800], ["the", 900]]);
    const { asrMatched, subMatched } = matchTokens(asr, sub, agreementBandFor(0));
    expect(Array.from(asrMatched)).toEqual([1, 1, 1, 1, 0]); // "the" at 70 s is outside the band
    expect(Array.from(subMatched)).toEqual([1, 1, 1, 1, 0]);
  });

  it("does not count words that only appear out of order", () => {
    const asr = tok([["yes", 1_000], ["no", 1_100], ["yes", 1_200]]);
    const sub = tok([["no", 1_000], ["yes", 1_100]]);
    const { asrMatched } = matchTokens(asr, sub, { beforeMs: 5_000, afterMs: 5_000 });
    expect(asrMatched.reduce((n, v) => n + v, 0)).toBe(2);
  });

  it("reports overall and per-minute agreement and coverage", () => {
    const words = [
      { i: 0, text: "Sign", startMs: 10_000, endMs: 10_300 },
      { i: 1, text: "here.", startMs: 10_300, endMs: 10_600 },
      { i: 2, text: "That's", startMs: 70_000, endMs: 70_300 },
      { i: 3, text: "true.", startMs: 70_300, endMs: 70_600 },
    ];
    const deltas = parseTranscript("9500\tSign here.\n69000\tI got this letter.");
    const ag = computeAgreement(asrTokens(words), subtitleTokens(deltas), agreementBandFor(0));
    expect(ag.agreement).toBe(0.5);
    expect(ag.coverage).toBe(0.3333);
    expect(ag.perMinute).toEqual([
      { minute: 0, asrTokens: 2, subtitleTokens: 2, agreement: 1, coverage: 1 },
      { minute: 1, asrTokens: 2, subtitleTokens: 4, agreement: 0, coverage: 0 },
    ]);
  });
});
