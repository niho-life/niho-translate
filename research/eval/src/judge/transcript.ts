/**
 * エンジン自身の訳字幕（output-transcript.txt: "t<TAB>delta" の行）の読み取りと、
 * ASR の英単語との一致率（順序を保った照合）。
 */
import type { OutputWord } from "./types.ts";

export interface TranscriptDelta {
  readonly t: number;
  readonly text: string;
}

export function parseTranscript(content: string): TranscriptDelta[] {
  const out: TranscriptDelta[] = [];
  for (const line of content.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const t = Number(line.slice(0, tab));
    if (!Number.isFinite(t)) continue;
    out.push({ t, text: line.slice(tab + 1).replace(/\r$/, "") });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface TimedToken {
  readonly token: string;
  readonly t: number;
}

const TOKEN = /[\p{L}\p{N}]+/gu;

/** 小文字・NFKC・アポストロフィ除去のうえ、英数字の連なりに分ける（"letter—what" → letter, what）。 */
export function normalizeTokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replace(/['’‘`]/g, "").match(TOKEN) ?? [];
}

/** delta を連結してから語に分ける（語の途中で切れた delta に対応）。語の時刻は最初の文字の delta の t。 */
export function subtitleTokens(deltas: ReadonlyArray<TranscriptDelta>): TimedToken[] {
  let text = "";
  const times: number[] = [];
  for (const d of deltas) {
    const s = d.text.normalize("NFKC").toLowerCase().replace(/['’‘`]/g, "");
    text += s;
    for (let k = 0; k < s.length; k += 1) times.push(d.t);
  }
  const out: TimedToken[] = [];
  for (const m of text.matchAll(TOKEN)) out.push({ token: m[0], t: times[m.index ?? 0] ?? 0 });
  return out;
}

/** エンジン字幕の到着時刻で作る暫定語列。音声の発話時刻とは異なる。 */
export function subtitleWords(deltas: ReadonlyArray<TranscriptDelta>): OutputWord[] {
  let joined = "";
  const times: number[] = [];
  for (const delta of deltas) {
    joined += delta.text;
    for (let i = 0; i < delta.text.length; i += 1) times.push(delta.t);
  }
  const words: OutputWord[] = [];
  // 金額・符号・小数点・桁区切りは一語として渡す。小数点で文を分割しない。
  const wordPattern = /(?:[$€£¥][+\-−]?|[+\-−][$€£¥]?)?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)[%％]?[.,!?;:]*|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*[.,!?;:]*/gu;
  for (const match of joined.matchAll(wordPattern)) {
    const startMs = times[match.index ?? 0] ?? 0;
    words.push({ i: words.length, text: match[0], startMs, endMs: startMs + 100 });
  }
  return words;
}

export function asrTokens(words: ReadonlyArray<OutputWord>): TimedToken[] {
  return words.flatMap((w) => normalizeTokens(w.text).map((token) => ({ token, t: w.startMs })));
}

export interface PromptWindow {
  /** 区間の開始より前に含める delta の幅。 */
  readonly beforeMs: number;
  /** 区間の終了より後に含める delta の幅。 */
  readonly afterMs: number;
  /** whisper は prompt の末尾 224 token しか見ないので、それに収まるよう先頭から切る。 */
  readonly maxChars: number;
}

export const DEFAULT_PROMPT_WINDOW: PromptWindow = { beforeMs: 3_000, afterMs: 1_000, maxChars: 800 };

/** [startMs − beforeMs, endMs + afterMs] に届いた delta を連結した英文（whisper の prompt）。 */
export function promptForRange(
  deltas: ReadonlyArray<TranscriptDelta>,
  startMs: number,
  endMs: number,
  window: PromptWindow = DEFAULT_PROMPT_WINDOW,
): string {
  const text = deltas
    .filter((d) => d.t >= startMs - window.beforeMs && d.t <= endMs + window.afterMs)
    .map((d) => d.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= window.maxChars) return text;
  const cut = text.lastIndexOf(" ", window.maxChars);
  return text.slice(0, cut > 0 ? cut : window.maxChars).trim();
}

const KEYWORD = /[\p{L}\p{N}](?:[\p{L}\p{N}'’.,:-]*[\p{L}\p{N}])?/gu;

/**
 * whisper の prompt 用の語の一覧（"Kamakura, NHK, 3,000"）。同じ時間帯の字幕から、数字を含む語・大文字の略語・
 * 文中の大文字で始まる語（固有名詞）だけを重複なしで取る。字幕の文そのものを渡すと whisper は
 * 「もう話された」とみなして同じ内容を読み飛ばすため（実測で再現率が下がった）、語の一覧にする。
 */
export function promptKeywords(
  deltas: ReadonlyArray<TranscriptDelta>,
  startMs: number,
  endMs: number,
  window: PromptWindow = DEFAULT_PROMPT_WINDOW,
): string {
  const text = promptForRange(deltas, startMs, endMs, { ...window, maxChars: Number.MAX_SAFE_INTEGER });
  const out = new Set<string>();
  for (const m of text.matchAll(KEYWORD)) {
    const token = m[0];
    const before = text.slice(0, m.index ?? 0).trimEnd();
    const sentenceStart = before === "" || /[.?!…:"“]$/.test(before);
    const keep = /\d/.test(token) || /^\p{Lu}{2,}/u.test(token) || (/^\p{Lu}/u.test(token) && !sentenceStart && token !== "I");
    if (keep) out.add(token);
  }
  const list = [...out].join(", ");
  if (list.length <= window.maxChars) return list;
  const cut = list.lastIndexOf(",", window.maxChars);
  return list.slice(0, cut > 0 ? cut : window.maxChars);
}

/** 照合で許す時刻差: 字幕の t が ASR 語の t − beforeMs 〜 t + afterMs にあること。 */
export interface MatchBand {
  readonly beforeMs: number;
  readonly afterMs: number;
}

/**
 * 同じ語・時刻差が band 内の組だけを候補に、両方の順序を保つ最長の対応（LCS）を取る。
 * Hunt–Szymanski 法（候補の組の最長増加列）。
 */
export function matchTokens(
  asr: ReadonlyArray<TimedToken>,
  sub: ReadonlyArray<TimedToken>,
  band: MatchBand,
): { asrMatched: Uint8Array; subMatched: Uint8Array } {
  const positions = new Map<string, number[]>();
  for (const [j, s] of sub.entries()) {
    const list = positions.get(s.token) ?? [];
    list.push(j);
    positions.set(s.token, list);
  }
  const pairI: number[] = [];
  const pairJ: number[] = [];
  const prev: number[] = [];
  const tails: number[] = []; // tails[k] = 長さ k+1 の対応列の最後の組の番号
  for (const [i, a] of asr.entries()) {
    const list = positions.get(a.token);
    if (!list) continue;
    const candidates = list.filter((j) => {
      const t = sub[j]?.t ?? 0;
      return t >= a.t - band.beforeMs && t <= a.t + band.afterMs;
    });
    for (let c = candidates.length - 1; c >= 0; c -= 1) {
      const j = candidates[c] as number;
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((pairJ[tails[mid] as number] as number) < j) lo = mid + 1;
        else hi = mid;
      }
      const p = pairI.length;
      pairI.push(i);
      pairJ.push(j);
      prev.push(lo > 0 ? (tails[lo - 1] as number) : -1);
      tails[lo] = p;
    }
  }
  const asrMatched = new Uint8Array(asr.length);
  const subMatched = new Uint8Array(sub.length);
  let p = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
  while (p >= 0) {
    asrMatched[pairI[p] as number] = 1;
    subMatched[pairJ[p] as number] = 1;
    p = prev[p] as number;
  }
  return { asrMatched, subMatched };
}

export interface MinuteAgreement {
  readonly minute: number;
  readonly asrTokens: number;
  readonly subtitleTokens: number;
  /** ASR の語のうち字幕と対応した割合（null = ASR の語なし）。 */
  readonly agreement: number | null;
  /** 字幕の語のうち ASR と対応した割合（null = 字幕の語なし）。 */
  readonly coverage: number | null;
  /** 一致率が低い分だけ、別の ASR（prompt なし）で同じ時間帯を読み直した結果。 */
  readonly crossCheck?: CrossCheck;
}

/**
 * 別の ASR の語（tokens）のうち、whisper にもある割合（inWhisper）と、エンジン字幕にもある割合（withTranscript）。
 * inWhisper が高く withTranscript が低ければ、ASR は正しく、訳音声そのものが字幕と食い違っている。
 */
export interface CrossCheck {
  readonly model: string;
  readonly tokens: number;
  readonly inWhisper: number | null;
  readonly withTranscript: number | null;
}

export type CrossCheckVerdict = "audio-differs-from-transcript" | "whisper-suspect" | "undecided";

export function crossCheckVerdict(c: CrossCheck): CrossCheckVerdict {
  if (c.withTranscript !== null && c.withTranscript >= 0.8) return "whisper-suspect";
  if (c.inWhisper !== null && c.inWhisper >= 0.8 && c.withTranscript !== null && c.withTranscript < 0.6) return "audio-differs-from-transcript";
  return "undecided";
}

export interface AsrAgreement {
  readonly asrTokens: number;
  readonly subtitleTokens: number;
  readonly agreement: number | null;
  readonly coverage: number | null;
  readonly band: MatchBand;
  readonly perMinute: ReadonlyArray<MinuteAgreement>;
}

const rate = (hit: number, n: number): number | null => (n === 0 ? null : Math.round((hit / n) * 10_000) / 10_000);

/** 時刻を使わず順序だけで照合した、a の語のうち b と対応した割合。 */
export function orderedAgreement(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number | null {
  const timed = (xs: ReadonlyArray<string>): TimedToken[] => xs.map((token) => ({ token, t: 0 }));
  const { asrMatched } = matchTokens(timed(a), timed(b), { beforeMs: 0, afterMs: 0 });
  return rate(asrMatched.reduce((n, v) => n + v, 0), a.length);
}

export function computeAgreement(asr: ReadonlyArray<TimedToken>, sub: ReadonlyArray<TimedToken>, band: MatchBand): AsrAgreement {
  const { asrMatched, subMatched } = matchTokens(asr, sub, band);
  const minutes = new Map<number, { a: number; am: number; s: number; sm: number }>();
  const bucket = (t: number) => {
    const m = Math.max(0, Math.floor(t / 60_000));
    const b = minutes.get(m) ?? { a: 0, am: 0, s: 0, sm: 0 };
    minutes.set(m, b);
    return b;
  };
  asr.forEach((x, i) => {
    const b = bucket(x.t);
    b.a += 1;
    b.am += asrMatched[i] ?? 0;
  });
  sub.forEach((x, j) => {
    const b = bucket(x.t);
    b.s += 1;
    b.sm += subMatched[j] ?? 0;
  });
  const sum = (xs: Uint8Array): number => xs.reduce((n, v) => n + v, 0);
  return {
    asrTokens: asr.length,
    subtitleTokens: sub.length,
    agreement: rate(sum(asrMatched), asr.length),
    coverage: rate(sum(subMatched), sub.length),
    band,
    perMinute: [...minutes.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([minute, b]) => ({ minute, asrTokens: b.a, subtitleTokens: b.s, agreement: rate(b.am, b.a), coverage: rate(b.sm, b.s) })),
  };
}
