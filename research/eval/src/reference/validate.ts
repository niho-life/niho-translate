/**
 * 正解原稿の整合性チェック（純関数）。
 * - id は s001 形式の連番
 * - 時刻は整数 ms で window 内、終了 > 開始、開始は単調（非減少）
 * - 区間どうしの重なりは 300 ms 以内
 * - 区間長は 15 秒以内
 * - backchannel 以外の本文は 2 文字以上（空白・句読点を除く）
 * 違反は修正するか、修正できないもの（話者の違う重なり・長すぎ・短すぎ）は uncertain にする。
 */
import type { FactType, ReferenceDocument, ReferenceFact, ReferenceSegment } from "../engine.ts";
import { normalizeForMatch, visibleLength } from "./normalize.ts";

export const MAX_OVERLAP_MS = 300;
export const MAX_SEGMENT_MS = 15_000;
export const MIN_TEXT_CHARS = 2;
/** 区間を作り直すときの最小の長さ（修正で使う）。 */
const MIN_REPAIR_MS = 200;

// Record にしておくと engine.ts の型が増えたときに型検査で気づける。
const FACT_TYPE_KEYS: Readonly<Record<FactType, true>> = { number: true, time: true, amount: true, negation: true, place: true, legal_right: true, proper_noun: true, condition: true, subject: true, tense: true };
const KIND_KEYS: Readonly<Record<ReferenceSegment["kind"], true>> = { statement: true, question: true, backchannel: true, fragment: true };
export const FACT_TYPES = Object.keys(FACT_TYPE_KEYS) as readonly FactType[];
export const SEGMENT_KINDS = Object.keys(KIND_KEYS) as ReadonlyArray<ReferenceSegment["kind"]>;

/** 1 文字でも相づちとして扱う語（正規化後）。 */
const ONE_CHAR_BACKCHANNELS = new Set(["え", "あ", "ん", "お", "う", "ね", "へ", "ほ"].map(normalizeForMatch));

export type IssueCode =
  | "empty_text"
  | "id_sequence"
  | "invalid_time"
  | "non_positive_duration"
  | "non_monotonic_start"
  | "overlap"
  | "too_long"
  | "too_short_text"
  | "invalid_kind"
  | "fact_invalid";

/** uncertain にすれば残してよい違反。 */
export const TOLERATED_IF_UNCERTAIN: ReadonlySet<IssueCode> = new Set<IssueCode>(["overlap", "too_long", "too_short_text"]);

export interface Violation {
  readonly index: number;
  readonly id: string;
  readonly code: IssueCode;
  /** overlap の相手。 */
  readonly otherIndex?: number;
  /** uncertain なので許容される違反か。 */
  readonly tolerated: boolean;
}

export interface ValidationIssue {
  readonly id: string;
  readonly code: IssueCode;
  readonly action: "fixed" | "uncertain" | "dropped";
  readonly detail?: string;
}

export function formatSegmentId(n: number): string {
  return `s${String(n).padStart(3, "0")}`;
}

export function windowDurationMs(doc: Pick<ReferenceDocument, "windowStartSec" | "windowEndSec">): number {
  return Math.round((doc.windowEndSec - doc.windowStartSec) * 1000);
}

/** 違反の一覧（修正しない）。 */
export function checkReference(doc: ReferenceDocument): Violation[] {
  const out: Violation[] = [];
  const dur = windowDurationMs(doc);
  const segs = doc.segments;
  const push = (index: number, code: IssueCode, otherIndex?: number): void => {
    const s = segs[index]!;
    const other = otherIndex !== undefined ? segs[otherIndex] : undefined;
    const tolerated = TOLERATED_IF_UNCERTAIN.has(code) && (s.uncertain === true || other?.uncertain === true);
    out.push(otherIndex !== undefined ? { index, id: s.id, code, otherIndex, tolerated } : { index, id: s.id, code, tolerated });
  };
  segs.forEach((s, i) => {
    if (s.id !== formatSegmentId(i + 1)) push(i, "id_sequence");
    const validTimes = Number.isInteger(s.startMs) && Number.isInteger(s.endMs) && s.startMs >= 0 && s.endMs <= dur;
    if (!validTimes) push(i, "invalid_time");
    if (!(s.endMs > s.startMs)) push(i, "non_positive_duration");
    if (i > 0 && s.startMs < segs[i - 1]!.startMs) push(i, "non_monotonic_start");
    for (let j = 0; j < i; j++) {
      if (segs[j]!.endMs - s.startMs > MAX_OVERLAP_MS) push(i, "overlap", j);
    }
    if (s.endMs - s.startMs > MAX_SEGMENT_MS) push(i, "too_long");
    const length = visibleLength(s.text);
    if (length === 0) push(i, "empty_text");
    else if (s.kind !== "backchannel" && length < MIN_TEXT_CHARS) push(i, "too_short_text");
    if (!SEGMENT_KINDS.includes(s.kind)) push(i, "invalid_kind");
    if (s.facts.some(f => !FACT_TYPES.includes(f.type) || f.text.trim().length === 0)) push(i, "fact_invalid");
  });
  return out;
}

interface MutableSegment {
  id: string;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  kind: ReferenceSegment["kind"];
  facts: ReferenceFact[];
  uncertain: boolean;
}

/**
 * 違反を直す。直せないものは uncertain にする。返す doc は checkReference の違反が
 * すべて tolerated になる。
 */
export function repairReference(doc: ReferenceDocument): { doc: ReferenceDocument; issues: ValidationIssue[] } {
  const dur = windowDurationMs(doc);
  const issues: ValidationIssue[] = [];
  const kept = doc.segments.filter(s => {
    if (visibleLength(s.text) > 0) return true;
    issues.push({ id: s.id, code: "empty_text", action: "dropped" });
    return false;
  });
  const segs: MutableSegment[] = kept.map(s => ({
    id: s.id,
    startMs: s.startMs,
    endMs: s.endMs,
    speaker: s.speaker,
    text: s.text,
    kind: s.kind,
    facts: [...s.facts],
    uncertain: s.uncertain === true,
  }));

  segs.forEach((s, i) => {
    const id = formatSegmentId(i + 1);
    if (s.id !== id) {
      issues.push({ id, code: "id_sequence", action: "fixed", detail: `${s.id}->${id}` });
      s.id = id;
    }
  });

  const markUncertain = (s: MutableSegment, code: IssueCode, detail?: string): void => {
    s.uncertain = true;
    issues.push(detail !== undefined ? { id: s.id, code, action: "uncertain", detail } : { id: s.id, code, action: "uncertain" });
  };

  segs.forEach((s, i) => {
    const prev = i > 0 ? segs[i - 1]! : undefined;
    if (!SEGMENT_KINDS.includes(s.kind)) {
      issues.push({ id: s.id, code: "invalid_kind", action: "fixed", detail: `${String(s.kind)}->fragment` });
      s.kind = "fragment";
      s.uncertain = true;
    }
    // 時刻: 有限・整数・window 内。
    if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) {
      const base = prev?.endMs ?? 0;
      s.startMs = Math.min(base, Math.max(0, dur - MIN_REPAIR_MS));
      s.endMs = Math.min(dur, s.startMs + MIN_REPAIR_MS);
      markUncertain(s, "invalid_time", "not finite");
    } else {
      const start = Math.min(dur, Math.max(0, Math.round(s.startMs)));
      const end = Math.min(dur, Math.max(0, Math.round(s.endMs)));
      if (start !== s.startMs || end !== s.endMs) {
        const outside = s.startMs < 0 || s.endMs > dur || s.startMs > dur || s.endMs < 0;
        if (outside) issues.push({ id: s.id, code: "invalid_time", action: "fixed", detail: "clamped to window" });
        s.startMs = start;
        s.endMs = end;
      }
    }
    if (s.endMs <= s.startMs) {
      if (s.startMs > dur - MIN_REPAIR_MS) s.startMs = Math.max(0, dur - MIN_REPAIR_MS);
      s.endMs = Math.min(dur, s.startMs + MIN_REPAIR_MS);
      markUncertain(s, "non_positive_duration");
    }
    if (prev !== undefined && s.startMs < prev.startMs) {
      s.startMs = prev.startMs;
      if (s.endMs <= s.startMs) s.endMs = Math.min(dur, s.startMs + MIN_REPAIR_MS);
      markUncertain(s, "non_monotonic_start");
    }
    // 重なり: 同じ話者なら前の区間の終わりを詰める。話者が違えば（相づち優先で）uncertain。
    for (let j = 0; j < i; j++) {
      const other = segs[j]!;
      if (other.endMs - s.startMs <= MAX_OVERLAP_MS) continue;
      if (other.speaker === s.speaker && s.startMs - other.startMs >= MIN_REPAIR_MS) {
        issues.push({ id: other.id, code: "overlap", action: "fixed", detail: `end trimmed to next ${s.id}` });
        other.endMs = s.startMs;
        continue;
      }
      if (other.uncertain || s.uncertain) continue;
      const target = other.kind === "backchannel" && s.kind !== "backchannel" ? other : s;
      markUncertain(target, "overlap", `with ${target === s ? other.id : s.id}`);
    }
    if (s.endMs - s.startMs > MAX_SEGMENT_MS && !s.uncertain) markUncertain(s, "too_long");
    else if (s.endMs - s.startMs > MAX_SEGMENT_MS) issues.push({ id: s.id, code: "too_long", action: "uncertain" });
    if (s.kind !== "backchannel" && visibleLength(s.text) < MIN_TEXT_CHARS) {
      if (ONE_CHAR_BACKCHANNELS.has(normalizeForMatch(s.text))) {
        issues.push({ id: s.id, code: "too_short_text", action: "fixed", detail: `${s.kind}->backchannel` });
        s.kind = "backchannel";
      } else {
        markUncertain(s, "too_short_text");
      }
    }
    const facts = s.facts.filter(f => FACT_TYPES.includes(f.type) && f.text.trim().length > 0);
    if (facts.length !== s.facts.length) {
      issues.push({ id: s.id, code: "fact_invalid", action: "fixed", detail: `dropped ${s.facts.length - facts.length}` });
      s.facts = facts;
    }
  });

  const segments: ReferenceSegment[] = segs.map(s => {
    const base = { id: s.id, startMs: s.startMs, endMs: s.endMs, speaker: s.speaker, text: s.text, kind: s.kind, facts: s.facts };
    return s.uncertain ? { ...base, uncertain: true } : base;
  });
  return { doc: { ...doc, segments }, issues };
}
