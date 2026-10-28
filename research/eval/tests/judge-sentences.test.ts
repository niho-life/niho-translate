import { describe, expect, it } from "vitest";
import { attachPunctuation, endsSentence, groupSentences, SENTENCE_GAP_MS } from "../src/judge/sentences.ts";
import type { OutputWord } from "../src/judge/types.ts";

function words(spec: ReadonlyArray<[string, number, number]>): OutputWord[] {
  return spec.map(([text, startMs, endMs], i) => ({ i, text, startMs, endMs }));
}

describe("attachPunctuation", () => {
  it("restores punctuation and leading symbols from the whisper text", () => {
    const text = "Tomorrow's viewing will not be held if it rains. It costs $30 million, right?";
    const bare = ["Tomorrow's", "viewing", "will", "not", "be", "held", "if", "it", "rains", "It", "costs", "30", "million", "right"];
    expect(attachPunctuation(bare, text)).toEqual([
      "Tomorrow's", "viewing", "will", "not", "be", "held", "if", "it", "rains.", "It", "costs", "$30", "million,", "right?",
    ]);
  });

  it("matches whole words only and skips words missing from the list", () => {
    // "in" is missing from the word list; "an" must not match inside "Canada".
    const out = attachPunctuation(["I", "lived", "Canada", "an", "option."], "I lived in Canada. An option.");
    expect(out).toEqual(["I", "lived", "Canada.", "An", "option."]);
  });

  it("keeps a word that cannot be found without moving the cursor", () => {
    expect(attachPunctuation(["hello", "zebra", "world"], "Hello, world.")).toEqual(["Hello,", "zebra", "world."]);
  });
});

describe("endsSentence", () => {
  it("treats . ? ! … as sentence ends except common abbreviations", () => {
    expect(endsSentence("rains.")).toBe(true);
    expect(endsSentence("p.m.?")).toBe(true);
    expect(endsSentence("\"Really?\"")).toBe(true);
    expect(endsSentence("million,")).toBe(false);
    expect(endsSentence("2.5")).toBe(false);
    expect(endsSentence("Mr.")).toBe(false);
    expect(endsSentence("Dr.")).toBe(false);
    // whisper may split "p.m." into "p." and "m."
    expect(endsSentence("p.")).toBe(false);
    expect(endsSentence("m.?")).toBe(true);
  });
});

describe("groupSentences", () => {
  it("splits at sentence punctuation and at gaps longer than 0.6 s", () => {
    const ws = words([
      ["Tomorrow's", 3000, 3400],
      ["viewing", 3400, 3800],
      ["is", 3800, 3900],
      ["cancelled.", 3900, 4500],
      ["I", 4600, 4700],
      ["lived", 4700, 5000],
      ["there", 5000, 5300],
      // gap of exactly 600 ms: same sentence
      ["for", 5900, 6000],
      ["years", 6000, 6400],
      // gap of 601 ms: new sentence
      ["Well", 7001, 7200],
      ["then", 7200, 7500],
    ]);
    const sentences = groupSentences(ws);
    expect(SENTENCE_GAP_MS).toBe(600);
    expect(sentences.map((s) => [s.index, s.wordStart, s.wordEnd, s.startMs, s.endMs])).toEqual([
      [0, 0, 3, 3000, 4500],
      [1, 4, 8, 4600, 6400],
      [2, 9, 10, 7001, 7500],
    ]);
    expect(sentences[0]?.text).toBe("Tomorrow's viewing is cancelled.");
  });

  it("returns no sentences for no words", () => {
    expect(groupSentences([])).toEqual([]);
  });
});
