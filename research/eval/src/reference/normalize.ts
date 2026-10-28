/**
 * 照合用の正規化。ASR・人手転記・LLM 本文を同じ文字列空間へ写し、
 * 正規化後の各文字が元の文字列のどこから来たか（UTF-16 offset）を保つ。
 *
 * 規則（両辺へ同じ規則を当てるので、表記ゆれの吸収だけが目的）:
 * - NFKC（全角英数→半角、半角カナ→全角）と小文字化
 * - カタカナ→ひらがな（ー・々は残す）
 * - 漢数字の 〇一二三四五六七八九 → 0-9（十・百・千・万は残す）
 * - 文字（\p{L}）と数字（\p{N}）以外（空白・句読点・記号）を捨てる
 */

export interface NormalizedText {
  /** 正規化後の code point 列。 */
  readonly cps: readonly number[];
  /** cps[i] の元になった code point の、元文字列での開始 UTF-16 offset。 */
  readonly origin: readonly number[];
  /** 同、終了 UTF-16 offset（exclusive）。 */
  readonly originEnd: readonly number[];
}

const KANJI_DIGITS: ReadonlyMap<number, number> = new Map([
  [0x3007, 0x30], // 〇
  [0x4e00, 0x31], // 一
  [0x4e8c, 0x32], // 二
  [0x4e09, 0x33], // 三
  [0x56db, 0x34], // 四
  [0x4e94, 0x35], // 五
  [0x516d, 0x36], // 六
  [0x4e03, 0x37], // 七
  [0x516b, 0x38], // 八
  [0x4e5d, 0x39], // 九
]);

const KEEP = /[\p{L}\p{N}]/u;

/** 1 code point を照合用 code point 列へ（0 個以上）。 */
function normalizeCodePoint(cp: number): number[] {
  const out: number[] = [];
  const nfkc = String.fromCodePoint(cp).normalize("NFKC").toLowerCase();
  for (const ch of nfkc) {
    let c = ch.codePointAt(0)!;
    if (c >= 0x30a1 && c <= 0x30f6) c -= 0x60; // カタカナ→ひらがな
    const digit = KANJI_DIGITS.get(c);
    if (digit !== undefined) c = digit;
    if (KEEP.test(String.fromCodePoint(c))) out.push(c);
  }
  return out;
}

export function normalizeChars(text: string): NormalizedText {
  const cps: number[] = [];
  const origin: number[] = [];
  const originEnd: number[] = [];
  let offset = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    for (const c of normalizeCodePoint(cp)) {
      cps.push(c);
      origin.push(offset);
      originEnd.push(offset + ch.length);
    }
    offset += ch.length;
  }
  return { cps, origin, originEnd };
}

/** 照合用に正規化した文字列（表示・比較用）。 */
export function normalizeForMatch(text: string): string {
  return String.fromCodePoint(...normalizeChars(text).cps);
}

/** 本文の文字数（空白・句読点・記号を除く）。 */
export function visibleLength(text: string): number {
  return normalizeChars(text).cps.length;
}

/** 正規化列 hay の from 以降で needle が現れる開始位置をすべて返す。 */
export function findAll(hay: readonly number[], needle: readonly number[], from = 0, limit = Number.POSITIVE_INFINITY): number[] {
  const hits: number[] = [];
  if (needle.length === 0) return hits;
  const last = hay.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let k = 0; k < needle.length; k++) {
      if (hay[i + k] !== needle[k]) continue outer;
    }
    hits.push(i);
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * text の中で、正規化後に needle（原文表記の断片）と一致する部分を原文の表記で返す。
 * 見つからなければ null。
 */
export function locateInOriginal(text: string, needle: string): string | null {
  if (needle.length > 0 && text.includes(needle)) return needle;
  const hay = normalizeChars(text);
  const n = normalizeChars(needle).cps;
  const hit = findAll(hay.cps, n, 0, 1)[0];
  if (hit === undefined) return null;
  const from = hay.origin[hit]!;
  const to = hay.originEnd[hit + n.length - 1]!;
  return text.slice(from, to);
}
