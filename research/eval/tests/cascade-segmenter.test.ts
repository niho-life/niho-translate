import { describe, expect, it } from "vitest";
import { Segmenter, type SegmentUnit } from "../src/engines/cascade/segmenter.ts";
import { endsWithPredicate, trailingConjunctiveParticle } from "../src/engines/cascade/japanese.ts";

/** ASR の delta を stepMs 間隔で足していき、出た単位を集める。 */
function stream(seg: Segmenter, deltas: ReadonlyArray<string>, startMs = 0, stepMs = 300): { units: SegmentUnit[]; text: string; endMs: number; history: Array<{ after: string; units: number }> } {
  let text = "";
  let t = startMs;
  const units: SegmentUnit[] = [];
  const history: Array<{ after: string; units: number }> = [];
  for (const delta of deltas) {
    text += delta;
    units.push(...seg.update(text, t));
    history.push({ after: text, units: units.length });
    t += stepMs;
  }
  return { units, text, endMs: t, history };
}

describe("cascade segmenter: 否定・述語が文末に来る文", () => {
  const deltas = ["明日", "の", "内見", "は", "、", "雨", "の", "場合", "には", "、", "開催", "し", "ません", "。"];

  it("「開催」で切らず、文末（しません。）まで 1 単位にする", () => {
    const seg = new Segmenter();
    const { units, history } = stream(seg, deltas);
    expect(units.map(u => u.text)).toEqual(["明日の内見は、雨の場合には、開催しません。"]);
    expect(units[0]?.reason).toBe("sentence");
    // 「開催」「開催し」が届いた時点では何も出ていない
    expect(history.filter(h => h.after.endsWith("開催") || h.after.endsWith("開催し")).every(h => h.units === 0)).toBe(true);
  });

  it("「開催」の後に話者の間があっても切らない（述語が完結していない）", () => {
    const seg = new Segmenter();
    const upTo = deltas.slice(0, deltas.indexOf("開催") + 1);
    const { units, text, endMs } = stream(seg, upTo);
    expect(units).toEqual([]);
    expect(seg.markBoundary(endMs)).toEqual([]);
    expect(seg.pause(endMs + 700)).toEqual([]);
    const rest = seg.update(`${text}しません。`, endMs + 1_000);
    expect(rest.map(u => u.text)).toEqual(["明日の内見は、雨の場合には、開催しません。"]);
  });

  it("上限で強制的に切るときも「開催」を含めず、最後の読点で切る", () => {
    const seg = new Segmenter();
    const upTo = deltas.slice(0, deltas.indexOf("開催") + 1);
    const { text } = stream(seg, upTo, 0, 300);
    expect(seg.tick(8_500)).toEqual([]); // 8 秒超: 安全な境界（述語・接続助詞）が無いので待つ
    const forced = seg.tick(10_100);
    expect(forced.map(u => [u.text, u.reason, u.end])).toEqual([["明日の内見は、雨の場合には、", "forced", "open"]]);
    const rest = seg.update(`${text}しません。`, 10_400);
    expect(rest.map(u => u.text)).toEqual(["開催しません。"]);
  });
});

describe("cascade segmenter: 接続助詞での分割", () => {
  it("述語 + けど + 読点で切る（12 文字以上）", () => {
    const seg = new Segmenter();
    const { units } = stream(seg, ["カナダ", "に", "2", "年", "半", "住", "んで", "いた", "ん", "です", "けど", "、", "学生", "ビザ", "の", "更新", "は", "でき", "ません", "でした", "。"]);
    expect(units.map(u => [u.text, u.reason])).toEqual([
      ["カナダに2年半住んでいたんですけど、", "clause"],
      ["学生ビザの更新はできませんでした。", "sentence"],
    ]);
    expect(units[0]?.end).toBe("clause");
  });

  it("短い条件節（12 文字未満・2 秒未満）は主節とまとめる", () => {
    const seg = new Segmenter();
    const { units } = stream(seg, ["雨", "が", "降っ", "たら", "、", "中止", "です", "。"], 0, 100);
    expect(units.map(u => u.text)).toEqual(["雨が降ったら、中止です。"]);
  });

  it("短くても 2 秒以上かけて話された節は切る", () => {
    const seg = new Segmenter();
    const { units } = stream(seg, ["雨", "が", "降っ", "たら", "、", "中止", "です", "。"], 0, 700);
    expect(units.map(u => u.text)).toEqual(["雨が降ったら、", "中止です。"]);
  });

  it("「住んで|いた」のように区切りの無い te 形では切らず、読点が来たら切る", () => {
    const seg = new Segmenter();
    const { units } = stream(seg, ["私", "は", "去年", "の", "春", "から", "カナダ", "に", "住", "んで", "、", "英語", "を", "勉強", "しました", "。"]);
    expect(units.map(u => u.text)).toEqual(["私は去年の春からカナダに住んで、", "英語を勉強しました。"]);
    const seg2 = new Segmenter();
    const { units: units2 } = stream(seg2, ["私", "は", "去年", "の", "春", "から", "カナダ", "に", "住", "んで", "いた", "ん", "です", "。"]);
    expect(units2.map(u => u.text)).toEqual(["私は去年の春からカナダに住んでいたんです。"]);
  });

  it("「について、」のような複合助詞では切らない", () => {
    const seg = new Segmenter();
    const { units } = stream(seg, ["この", "物件", "について", "、", "管理", "会社", "から", "詳しく", "説明", "します", "。"]);
    expect(units.map(u => u.text)).toEqual(["この物件について、管理会社から詳しく説明します。"]);
  });

  it("ASR item の終わり（短い無音）を読点の代わりに使う", () => {
    const seg = new Segmenter();
    const { units, endMs } = stream(seg, ["カナダ", "に", "2", "年", "半", "住んで", "いた", "んです", "けど"]);
    expect(units).toEqual([]);
    const cut = seg.markBoundary(endMs);
    expect(cut.map(u => [u.text, u.reason])).toEqual([["カナダに2年半住んでいたんですけど", "clause"]]);
  });

  it("sentence モードでは接続助詞で切らない", () => {
    const seg = new Segmenter({ mode: "sentence", minClauseChars: 12, minClauseMs: 2_000, softMaxMs: 8_000, hardMaxMs: 10_000 });
    const { units } = stream(seg, ["カナダに2年半住んでいたんですけど", "、", "学生ビザの更新はできませんでした", "。"]);
    expect(units.map(u => u.text)).toEqual(["カナダに2年半住んでいたんですけど、学生ビザの更新はできませんでした。"]);
  });

  it("数字の中の「.」は文末にしない", () => {
    const seg = new Segmenter();
    const { units } = stream(seg, ["カナダ", "に", "2", ".", "5", "年", "住み", "ました", "。"]);
    expect(units.map(u => u.text)).toEqual(["カナダに2.5年住みました。"]);
  });
});

describe("cascade segmenter: 間・上限・相づち", () => {
  it("(c) 句点が無くても、間で述語が完結していれば切る", () => {
    const seg = new Segmenter();
    const { units, endMs } = stream(seg, ["我が社", "は", "今年", "で", "五", "周年", "に", "なります"]);
    expect(units).toEqual([]);
    const cut = seg.pause(endMs + 700);
    expect(cut.map(u => [u.text, u.reason, u.end])).toEqual([["我が社は今年で五周年になります", "pause", "sentence"]]);
  });

  it("(c) 名詞・助詞止まりは間があっても切らない", () => {
    const seg = new Segmenter();
    const { endMs } = stream(seg, ["明日", "の", "内見", "は", "雨", "の", "場合", "には"]);
    expect(seg.pause(endMs + 700)).toEqual([]);
    expect(seg.pending).toBe("明日の内見は雨の場合には");
  });

  it("(d) 8 秒を超えたら最後の安全な境界（短い節でも）で切る", () => {
    const seg = new Segmenter();
    const units: SegmentUnit[] = [];
    units.push(...seg.update("雨が降ったら、", 0));
    units.push(...seg.update("雨が降ったら、その次の日の朝早くに", 3_000));
    expect(units).toEqual([]);
    const cut = seg.tick(8_100);
    expect(cut.map(u => [u.text, u.reason, u.end])).toEqual([["雨が降ったら、", "max", "clause"]]);
    expect(seg.pending).toBe("その次の日の朝早くに");
  });

  it("(d) 区切りが全く無いまま 10 秒を超えたら、最後の格助詞の後で強制的に切る", () => {
    const seg = new Segmenter();
    seg.update("学生ビザの更新は", 0);
    seg.update("学生ビザの更新はでき", 2_000);
    const cut = seg.tick(10_050);
    expect(cut.map(u => [u.text, u.reason])).toEqual([["学生ビザの更新は", "forced"]]);
    expect(seg.pending).toBe("でき");
  });

  it("相づち・フィラーだけの単位を見分ける", () => {
    const seg = new Segmenter();
    const units = stream(seg, ["はい", "。", "そう", "ですね", "、", "駅", "から", "近い", "です", "。"]).units;
    expect(units.map(u => [u.text, u.kind])).toEqual([
      ["はい。", "backchannel"],
      ["そうですね、", "backchannel"],
      ["駅から近いです。", "speech"],
    ]);
    const seg2 = new Segmenter();
    const { endMs } = stream(seg2, ["えーと", "、"]);
    expect(seg2.pause(endMs + 700).map(u => u.kind)).toEqual(["filler"]);
  });

  it("flush で残りを出す（述語が無ければ open）", () => {
    const seg = new Segmenter();
    stream(seg, ["学生", "ビザ", "の", "更新", "は"]);
    expect(seg.flush(5_000).map(u => [u.text, u.reason, u.end])).toEqual([["学生ビザの更新は", "flush", "open"]]);
  });

  it("訳へ回した範囲の書き換えは数えるだけで、二度出さない", () => {
    const seg = new Segmenter();
    expect(seg.update("はい。", 0).map(u => u.text)).toEqual(["はい。"]);
    expect(seg.update("はい、", 300)).toEqual([]);
    expect(seg.revisedBeforeCut).toBe(1);
    expect(seg.update("はい、そうです。", 600).map(u => u.text)).toEqual(["そうです。"]);
  });

  it("確定時に item 先頭の空白が落ちても、切った位置を写して次の単位の文字を欠かさない", () => {
    const seg = new Segmenter();
    const first = seg.update(" カナダに二年半住んでいたんですけど、学生ビザの", 0);
    expect(first.map(u => u.text)).toEqual(["カナダに二年半住んでいたんですけど、"]);
    expect(seg.update("カナダに二年半住んでいたんですけど、学生ビザの", 100)).toEqual([]);
    expect(seg.revisedBeforeCut).toBe(0);
    expect(seg.pending).toBe("学生ビザの");
    expect(seg.update("カナダに二年半住んでいたんですけど、学生ビザの更新はできませんでした。", 200).map(u => u.text))
      .toEqual(["学生ビザの更新はできませんでした。"]);
  });

  it("単位の時刻（最初の文字の到着）を残す", () => {
    const seg = new Segmenter();
    const { units } = stream(seg, ["今日", "は", "晴れ", "です", "。"], 1_000, 200);
    expect(units[0]?.firstCharMs).toBe(1_000);
    expect(units[0]?.committedMs).toBe(1_800);
    expect(units[0]?.segmentId).toBe("u1");
  });
});

describe("cascade japanese heuristics", () => {
  it("述語で終わるか", () => {
    for (const text of ["開催しません", "開催しません。", "行きます", "そうですよね", "大きいです", "行った", "雨だった", "高い", "できませんでした", "住むの", "話す", "そうだな"]) {
      expect(endsWithPredicate(text), text).toBe(true);
    }
    for (const text of ["開催", "雨の場合には", "明日の", "大事な", "また", "あなた", "まだ", "学生ビザの更新は", "早く", "一つ"]) {
      expect(endsWithPredicate(text), text).toBe(false);
    }
  });

  it("述語 + 接続助詞", () => {
    expect(trailingConjunctiveParticle("住んでいたんですけど")).toBe("けど");
    expect(trailingConjunctiveParticle("雨が降ったら")).toBe("たら");
    expect(trailingConjunctiveParticle("高いので")).toBe("ので");
    expect(trailingConjunctiveParticle("行きましたが")).toBe("が");
    expect(trailingConjunctiveParticle("時間があれば")).toBe("ば");
    expect(trailingConjunctiveParticle("駅に着くと")).toBe("と");
    expect(trailingConjunctiveParticle("カナダに住んで")).toBe("で");
    expect(trailingConjunctiveParticle("書類を出して")).toBe("て");
    // 名詞 + 格助詞は節ではない
    expect(trailingConjunctiveParticle("私が")).toBeNull();
    expect(trailingConjunctiveParticle("東京から")).toBeNull();
    expect(trailingConjunctiveParticle("物件について")).toBeNull();
    expect(trailingConjunctiveParticle("家で")).toBeNull();
    expect(trailingConjunctiveParticle("わたし")).toBeNull();
    expect(trailingConjunctiveParticle("AとB")).toBeNull();
  });
});
