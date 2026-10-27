/**
 * 訳単位の区切り（純粋・時計なし）。呼び出し側が nowMs を渡す。
 *
 * 入力: ASR の安定テキスト全体 S（確定 item の最終文字列 + 未確定 item の delta）。
 * 出力: 訳へ回す単位。切った位置より前は二度と出さない（訳音声は取り消せないため）。
 *
 * 切る条件（README の (a)〜(d)）:
 *  (a) 文末（。？！）、または「です/ます/ました/ません/でした/んです/ですね/ますね…」+ 区切り
 *  (b) 述語が完結した節 + 接続助詞 + 区切りで、単位が minClauseChars 文字以上か minClauseMs 以上
 *  (c) 話者の間（pause()）で述語が完結している、または相づち・フィラーだけ
 *  (d) 単位の最初の文字から softMaxMs を超えたら最後の安全な境界、hardMaxMs を超えたら強制
 * 「区切り」は 、/空白/… と、ASR item の終わり（無音で commit された位置 = markBoundary）。
 */
import {
  classifyUnit,
  contentLength,
  endsWithPoliteEnding,
  endsWithPredicate,
  isCloser,
  isDelimiter,
  isSentenceTerminatorAt,
  lastCaseParticleCut,
  trailingConjunctiveParticle,
  trimUnitText,
  type UnitKind,
} from "./japanese.ts";

export type CutReason = "sentence" | "clause" | "pause" | "max" | "forced" | "flush";
/** 単位の終わり方。訳者（LLM）に「開いた節か」を伝える。 */
export type UnitEnd = "sentence" | "clause" | "open";

export interface SegmenterConfig {
  /** clause: (a)〜(d)。sentence: (b) を使わない比較用。 */
  readonly mode: "clause" | "sentence";
  readonly minClauseChars: number;
  readonly minClauseMs: number;
  readonly softMaxMs: number;
  readonly hardMaxMs: number;
}

export const DEFAULT_SEGMENTER_CONFIG: SegmenterConfig = {
  mode: "clause",
  minClauseChars: 12,
  minClauseMs: 2_000,
  softMaxMs: 8_000,
  hardMaxMs: 10_000,
};

export interface SegmentUnit {
  readonly segmentId: string;
  readonly index: number;
  readonly text: string;
  /** 句読点・空白を除いた文字数。 */
  readonly chars: number;
  readonly reason: CutReason;
  readonly end: UnitEnd;
  readonly kind: UnitKind;
  /** 単位の最初の文字が ASR から届いた時刻。 */
  readonly firstCharMs: number;
  readonly committedMs: number;
}

interface Cut {
  readonly pos: number;
  readonly reason: CutReason;
  readonly end: UnitEnd;
}

const LEADING_SKIP = /[\s、，,…]/u;

export class Segmenter {
  private text = "";
  private times: number[] = [];
  private cut = 0;
  private readonly boundaries = new Set<number>();
  private nextIndex = 1;
  private revisedBeforeCutCount = 0;

  constructor(private readonly config: SegmenterConfig = DEFAULT_SEGMENTER_CONFIG) {}

  /** まだ単位になっていない文字列。 */
  get pending(): string {
    return this.text.slice(this.cut);
  }

  /** 既に訳へ回した範囲を ASR が書き換えた回数（取り消せないので数えるだけ）。 */
  get revisedBeforeCut(): number {
    return this.revisedBeforeCutCount;
  }

  /** ASR の安定テキスト全体を渡す（追記でも書き換えでもよい）。 */
  update(fullText: string, nowMs: number): SegmentUnit[] {
    this.setText(fullText, nowMs);
    return [...this.evaluate(nowMs), ...this.limits(nowMs)];
  }

  /** 現在の末尾に ASR item の終わり（短い無音）がある。区切りとして扱う。 */
  markBoundary(nowMs: number): SegmentUnit[] {
    if (this.text.length > this.cut) this.boundaries.add(this.text.length);
    return [...this.evaluate(nowMs), ...this.limits(nowMs)];
  }

  /** (c) 話者の間（pauseMs 以上）で ASR が追いついた。述語が完結していれば残りを切る。 */
  pause(nowMs: number): SegmentUnit[] {
    const out = this.markBoundary(nowMs);
    const pending = trimUnitText(this.pending);
    if (pending.length > 0 && (classifyUnit(pending) !== "speech" || endsWithPredicate(pending))) {
      const unit = this.emit(this.text.length, "pause", "sentence", nowMs);
      if (unit) out.push(unit);
    }
    return out;
  }

  /** 時間の経過だけを反映する（(d) の上限）。 */
  tick(nowMs: number): SegmentUnit[] {
    return this.limits(nowMs);
  }

  /** 入力終端。残りを全部出す。 */
  flush(nowMs: number): SegmentUnit[] {
    const out = this.evaluate(nowMs);
    const pending = trimUnitText(this.pending);
    if (pending.length > 0) {
      const unit = this.emit(this.text.length, "flush", endsWithPredicate(pending) ? "sentence" : "open", nowMs);
      if (unit) out.push(unit);
    }
    return out;
  }

  private setText(fullText: string, nowMs: number): void {
    const old = this.text;
    if (old === fullText) return;
    // 変わった範囲を「共通の先頭」と「共通の末尾」で挟んで特定し、cut・時刻・区切りの位置を新しい文字列へ写す。
    const max = Math.min(old.length, fullText.length);
    let prefix = 0;
    while (prefix < max && old.charCodeAt(prefix) === fullText.charCodeAt(prefix)) prefix++;
    let suffix = 0;
    while (suffix < max - prefix && old.charCodeAt(old.length - 1 - suffix) === fullText.charCodeAt(fullText.length - 1 - suffix)) suffix++;
    const oldChangedEnd = old.length - suffix;
    const newChangedEnd = fullText.length - suffix;
    const shift = fullText.length - old.length;
    const mapPos = (pos: number): number => {
      if (pos <= prefix) return pos;
      if (pos >= oldChangedEnd) return pos + shift;
      return Math.min(Math.max(pos, prefix), newChangedEnd);
    };
    if (prefix < this.cut) {
      // 訳へ回した範囲が書き換わった（空白だけの違いは数えない）。訳音声は取り消せないので位置を写すだけ。
      const before = old.slice(prefix, Math.min(this.cut, oldChangedEnd)).replace(/\s+/gu, "");
      const after = fullText.slice(prefix, Math.min(mapPos(this.cut), newChangedEnd)).replace(/\s+/gu, "");
      if (before !== after) this.revisedBeforeCutCount++;
    }
    this.cut = mapPos(this.cut);
    const times: number[] = this.times.slice(0, prefix);
    for (let i = prefix; i < newChangedEnd; i++) {
      const previous = i < oldChangedEnd ? this.times[i] : undefined;
      times.push(previous === undefined ? nowMs : Math.min(previous, nowMs));
    }
    for (let i = oldChangedEnd; i < old.length; i++) times.push(this.times[i] ?? nowMs);
    this.times = times;
    this.text = fullText;
    const marks = [...this.boundaries].map(mapPos).filter(mark => mark <= fullText.length);
    this.boundaries.clear();
    for (const mark of marks) this.boundaries.add(mark);
  }

  private start(): number {
    while (this.cut < this.text.length && LEADING_SKIP.test(this.text[this.cut] ?? "")) this.cut++;
    return this.cut;
  }

  private isBoundaryAt(q: number): { readonly delimiter: boolean; readonly mark: boolean } {
    return {
      delimiter: q < this.text.length && isDelimiter(this.text[q]),
      mark: this.boundaries.has(q),
    };
  }

  private longEnough(start: number, q: number): boolean {
    if (contentLength(this.text.slice(start, q)) >= this.config.minClauseChars) return true;
    const first = this.times[start];
    const last = this.times[q - 1];
    return first !== undefined && last !== undefined && last - first >= this.config.minClauseMs;
  }

  /** (a)/(b) で最初に切れる位置。 */
  private findCut(): Cut | null {
    const start = this.start();
    for (let q = start; q <= this.text.length; q++) {
      if (q < this.text.length && isSentenceTerminatorAt(this.text, q)) {
        let pos = q + 1;
        while (pos < this.text.length && (isCloser(this.text[pos]) || isSentenceTerminatorAt(this.text, pos))) pos++;
        return { pos, reason: "sentence", end: "sentence" };
      }
      if (q === start) continue;
      const { delimiter, mark } = this.isBoundaryAt(q);
      if (!delimiter && !mark) continue;
      const unitText = trimUnitText(this.text.slice(start, q));
      if (unitText.length === 0) continue;
      const pos = delimiter ? q + 1 : q;
      // 区切りが読点ではなく ASR item の終わり（話者の間）なら (c) として記録する。
      if (endsWithPoliteEnding(unitText)) return { pos, reason: delimiter ? "sentence" : "pause", end: "sentence" };
      if (this.config.mode === "clause" && trailingConjunctiveParticle(unitText) !== null && this.longEnough(start, q)) {
        return { pos, reason: "clause", end: "clause" };
      }
    }
    return null;
  }

  /** (d) の上限で使う「最後の安全な境界」。長さの条件は見ない。 */
  private findLastSafeCut(start: number): Cut | null {
    for (let q = this.text.length; q > start; q--) {
      const { delimiter, mark } = this.isBoundaryAt(q);
      if (!delimiter && !mark) continue;
      const unitText = trimUnitText(this.text.slice(start, q));
      if (unitText.length === 0) continue;
      const pos = delimiter ? q + 1 : q;
      if (endsWithPoliteEnding(unitText) || endsWithPredicate(unitText)) return { pos, reason: "max", end: "sentence" };
      if (trailingConjunctiveParticle(unitText) !== null) return { pos, reason: "max", end: "clause" };
    }
    return null;
  }

  /** 境界が無いまま hardMaxMs を超えたときの切断位置: 最後の区切り → 最後の格助詞の後 → 全部。 */
  private findForcedCut(start: number): number {
    for (let q = this.text.length; q > start; q--) {
      const { delimiter, mark } = this.isBoundaryAt(q);
      if ((delimiter || mark) && trimUnitText(this.text.slice(start, q)).length > 0) return delimiter ? q + 1 : q;
    }
    const particle = lastCaseParticleCut(this.text, start);
    if (particle !== null && particle > start) return particle;
    return this.text.length;
  }

  private evaluate(nowMs: number): SegmentUnit[] {
    const out: SegmentUnit[] = [];
    for (let guard = 0; guard < 1_000; guard++) {
      const cut = this.findCut();
      if (!cut) break;
      const unit = this.emit(cut.pos, cut.reason, cut.end, nowMs);
      if (unit) out.push(unit);
    }
    return out;
  }

  private limits(nowMs: number): SegmentUnit[] {
    const out: SegmentUnit[] = [];
    for (let guard = 0; guard < 1_000; guard++) {
      const start = this.start();
      if (start >= this.text.length) break;
      const elapsed = nowMs - (this.times[start] ?? nowMs);
      if (elapsed < this.config.softMaxMs) break;
      const safe = this.findLastSafeCut(start);
      if (safe) {
        const unit = this.emit(safe.pos, safe.reason, safe.end, nowMs);
        if (unit) out.push(unit);
        continue;
      }
      if (elapsed < this.config.hardMaxMs) break;
      const unit = this.emit(this.findForcedCut(start), "forced", "open", nowMs);
      if (unit) out.push(unit);
    }
    return out;
  }

  private emit(pos: number, reason: CutReason, end: UnitEnd, nowMs: number): SegmentUnit | null {
    const start = this.start();
    const target = Math.max(pos, start);
    const text = trimUnitText(this.text.slice(start, target));
    const firstCharMs = this.times[start] ?? nowMs;
    this.cut = Math.max(this.cut, target);
    if (contentLength(text) === 0) return null;
    const index = this.nextIndex++;
    return {
      segmentId: `u${index}`,
      index,
      text,
      chars: contentLength(text),
      reason,
      end,
      kind: classifyUnit(text),
      firstCharMs,
      committedMs: nowMs,
    };
  }
}
