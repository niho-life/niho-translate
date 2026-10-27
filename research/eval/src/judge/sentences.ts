/**
 * whisper-1 の単語列（句読点なし）に text の句読点を戻し、文にまとめる。
 */
import type { EnSentence, OutputWord } from "./types.ts";

/** 文の区切りとみなす無音の長さ（これを超えたら別の文）。 */
export const SENTENCE_GAP_MS = 600;

const TRAILING = /[.,!?;:…"'”’)\]]/;
const LEADING = /^[\s"'“‘(\[$¥£€#-]*$/;
const ABBREVIATIONS = new Set(["mr.", "mrs.", "ms.", "dr.", "st.", "vs.", "etc.", "e.g.", "i.e.", "no.", "approx."]);

const ALNUM = /[\p{L}\p{N}]/u;
/** 語の探索で読み飛ばしてよい text の長さ（words に無い語が text にある場合）。 */
const MAX_SKIP = 48;

function findWord(haystack: string, needle: string, from: number): number {
  let idx = haystack.indexOf(needle, from);
  while (idx >= 0 && idx - from <= MAX_SKIP) {
    const before = idx > 0 ? (haystack[idx - 1] ?? "") : "";
    const after = haystack[idx + needle.length] ?? "";
    if (!ALNUM.test(before) && !ALNUM.test(after)) return idx;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return -1;
}

/**
 * bareWords（whisper の words[].word）を text の中で順に探し、直前の記号（$ や引用符）と
 * 直後の句読点を付けて返す。見つからない語は元の表記のまま（カーソルを進めない）。
 */
export function attachPunctuation(bareWords: ReadonlyArray<string>, text: string): string[] {
  const lower = text.toLowerCase();
  const haystack = lower.length === text.length ? lower : text;
  let cursor = 0;
  return bareWords.map((raw) => {
    const bare = raw.trim();
    if (!bare) return bare;
    const needle = haystack === lower ? bare.toLowerCase() : bare;
    const idx = findWord(haystack, needle, cursor);
    if (idx < 0) return bare;
    const between = text.slice(cursor, idx);
    const lead = LEADING.test(between) ? between.trim() : "";
    let end = idx + bare.length;
    while (end < text.length && TRAILING.test(text[end] ?? "")) end += 1;
    const word = lead + text.slice(idx, end);
    cursor = end;
    return word;
  });
}

export function endsSentence(word: string): boolean {
  const t = word.trim();
  if (!/[.?!…]["'”’)\]]*$/.test(t)) return false;
  // whisper は "p.m." を "p." "m." に分けることがある。1 文字 + "." は略語の一部とみなす。
  if (/^[A-Za-z]\.$/.test(t)) return false;
  return !ABBREVIATIONS.has(t.toLowerCase().replace(/["'”’)\]]+$/, ""));
}

/** 句読点（. ? ! …）または gapMs を超える間で文に区切る。words は時刻順。 */
export function groupSentences(words: ReadonlyArray<OutputWord>, gapMs = SENTENCE_GAP_MS): EnSentence[] {
  const sentences: EnSentence[] = [];
  let start = 0;
  const close = (endIdx: number): void => {
    const first = words[start];
    const last = words[endIdx];
    if (!first || !last) return;
    sentences.push({
      index: sentences.length,
      startMs: first.startMs,
      endMs: last.endMs,
      wordStart: start,
      wordEnd: endIdx,
      text: words.slice(start, endIdx + 1).map((w) => w.text).join(" "),
    });
    start = endIdx + 1;
  };
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const next = words[i + 1];
    if (!word) continue;
    if (!next || endsSentence(word.text) || next.startMs - word.endMs > gapMs) close(i);
  }
  return sentences;
}

/** 語 index → 文 index の表。 */
export function sentenceOfWord(sentences: ReadonlyArray<EnSentence>, wordCount: number): Int32Array {
  const map = new Int32Array(wordCount).fill(-1);
  for (const s of sentences) for (let i = s.wordStart; i <= s.wordEnd && i < wordCount; i += 1) map[i] = s.index;
  return map;
}
