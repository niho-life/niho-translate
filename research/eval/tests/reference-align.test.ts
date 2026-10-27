import { describe, expect, it } from "vitest";
import {
  alignSegments,
  apportion,
  buildCharStream,
  clusterPairs,
  filterRuns,
  lcsPairs,
  placeSegments,
  streamText,
  type TimedUnit,
} from "../src/reference/align.ts";
import { findAll, locateInOriginal, normalizeChars, normalizeForMatch, visibleLength } from "../src/reference/normalize.ts";

/** 合成の whisper 風の語列: 1 文字 1 語、句読点は長さ 0、gaps で文字 index の直前に無音を入れる。 */
function words(text: string, msPerChar = 100, startMs = 0, gaps: ReadonlyMap<number, number> = new Map()): TimedUnit[] {
  const out: TimedUnit[] = [];
  let t = startMs;
  [...text].forEach((ch, i) => {
    t += gaps.get(i) ?? 0;
    const punct = /[、。？！]/.test(ch);
    out.push({ text: ch, startMs: t, endMs: punct ? t : t + msPerChar });
    if (!punct) t += msPerChar;
  });
  return out;
}

describe("normalize for matching", () => {
  it("folds width, case, katakana and kanji digits and drops punctuation", () => {
    expect(normalizeForMatch("ＡＢＣ　カタカナ、ひらがな。１２三")).toBe("abcかたかなひらがな123");
    expect(normalizeForMatch("「えー」…まあ！")).toBe("えーまあ");
    expect(visibleLength("、。 ？")).toBe(0);
    expect(visibleLength("はい。")).toBe(2);
  });

  it("keeps the UTF-16 origin of every normalized character", () => {
    const n = normalizeChars("駅、１０分");
    expect(String.fromCodePoint(...n.cps)).toBe("駅10分");
    expect(n.origin).toEqual([0, 2, 3, 4]);
    expect(n.originEnd).toEqual([1, 3, 4, 5]);
  });

  it("finds all occurrences and locates a fact in the original spelling", () => {
    const hay = normalizeChars("はいはいそうです").cps;
    expect(findAll(hay, normalizeChars("はい").cps)).toEqual([0, 2]);
    expect(findAll(hay, normalizeChars("はい").cps, 1)).toEqual([2]);
    expect(locateInOriginal("家賃は月に８万円でした。", "8万円")).toBe("８万円");
    expect(locateInOriginal("駅からカイガンまで", "かいがん")).toBe("カイガン");
    expect(locateInOriginal("駅から海岸まで", "山")).toBeNull();
  });
});

describe("LCS and run filtering", () => {
  it("returns a monotone longest common subsequence", () => {
    const a = normalizeChars("えきからあるいて").cps;
    const b = normalizeChars("えーきからはしって").cps;
    const pairs = lcsPairs(a, b);
    expect(pairs.length).toBe(5); // え・き・か・ら・て
    for (let k = 1; k < pairs.length; k++) {
      expect(pairs[k]![0]).toBeGreaterThan(pairs[k - 1]![0]);
      expect(pairs[k]![1]).toBeGreaterThan(pairs[k - 1]![1]);
    }
  });

  it("drops isolated one-character matches and outlying runs", () => {
    const pairs: Array<[number, number]> = [[0, 0], [2, 5], [3, 6], [4, 7], [6, 40], [7, 41]];
    expect(filterRuns(pairs, 2)).toEqual([[2, 5], [3, 6], [4, 7], [6, 40], [7, 41]]);
    // [6,40]-[7,41] は原稿側で 1 文字しか離れていないのに ASR 側で 32 文字離れている → 外れ値
    expect(clusterPairs(filterRuns(pairs, 2))).toEqual([[2, 5], [3, 6], [4, 7]]);
  });

  it("apportions integers by weight with the largest remainder", () => {
    expect(apportion(5, [1, 1])).toEqual([3, 2]);
    expect(apportion(4, [0, 3, 1])).toEqual([0, 3, 1]);
    expect(apportion(0, [1, 2])).toEqual([0, 0]);
    expect(apportion(3, [0, 0])).toEqual([0, 0]);
  });
});

describe("segment → word-time alignment", () => {
  const spoken = "駅から歩いて10分くらいです。家賃は月に8万円でした。";

  it("interpolates character times inside a word", () => {
    const stream = buildCharStream([{ text: "歩いて", startMs: 0, endMs: 300 }, { text: "、", startMs: 300, endMs: 300 }, { text: "10分", startMs: 300, endMs: 600 }]);
    expect(stream.cps.length).toBe(6);
    expect(stream.startMs).toEqual([0, 100, 200, 300, 400, 500]);
    expect(stream.endMs).toEqual([100, 200, 300, 400, 500, 600]);
    expect(streamText(stream, 1, 4)).toBe("いて、10");
  });

  it("anchors identical sentences by exact match and takes times from the first/last word", () => {
    const stream = buildCharStream(words(spoken, 100));
    const al = alignSegments(["駅から歩いて10分くらいです。", "家賃は月に8万円でした。"], stream.cps);
    expect(al.map(a => a.method)).toEqual(["exact", "exact"]);
    const placed = placeSegments(al, stream);
    // 「駅から歩いて10分くらいです」= 14 文字 → 0–1400 ms、次は 1400 ms から 11 文字
    expect([placed[0]!.startMs, placed[0]!.endMs]).toEqual([0, 1400]);
    expect([placed[1]!.startMs, placed[1]!.endMs]).toEqual([1400, 2500]);
  });

  it("falls back to LCS when the text was corrected, and spreads the unmatched head over the gap", () => {
    // ASR は「かまくら」、原稿は「鎌倉」（正規化しても一致しない）
    const stream = buildCharStream(words("あの、かまくらの駅から歩いて10分です。", 100));
    const al = alignSegments(["鎌倉の駅から歩いて10分です。"], stream.cps);
    expect(al[0]!.method).toBe("lcs");
    expect(al[0]!.refFirst).toBe(2);
    const placed = placeSegments(al, stream);
    // 先頭の未対応「鎌倉」（読みの長さ 4）は、直前に残った ASR 文字「あのかまくら」のうち隣接する 4 文字を取る。
    // 残りの「あの」は言いよどみとして区間に入れない。
    expect(placed[0]!.startMs).toBe(200);
    expect(placed[0]!.headUnplaced).toBe(0);
    expect(placed[0]!.endMs).toBe(1800);
  });

  it("aligns short repeated segments in order with LCS between exact anchors", () => {
    const stream = buildCharStream(words("はいそうですはい駅から歩いて10分です", 100));
    const al = alignSegments(["はい", "そうです", "はい", "駅から歩いて10分です"], stream.cps);
    expect(al.map(a => a.method)).toEqual(["lcs", "lcs", "lcs", "exact"]);
    const placed = placeSegments(al, stream);
    expect(placed.map(p => [p.startMs, p.endMs])).toEqual([[0, 200], [200, 600], [600, 800], [800, 1900]]);
  });

  it("places a segment that only differs in spelling into the leftover gap", () => {
    const stream = buildCharStream(words("駅から歩いて10分です。えー家賃は8万円でした。", 100));
    const al = alignSegments(["駅から歩いて10分です。", "ええ", "家賃は8万円でした。"], stream.cps);
    expect(al[1]!.method).toBe("none");
    const placed = placeSegments(al, stream);
    expect(placed[1]!.method).toBe("gap");
    expect([placed[1]!.startMs, placed[1]!.endMs]).toEqual([1100, 1300]);
    expect(placed[0]!.endMs).toBeLessThanOrEqual(placed[1]!.startMs!);
    expect(placed[1]!.endMs).toBeLessThanOrEqual(placed[2]!.startMs!);
  });

  it("leaves a segment unplaced when whisper-1 has nothing for it", () => {
    const stream = buildCharStream(words("駅から歩いて10分です。家賃は8万円でした。", 100));
    const al = alignSegments(["駅から歩いて10分です。", "そうなんですね", "家賃は8万円でした。"], stream.cps);
    const placed = placeSegments(al, stream);
    expect(placed[1]!.method).toBe("none");
    expect(placed[1]!.startMs).toBeNull();
    expect(placed[0]!.method).toBe("exact");
    expect(placed[2]!.method).toBe("exact");
  });

  it("does not anchor a sentence that repeats, but uses the unique ones around it", () => {
    const text = "駅から歩いて10分くらいです" + "あ".repeat(300) + "駅から歩いて10分くらいです";
    const stream = buildCharStream(words(text, 50));
    const al = alignSegments(["駅から歩いて10分くらいです", "あ".repeat(300), "駅から歩いて10分くらいです"], stream.cps);
    // 同じ文が原稿にも 2 回あるので錨にせず、間の一意な区間を錨に LCS で前後へ振り分ける
    expect(al.map(a => a.method)).toEqual(["lcs", "exact", "lcs"]);
    expect(al[0]!.first).toBe(0);
    expect(al[2]!.first).toBe(314);
  });

  it("does not anchor a segment whose text also appears inside another segment", () => {
    // 短い区間は ASR に無く、同じ語句が次の区間の中にだけある
    const stream = buildCharStream(words("本当に皆さんアンケートありがとうございました", 100));
    const al = alignSegments(["ありがとうございました", "本当に皆さんアンケートありがとうございました"], stream.cps);
    expect(al[0]!.method).toBe("none");
    expect(al[1]!.method).toBe("exact");
    expect(al[1]!.first).toBe(0);
  });

  it("rejects an exact match far from its proportional position", () => {
    // 原稿では冒頭の文が、ASR では末尾にしか無い（ASR が冒頭を落として後で同じ文を聞いた、など）
    const stream = buildCharStream(words("あ".repeat(300) + "駅から歩いて10分くらいです", 50));
    const al = alignSegments(["駅から歩いて10分くらいです", "あ".repeat(300)], stream.cps);
    expect(al[0]!.method).not.toBe("exact");
    expect(al[1]!.first).toBe(0);
  });

  it("never produces overlapping times for consecutive aligned segments", () => {
    const gaps = new Map([[15, 800], [27, 1200]]);
    const stream = buildCharStream(words("駅から歩いて10分くらいです。家賃は月に8万円でした。週末は海の近くを散歩します。", 110, 500, gaps));
    const al = alignSegments(["駅から歩いて10分くらいです。", "家賃は月に8万円でした。", "週末は海の近くを散歩します。"], stream.cps);
    const placed = placeSegments(al, stream);
    for (let k = 1; k < placed.length; k++) expect(placed[k]!.startMs!).toBeGreaterThanOrEqual(placed[k - 1]!.endMs!);
    expect(placed[1]!.startMs).toBe(500 + 14 * 110 + 800);
  });
});
