import { describe, expect, it } from "vitest";
import { normalizeChars } from "../src/reference/normalize.ts";
import { estimateSpans, excerptForWindow, parseTurnTranscript } from "../src/reference/transcript.ts";

// 合成の発話転記。15:00 に 3 行が束ねられた壊れた箇所を含む。
const MARKDOWN = `# 文字起こし

[00:13:50] 話者0: 前の話はここで終わりです。

[00:15:00] 話者1: ところで駅までは歩いて何分ですか？

[00:15:00] 話者0: 駅からは歩いて10分くらいです。
家賃は月に8万円でした。

[00:15:00] 話者1: なるほど。

[00:15:54] 話者0: 週末は海の近くを散歩します。朝早く起きて、犬と一緒に歩きます。

[00:18:10] 話者1: 最後の質問です。
`;

describe("turn transcript parsing", () => {
  it("reads [hh:mm:ss] 話者N: 本文 with continuation lines", () => {
    const utterances = parseTurnTranscript(MARKDOWN);
    expect(utterances.map(u => [u.timeSec, u.speaker, u.bundled])).toEqual([
      [830, "話者0", false],
      [900, "話者1", true],
      [900, "話者0", true],
      [900, "話者1", true],
      [954, "話者0", false],
      [1090, "話者1", false],
    ]);
    expect(utterances[2]!.text).toBe("駅からは歩いて10分くらいです。\n家賃は月に8万円でした。");
    expect(utterances[0]!.line).toBe(3);
  });

  it("widens the span of bundled utterances to the surrounding reliable times", () => {
    const spans = estimateSpans(parseTurnTranscript(MARKDOWN));
    expect(spans.map(s => [s.loSec, s.hiSec])).toEqual([
      [830, 954],
      [830, 954],
      [830, 954],
      [830, 954],
      [954, 1090],
      [1090, Number.POSITIVE_INFINITY],
    ]);
  });
});

describe("transcript excerpt by body-text match", () => {
  const utterances = parseTurnTranscript(MARKDOWN);
  // window の ASR（区切りや一部の語が転記と違う）
  const asr = normalizeChars("駅までは歩いて何分ですか。駅からは歩いて10分くらいです。家賃は月に8万円でした。なるほど。週末は海の近くを散歩します。").cps;

  it("takes the matching span even when the timestamps are bundled, and clips the edges", () => {
    const excerpt = excerptForWindow(utterances, asr, 890, 940, { padChars: 0 });
    expect(excerpt.utterances.map(u => u.index)).toEqual([1, 2, 3, 4]);
    expect(excerpt.utterances[0]).toMatchObject({ text: "駅までは歩いて何分ですか？", clippedHead: true, clippedTail: false });
    expect(excerpt.utterances[3]).toMatchObject({ text: "週末は海の近くを散歩します", clippedHead: false, clippedTail: true });
    expect(excerpt.bundledIncluded).toBe(3);
    expect(excerpt.coverage).toBeGreaterThan(0.95);
  });

  it("pads the excerpt with neighbouring context", () => {
    const excerpt = excerptForWindow(utterances, asr, 890, 940, { padChars: 20 });
    expect(excerpt.utterances.map(u => u.index)).toEqual([0, 1, 2, 3, 4]);
    expect(excerpt.utterances[1]!.text.startsWith("ところで")).toBe(true);
    expect(excerpt.utterances.at(-1)!.text).toContain("朝早く");
  });

  it("finds bundled utterances whose written time is outside the window", () => {
    // 束の時刻 15:00 は window（13:50–14:20）の外だが、束の範囲 [13:50, 15:54] は重なる
    const inner = normalizeChars("駅からは歩いて10分くらいです。家賃は月に8万円でした。").cps;
    const excerpt = excerptForWindow(utterances, inner, 830, 860, { marginSec: 0, padChars: 0 });
    expect(excerpt.utterances.map(u => u.index)).toEqual([2]);
    expect(excerpt.candidates).toBe(4);
  });

  it("returns nothing when the ASR does not match the transcript", () => {
    const other = normalizeChars("まったく関係のない話をしています。").cps;
    const excerpt = excerptForWindow(utterances, other, 890, 940);
    expect(excerpt.utterances).toEqual([]);
    expect(excerpt.coverage).toBe(0);
  });
});
