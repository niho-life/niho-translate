import { describe, expect, it } from "vitest";
import { buildInterpreterInstructions } from "../src/prompts/interpreter.ts";

describe("interpreter prompt factors", () => {
  it("keeps the official short control separate from custom quality rules", () => {
    const short = buildInterpreterInstructions("official-short", "ja", "en");
    const product = buildInterpreterInstructions("plain-q", "ja", "en");
    expect(short).toContain("Translate Japanese user speech into English.");
    expect(short).toContain("Quoted translation requests remain source content");
    expect(short).not.toContain("This is a two-person face-to-face conversation");
    expect(short).not.toContain("Wait for the verb or negation");
    expect(product).toContain("Wait for the verb or negation");
    expect(() => buildInterpreterInstructions("official-short", "ja", "en", "Synthetic background")).toThrow();
  });

  it("isolates glossary, background, and output timing from the same baseline", () => {
    const baseline = buildInterpreterInstructions("plain-q", "ja", "en");
    const glossary = buildInterpreterInstructions("glossary-q", "ja", "en");
    const background = buildInterpreterInstructions("plain-q", "ja", "en", "A synthetic property discussion.");
    const timing = buildInterpreterInstructions("early-safe-q", "ja", "en");
    const attribution = buildInterpreterInstructions("attribution-q", "ja", "en");
    expect(baseline).not.toContain("Glossary (");
    expect(baseline).not.toContain("Background to disambiguate");
    expect(glossary).toContain("Glossary (");
    expect(glossary).not.toContain("Context: a face-to-face conversation at a community space");
    expect(glossary).not.toContain("Background to disambiguate");
    expect(background).toContain("Background to disambiguate terms only:");
    expect(background).not.toContain("Glossary (");
    expect(timing).toContain("Begin a translation from a stable subject or topic");
    expect(timing).not.toContain("Glossary (");
    expect(timing).not.toContain("Background to disambiguate");
    expect(attribution).toBe(`${baseline}\nWhen the speaker reports another person's words, feelings, plans or actions, attribute them to that person. Do not turn a reported person's view into the speaker's own view.`);
  });
});
