import { describe, expect, it } from "vitest";
import { parseReference } from "../src/judge/files.ts";

describe("parseReference", () => {
  const segment = { id: "q1", startMs: 1_000, endMs: 2_000, kind: "question", text: "どこですか？", facts: [] };

  it("rejects empty speech units before they can receive a meaning score", () => {
    expect(() => parseReference({ sourceId: "source", segments: [{ ...segment, text: "  " }] })).toThrow(/segment #0/);
    expect(parseReference({ sourceId: "source", segments: [segment] }).segments[0]?.text).toBe("どこですか？");
  });
});
