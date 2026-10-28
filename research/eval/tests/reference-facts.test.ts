import { describe, expect, it } from "vitest";
import type { DraftSegment } from "../src/reference/draft.ts";
import { applyFactsPass, buildFactsRequest, buildFactsUserContent, mergeFacts, parseFactsOutput } from "../src/reference/facts.ts";

const seg = (text: string, facts: DraftSegment["facts"] = []): DraftSegment => ({ speaker: "話者0", kind: "statement", text, facts, uncertain: false, uncertainReason: null, discrepancies: [] });

describe("facts pass", () => {
  it("sends only the final texts with ids and a strict schema without times", () => {
    const segments = [seg("駅から歩いて10分です。", [{ type: "time", text: "10分", note: null }]), { ...seg("はい"), speaker: "話者1", kind: "backchannel" as const }];
    expect(buildFactsUserContent(segments)).toBe("d0 [話者0 statement] 駅から歩いて10分です。\n  候補: time:10分\nd1 [話者1 backchannel] はい\n  候補: なし");
    const request = buildFactsRequest(segments, "gpt-5.4-mini", "low");
    expect(request).toMatchObject({ model: "gpt-5.4-mini", store: false, reasoning: { effort: "low" } });
    const schema = JSON.stringify((request["text"] as { format: { schema: unknown } }).format.schema);
    expect(schema).not.toMatch(/startMs|endMs/);
    expect(schema).toContain('"place"');
  });

  it("parses the output by id and rejects unknown ids or types", () => {
    const parsed = parseFactsOutput({ segments: [{ id: "d1", facts: [{ type: "negation", text: "わからない", note: null }] }] }, 2);
    expect(parsed).toEqual([null, [{ type: "negation", text: "わからない", note: null }]]);
    expect(() => parseFactsOutput({ segments: [{ id: "d2", facts: [] }] }, 2)).toThrow();
    expect(() => parseFactsOutput({ segments: [{ id: "x", facts: [] }] }, 2)).toThrow();
    expect(() => parseFactsOutput({ segments: [{ id: "d0", facts: [{ type: "date", text: "x", note: null }] }] }, 1)).toThrow();
  });

  it("merges with the draft facts, keeps the text's spelling and the longer of nested facts", () => {
    const text = "今日から１週間以内に出ていけと言われて、わからないことばかりでした。";
    const merged = mergeFacts(
      text,
      [{ type: "time", text: "1週間以内", note: "期限" }],
      [
        { type: "time", text: "今日から1週間以内", note: null },
        { type: "negation", text: "わからない", note: null },
        { type: "place", text: "アメリカ", note: null },
      ],
    );
    expect(merged).toEqual([
      { type: "time", text: "今日から１週間以内", note: "期限" },
      { type: "negation", text: "わからない", note: null },
    ]);
  });

  it("adds the refined facts to the draft facts and lets the pass re-type a candidate", () => {
    const out = applyFactsPass(
      [
        seg("駅から歩いて10分です。", [{ type: "time", text: "10分", note: null }]),
        seg("アメリカの会社はわかりません。", [{ type: "proper_noun", text: "アメリカ", note: null }, { type: "negation", text: "わかりません", note: null }]),
      ],
      [null, [{ type: "place", text: "アメリカ", note: null }]],
    );
    expect(out.map(s => [s.text, s.facts.map(f => `${f.type}:${f.text}`)])).toEqual([
      ["駅から歩いて10分です。", ["time:10分"]],
      ["アメリカの会社はわかりません。", ["place:アメリカ", "negation:わかりません"]],
    ]);
  });
});
