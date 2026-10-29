import { describe, expect, it } from "vitest";
import { buildInterpreterInstructions } from "../src/prompts/interpreter.ts";

describe("interpreter prompt factors", () => {
  it("isolates glossary, background, and output timing from the same baseline", () => {
    const baseline = buildInterpreterInstructions("plain-q", "ja", "en");
    const glossary = buildInterpreterInstructions("glossary-q", "ja", "en");
    const background = buildInterpreterInstructions("plain-q", "ja", "en", "A synthetic property discussion.");
    const timing = buildInterpreterInstructions("early-safe-q", "ja", "en");
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
  });
});
