/**
 * 録音に付属する人手（未校正）の発話転記 `[hh:mm:ss] 話者N: 本文` を読み、window に当たる部分を抜き出す。
 *
 * 時刻は発話開始の概算で、複数行が同じ時刻に束ねられた壊れた箇所がある。
 * そこで時刻は「候補を広めに拾う」ためだけに使い、実際に window に入る範囲は
 * window の ASR 文字列との本文一致（LCS の 3 文字以上の連続一致の、最も密な塊）で決める。
 */
import { filterRuns, lcsPairs } from "./align.ts";
import { normalizeChars } from "./normalize.ts";

export interface TurnUtterance {
  readonly index: number;
  /** 見出し行の行番号（1 始まり）。 */
  readonly line: number;
  readonly timeSec: number;
  readonly speaker: string;
  readonly text: string;
  /** 隣の発話と同じ時刻（壊れた束）。この時刻は信用しない。 */
  readonly bundled: boolean;
}

const HEADER = /^\s*\[(\d{1,2}):(\d{2}):(\d{2})\]\s*([^:：\]]+?)\s*[:：]\s?(.*)$/;

export function parseTurnTranscript(markdown: string): TurnUtterance[] {
  const raw: Array<{ line: number; timeSec: number; speaker: string; text: string }> = [];
  markdown.split(/\r?\n/).forEach((lineText, i) => {
    const m = HEADER.exec(lineText);
    if (m !== null) {
      const timeSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      raw.push({ line: i + 1, timeSec, speaker: m[4]!.trim(), text: m[5]!.trim() });
      return;
    }
    const body = lineText.trim();
    const current = raw[raw.length - 1];
    if (body.length > 0 && current !== undefined) current.text = current.text.length > 0 ? `${current.text}\n${body}` : body;
  });
  return raw.map((u, i) => ({
    index: i,
    line: u.line,
    timeSec: u.timeSec,
    speaker: u.speaker,
    text: u.text,
    bundled: (i > 0 && raw[i - 1]!.timeSec === u.timeSec) || (i + 1 < raw.length && raw[i + 1]!.timeSec === u.timeSec),
  }));
}

export interface UtteranceSpan {
  readonly loSec: number;
  readonly hiSec: number;
}

/**
 * 各発話が音声のどこにあり得るかの範囲。束ねられた発話は、前後の信用できる時刻の間のどこか。
 * 発話の終わりは次の信用できる時刻（それより前に終わる保証はない）。
 */
export function estimateSpans(utterances: readonly TurnUtterance[]): UtteranceSpan[] {
  const reliable = utterances.map(u => !u.bundled);
  return utterances.map((u, i) => {
    let lo = u.timeSec;
    if (!reliable[i]) {
      lo = 0;
      for (let j = i - 1; j >= 0; j--) {
        if (reliable[j]) {
          lo = utterances[j]!.timeSec;
          break;
        }
      }
    }
    let hi = Number.POSITIVE_INFINITY;
    for (let j = i + 1; j < utterances.length; j++) {
      if (reliable[j] && utterances[j]!.timeSec > lo) {
        hi = utterances[j]!.timeSec;
        break;
      }
    }
    return { loSec: lo, hiSec: hi };
  });
}

export interface ExcerptUtterance {
  readonly index: number;
  readonly speaker: string;
  readonly text: string;
  readonly clippedHead: boolean;
  readonly clippedTail: boolean;
  readonly bundled: boolean;
}

export interface TranscriptExcerpt {
  readonly utterances: readonly ExcerptUtterance[];
  /** 時刻で拾った候補の発話数。 */
  readonly candidates: number;
  /** window の ASR 文字のうち、転記の主な塊と一致した割合。 */
  readonly coverage: number;
  /** 束ねられた（時刻の壊れた）発話のうち、本文一致で window に入ったもの。 */
  readonly bundledIncluded: number;
}

export interface ExcerptOptions {
  /** 候補を拾うときに window の前後へ広げる秒数。 */
  readonly marginSec?: number;
  /** 抜き出す範囲を一致範囲の前後へ広げる文字数。 */
  readonly padChars?: number;
  /** 一致の塊を分ける、転記側の文字の隙間。 */
  readonly clusterGap?: number;
  readonly minRun?: number;
}

/**
 * window の ASR（正規化文字列）と本文が一致する転記の範囲を抜き出す。
 * 時刻は候補選びだけに使う（束ねられた発話は前後の信用できる時刻の間のどこかとして扱う）。
 */
export function excerptForWindow(
  utterances: readonly TurnUtterance[],
  asr: readonly number[],
  windowStartSec: number,
  windowEndSec: number,
  options: ExcerptOptions = {},
): TranscriptExcerpt {
  const margin = options.marginSec ?? 120;
  const pad = options.padChars ?? 20;
  const clusterGap = options.clusterGap ?? 80;
  const minRun = options.minRun ?? 3;
  const spans = estimateSpans(utterances);
  const candidates = utterances.filter((_, i) => spans[i]!.hiSec > windowStartSec - margin && spans[i]!.loSec < windowEndSec + margin);

  const cps: number[] = [];
  const owner: number[] = []; // candidates の index
  const origin: number[] = [];
  const originEnd: number[] = [];
  candidates.forEach((u, ci) => {
    const norm = normalizeChars(u.text);
    norm.cps.forEach((cp, j) => {
      cps.push(cp);
      owner.push(ci);
      origin.push(norm.origin[j]!);
      originEnd.push(norm.originEnd[j]!);
    });
  });
  const empty: TranscriptExcerpt = { utterances: [], candidates: candidates.length, coverage: 0, bundledIncluded: 0 };
  if (cps.length === 0 || asr.length === 0) return empty;

  const pairs = filterRuns(lcsPairs(asr, cps), minRun);
  if (pairs.length === 0) return empty;
  // 転記側の index で、隙間 clusterGap 以下の連なりに分ける。ASR が一部を落とすと本物の範囲も
  // 複数の塊に割れるので、最大の塊の 1 割（かつ 15 文字）以上ある塊をすべて含む範囲を取る。
  // 前後の余白で偶然一致した短い塊は捨てる。
  const clusters: Array<{ from: number; to: number; count: number }> = [];
  let from = 0;
  for (let k = 1; k <= pairs.length; k++) {
    if (k === pairs.length || pairs[k]![1] - pairs[k - 1]![1] > clusterGap) {
      clusters.push({ from, to: k - 1, count: k - from });
      from = k;
    }
  }
  const bestCount = Math.max(...clusters.map(c => c.count));
  const significant = clusters.filter(c => c.count >= Math.min(bestCount, Math.max(15, 0.1 * bestCount)));
  const lo = Math.max(0, pairs[significant[0]!.from]![1] - pad);
  const hi = Math.min(cps.length - 1, pairs[significant[significant.length - 1]!.to]![1] + pad);
  const matched = significant.reduce((a, c) => a + c.count, 0);

  const out: ExcerptUtterance[] = [];
  candidates.forEach((u, ci) => {
    let first = -1;
    let last = -1;
    let total = 0;
    let firstOwn = -1;
    for (let k = 0; k < cps.length; k++) {
      if (owner[k] !== ci) continue;
      if (firstOwn < 0) firstOwn = k;
      total++;
      if (k >= lo && k <= hi) {
        if (first < 0) first = k;
        last = k;
      }
    }
    if (first < 0) return;
    const clippedHead = first > firstOwn;
    const clippedTail = last < firstOwn + total - 1;
    const text = u.text.slice(clippedHead ? origin[first]! : 0, clippedTail ? originEnd[last]! : u.text.length).trim();
    if (text.length === 0) return;
    out.push({ index: u.index, speaker: u.speaker, text, clippedHead, clippedTail, bundled: u.bundled });
  });
  return {
    utterances: out,
    candidates: candidates.length,
    coverage: matched / asr.length,
    bundledIncluded: out.filter(u => u.bundled).length,
  };
}
