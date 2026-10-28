/**
 * 日本語の訳単位の境界を判定する純関数（形態素解析器なし・依存なし）。
 * 方針: 述語・否定が文末に来るので、述語が完結した位置でだけ切る。
 * 迷う形は「切らない」側に倒す（遅れは測れるが、早出しの誤断定は取り消せない）。
 */

const SENTENCE_TERMINATORS = new Set(["。", "！", "？", "!", "?", "．"]);
const DELIMITERS = new Set(["、", "，", ",", " ", "　", "…"]);
const CLOSERS = new Set(["」", "』", "）", ")", "”", "’", "\""]);

/** 文末記号か（ASCII の "." は 2.5 のような数字の間なら文末ではない）。 */
export function isSentenceTerminatorAt(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === undefined) return false;
  if (SENTENCE_TERMINATORS.has(ch)) return true;
  if (ch !== ".") return false;
  const prev = text[i - 1];
  const next = text[i + 1];
  if (prev !== undefined && /[0-9０-９]/.test(prev)) {
    // 数字の直後の "." は次の文字が来るまで判断しない。
    if (next === undefined || /[0-9０-９]/.test(next)) return false;
  }
  return true;
}

export function isDelimiter(ch: string | undefined): boolean {
  return ch !== undefined && DELIMITERS.has(ch);
}

export function isCloser(ch: string | undefined): boolean {
  return ch !== undefined && CLOSERS.has(ch);
}

/** 句読点・空白・括弧を除いた文字数（訳単位の長さの判定に使う）。 */
export function contentLength(text: string): number {
  return text.replace(/[\s、。，．,.!?！？…「」『』（）()“”"'’・]/gu, "").length;
}

/** 前後の空白と、先頭に残った読点などを落とす。 */
export function trimUnitText(text: string): string {
  return text.replace(/^[\s、，,…]+/u, "").replace(/\s+$/u, "");
}

/** (a) 「です/ます…」+ 区切り で文として閉じる丁寧形。長い順。 */
const POLITE_ENDINGS = [
  "ませんでした", "ですよね", "ますよね", "でしょう", "ましょう",
  "ました", "ません", "でした", "んです", "ですね", "ますね", "ですよ", "ますよ",
  "です", "ます",
];

export function endsWithPoliteEnding(before: string): boolean {
  return POLITE_ENDINGS.some(ending => before.endsWith(ending));
}

const KANJI = "\\u3400-\\u4DBF\\u4E00-\\u9FFF";
const PRED_STRONG = new RegExp(`(ませんでした|ました|ません|でした|です|ます|なかった|かった|った|いた|した|きた|んだ|[${KANJI}]た|だ|ない|る)$`, "u");
const PRED_KARA = new RegExp(`(ませんでした|ました|ません|でした|です|ます|なかった|かった|った|いた|した|きた|んだ|[${KANJI}]た|だ|ない|たい|しい|いい|る|う|て|で|[${KANJI}]い)$`, "u");
const PRED_SHI = new RegExp(`(ませんでした|ました|ません|でした|です|ます|なかった|かった|った|いた|した|きた|んだ|[${KANJI}]た|ない|たい|しい|いい|ある|いる|なる|する|くる|れる|[${KANJI}]い)$`, "u");
const PRED_TO = /(ます|です|ない|[るうくすつぬむぶぐ])$/u;
const E_ROW = /[けげせぜてでねへべぺめれえ]$/u;
const TE_PRE = new RegExp(`([っいしきちにひみりびぎじえけげせぜてでねへべぺめれく]|[${KANJI}])$`, "u");
const DE_PRE = /[んい]$/u;
const DA_RA_PRE = /[んい]$/u;
/** 「て」で終わるが節ではない複合助詞・副詞。 */
const TE_EXCLUDE = [
  "について", "として", "によって", "に対して", "にとって", "において", "に関して", "に比べて",
  "に沿って", "を通して", "に応じて", "に向けて", "に加えて", "に基づいて", "に際して", "にあたって",
  "に当たって", "に従って", "をもって", "にかけて", "にわたって", "をめぐって", "に限って",
  "初めて", "はじめて", "改めて", "決して", "すべて", "全て", "そして", "かつて", "あえて", "せめて", "やがて", "まして",
];
const DE_EXCLUDE = ["なんで"];

interface ParticleRule {
  readonly particle: string;
  readonly pre: (before: string) => boolean;
  readonly exclude?: ReadonlyArray<string>;
}

const nonEmpty = (before: string): boolean => before.trim().length > 0;

/** (b) 述語が完結した節の後の接続助詞。長い順に照合する。 */
const PARTICLE_RULES: ReadonlyArray<ParticleRule> = [
  { particle: "けれども", pre: nonEmpty },
  { particle: "けれど", pre: nonEmpty },
  { particle: "けど", pre: nonEmpty },
  { particle: "ので", pre: nonEmpty },
  { particle: "から", pre: before => PRED_KARA.test(before) },
  { particle: "たら", pre: nonEmpty },
  { particle: "だら", pre: before => DA_RA_PRE.test(before) },
  { particle: "が", pre: before => PRED_STRONG.test(before) },
  { particle: "し", pre: before => PRED_SHI.test(before) },
  { particle: "ば", pre: before => E_ROW.test(before) },
  { particle: "と", pre: before => PRED_TO.test(before) },
  { particle: "て", pre: before => TE_PRE.test(before), exclude: TE_EXCLUDE },
  { particle: "で", pre: before => DE_PRE.test(before), exclude: DE_EXCLUDE },
];

/**
 * text（区切りの直前まで）が「述語 + 接続助詞」で終わるなら、その接続助詞を返す。
 * 例: "住んでいたんですけど" → "けど"、"雨の場合には" → null、"住んで" → "て"（区切りが後に来た場合だけ呼ぶ）。
 */
export function trailingConjunctiveParticle(text: string): string | null {
  for (const rule of PARTICLE_RULES) {
    if (!text.endsWith(rule.particle)) continue;
    // 「ので」は「で」より先に判定済み。「で」規則が「ので」に当たらないようにする。
    if (rule.particle === "で" && text.endsWith("ので")) continue;
    if (rule.exclude?.some(word => text.endsWith(word))) continue;
    const before = text.slice(0, text.length - rule.particle.length);
    if (rule.pre(before)) return rule.particle;
  }
  return null;
}

const SENTENCE_FINAL_PARTICLES = ["よね", "かな", "かね", "よ", "ね", "か", "な", "わ", "ぞ", "さ", "の"];
const PRED_END = new RegExp(
  `(ませんでした|ました|ません|でした|でしょう|ましょう|だろう|です|ます|ください|なさい|なかった|かった|った|いた|した|きた|んだ|ない|たい|しい|いい|よい|[${KANJI}]い|[${KANJI}]た|[${KANJI}][すつむぶぐう]|だ|る)$`,
  "u",
);
/** 述語に見えるが述語ではない語尾（副詞・名詞・数え方）。「く」終わり（行く/早く）は区別できないので述語に数えない。 */
const NOT_PRED_END = /(また|あなた|まだ|ただ|あいだ|[一二三四五六七八九十幾]つ)$/u;

/**
 * 述語（終止形・丁寧形・過去・否定）で終わっているか。文末助詞（ね・よ・か…）は外して判定する。
 * 例: "開催しません" → true、"開催" → false、"雨の場合には" → false、"ですよね" → true。
 */
export function endsWithPredicate(text: string): boolean {
  let core = text.replace(/[\s、。，．,.!?！？…」』）)”’"]+$/u, "");
  const isPredicate = (value: string): boolean => PRED_END.test(value) && !NOT_PRED_END.test(value);
  // 文末助詞（ね・よ・か…）を最大 2 個まで外す。外す前に述語と判定できればそこで止める。
  for (let i = 0; i < 2 && !isPredicate(core); i++) {
    const sfp = SENTENCE_FINAL_PARTICLES.find(p => core.endsWith(p) && core.length > p.length);
    if (!sfp) break;
    core = core.slice(0, core.length - sfp.length);
  }
  return isPredicate(core);
}

const BACKCHANNEL_EN: Readonly<Record<string, string>> = {
  "はい": "Yes.",
  "はいはい": "Yes, yes.",
  "はーい": "Okay.",
  "ええ": "Yes.",
  "うん": "Yeah.",
  "うんうん": "Uh-huh.",
  "そうですね": "Right.",
  "そうですか": "I see.",
  "そうなんですね": "I see.",
  "そうなんですか": "I see.",
  "なるほど": "I see.",
  "なるほどね": "I see.",
  "そう": "Right.",
  "そうか": "I see.",
  "そっか": "I see.",
  "へえ": "Oh.",
  "へー": "Oh.",
  "ああ": "Ah.",
  "あー": "Ah.",
  "確かに": "True.",
  "たしかに": "True.",
};

const FILLERS = new Set(["えーと", "えっと", "えーっと", "えー", "え", "あの", "あのー", "あのう", "その", "そのー", "まあ", "まぁ", "うーん", "んー", "ん", "なんか", "あ"]);

function compact(text: string): string {
  return text.replace(/[\s、。，．,.!?！？…ー〜~]/gu, "").replace(/ー/gu, "");
}

export type UnitKind = "speech" | "backchannel" | "filler";

/** 単位の中身が相づちだけ / フィラーだけ / それ以外 かを判定する。 */
export function classifyUnit(text: string): UnitKind {
  const bare = text.replace(/[\s、。，．,.!?！？…]/gu, "");
  if (bare.length === 0) return "filler";
  if (Object.hasOwn(BACKCHANNEL_EN, bare)) return "backchannel";
  // 「はい、はい」「うん、うん」のような繰り返し
  const parts = text.split(/[\s、。，．,.!?！？…]+/u).filter(part => part.length > 0);
  if (parts.length > 0 && parts.every(part => Object.hasOwn(BACKCHANNEL_EN, part) || FILLERS.has(part))) {
    return parts.some(part => Object.hasOwn(BACKCHANNEL_EN, part)) ? "backchannel" : "filler";
  }
  if (FILLERS.has(bare) || FILLERS.has(compact(bare))) return "filler";
  return "speech";
}

/** 相づちの短い英訳（LLM を呼ばない）。 */
export function backchannelEnglish(text: string): string {
  const bare = text.replace(/[\s、。，．,.!?！？…]/gu, "");
  const direct = Object.hasOwn(BACKCHANNEL_EN, bare) ? BACKCHANNEL_EN[bare] : undefined;
  if (direct) return direct;
  const parts = text.split(/[\s、。，．,.!?！？…]+/u).filter(part => Object.hasOwn(BACKCHANNEL_EN, part));
  const first = parts[0];
  return first ? (BACKCHANNEL_EN[first] ?? "Yes.") : "Yes.";
}

/** 強制切断の退避先: 最後の格助詞（は・が・を・へ・も）の直後。 */
export function lastCaseParticleCut(text: string, from: number): number | null {
  for (let i = text.length - 2; i > from; i--) {
    const ch = text[i];
    if (ch === "は" || ch === "が" || ch === "を" || ch === "へ" || ch === "も") return i + 1;
  }
  return null;
}
