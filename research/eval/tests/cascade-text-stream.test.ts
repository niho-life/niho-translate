import { describe, expect, it } from "vitest";
import { EnglishChunker, SseParser, type SseEvent } from "../src/engines/cascade/text-stream.ts";

describe("cascade SSE parser", () => {
  it("chunk の途中で切れた event と CRLF を扱う", () => {
    const events: SseEvent[] = [];
    const parser = new SseParser(event => events.push(event));
    parser.push("event: response.output_text.delta\r\ndata: {\"delta\":\"Hel");
    parser.push("lo\"}\r\n\r\nevent: done\ndata: [DONE]\n");
    parser.push("\n: comment\n\n");
    parser.end();
    expect(events).toEqual([
      { event: "response.output_text.delta", data: "{\"delta\":\"Hello\"}" },
      { event: "done", data: "[DONE]" },
    ]);
  });
});

describe("cascade English chunker", () => {
  it("sentence: 文末記号の後に空白が来たら切る（3 語以上）", () => {
    const chunker = new EnglishChunker("sentence");
    const out = [
      ...chunker.push("Yes. I lived in Canada for 2.5 years. "),
      ...chunker.push("But I couldn't renew"),
    ];
    expect(out).toEqual(["Yes. I lived in Canada for 2.5 years."]);
    expect(chunker.finish()).toBe("But I couldn't renew");
    expect(chunker.finish()).toBeNull();
  });

  it("clause: 読点の後でも切る（6 語以上）", () => {
    const chunker = new EnglishChunker("clause");
    const out = [...chunker.push("I lived in Canada for two years, but "), ...chunker.push("I couldn't renew my visa.")];
    expect(out).toEqual(["I lived in Canada for two years,"]);
    expect(chunker.finish()).toBe("but I couldn't renew my visa.");
  });

  it("unit: 最後までまとめる", () => {
    const chunker = new EnglishChunker("unit");
    expect(chunker.push("One. Two three four. Five six seven. ")).toEqual([]);
    expect(chunker.finish()).toBe("One. Two three four. Five six seven.");
  });

  it("略語の「Mr.」では切らない", () => {
    const chunker = new EnglishChunker("sentence");
    expect(chunker.push("Mr. Tanaka will show you the property. Then")).toEqual(["Mr. Tanaka will show you the property."]);
  });
});
