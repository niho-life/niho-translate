/**
 * LLM の下書き（本文・種別・facts）に、コードで決定的に時刻を付けて ReferenceDocument にする。
 *
 * 1. whisper-1 の語へ対応付け（align.ts）、15 秒を超える区間は句読点で分ける
 * 2. 分けた後の本文で A/B/C/D 全系統へ対応付け直し、時刻は A（whisper-1）から
 *    A に無い区間だけ B（diarize）→ C（whisper.cpp）→ 前後からの按分の順で補い、uncertain にする
 * 3. 区間の両端が明らかな無音なら内側へ詰める（vad.ts）
 * 4. facts を本文の表記に合わせ、本文に無いものを捨てる
 * 5. 整合性チェックで修正または uncertain（validate.ts）
 */
import type { ReferenceDocument, ReferenceFact, ReferenceSegment } from "../engine.ts";
import { alignSegments, buildCharStream, placeSegments, streamText, subAlignment, type CharStream, type PlacedSegment, type SegmentAlignment, type TimedUnit } from "./align.ts";
import { GLOSSARY } from "../prompts/glossary.ts";
import { isUnresolved, SOURCE_KEYS, type Discrepancy, type DraftSegment, type SourceKey } from "./draft.ts";
import { locateInOriginal, normalizeChars, visibleLength } from "./normalize.ts";
import { trimToVoiced, type EnergyEnvelope } from "./vad.ts";
import { formatSegmentId, MAX_SEGMENT_MS, repairReference, windowDurationMs, type ValidationIssue } from "./validate.ts";

export type TimingMethod = "exact" | "lcs" | "gap" | "fallback-B" | "fallback-C" | "interpolated";

export interface SegmentReport {
  readonly id: string;
  readonly draftIndex: number;
  /** 長すぎて分けた区間の何番目か（分けていなければ null）。 */
  readonly splitPart: number | null;
  readonly timing: TimingMethod;
  readonly headUnplaced: number;
  readonly tailUnplaced: number;
  readonly trimmedStartMs: number;
  readonly trimmedEndMs: number;
  /** 区間本文の文字のうち各系統と対応した割合（系統が無ければ null）。 */
  readonly coverage: Readonly<Record<SourceKey, number | null>>;
  /** 各系統で対応した範囲の表記。 */
  readonly spans: Readonly<Record<SourceKey, string | null>>;
  readonly reasons: readonly string[];
  /** B（diarize）で最も重なる話者を、多数決の対応で原稿の話者ラベルへ写したもの。 */
  readonly diarizeSpeaker: string | null;
  readonly droppedFacts: readonly string[];
  readonly discrepancies: readonly Discrepancy[];
}

export interface BuildInput {
  readonly sourceId: string;
  readonly windowStartSec: number;
  readonly windowEndSec: number;
  readonly draft: readonly DraftSegment[];
  readonly whisperWords: readonly TimedUnit[];
  readonly diarized: readonly TimedUnit[] | null;
  readonly whisperCpp: readonly TimedUnit[] | null;
  /** 発話転記（時刻なし。speaker 付き）。 */
  readonly transcript: readonly TimedUnit[] | null;
  readonly envelope: EnergyEnvelope | null;
  readonly provenance: ReferenceDocument["provenance"];
}

export interface UncoveredRun {
  readonly source: SourceKey;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly chars: number;
  readonly text: string;
}

export interface BuildResult {
  readonly doc: ReferenceDocument;
  readonly reports: readonly SegmentReport[];
  readonly issues: readonly ValidationIssue[];
  readonly uncovered: readonly UncoveredRun[];
  readonly speakerMap: Readonly<Record<string, string>>;
  readonly droppedDraft: number;
}

/** 先頭/末尾の未対応文字がこれを超えたら時刻を信用しない。 */
function unplacedLimit(length: number): number {
  return Math.max(6, Math.ceil(length * 0.3));
}

/** 区間の目安の上限。これを超える区間は節の切れ目で分ける。 */
export const TARGET_MAX_SEGMENT_MS = 12_000;
const MIN_PART_MS = 2_000;
const SENTENCE_END = /[。？！?!．.]/u;
const COMMA = /[、，,]/u;
/** 読点の直前がこれで終わるときだけ節の切れ目とみなす（述語・接続助詞）。 */
const CLAUSE_END = /(て|で|けど|けれど|けれども|が|ので|から|し|たら|れば|ば|なら|のに|ながら|たり|って|です|ます|ました|でした|ね|よ)$/u;

/** 分けてよい位置（その文字の直後の offset）。15 秒を超えるときだけ、節の切れ目でない読点も使う。 */
function splitOffsets(text: string, anyComma: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i]!;
    if (SENTENCE_END.test(ch) || (COMMA.test(ch) && (anyComma || CLAUSE_END.test(text.slice(0, i))))) out.push(i + 1);
  }
  return out;
}

export interface Piece {
  readonly draftIndex: number;
  readonly splitPart: number | null;
  readonly text: string;
  readonly speaker: string;
  readonly kind: ReferenceSegment["kind"];
  readonly facts: readonly { readonly type: ReferenceFact["type"]; readonly text: string; readonly note: string | null }[];
  readonly uncertain: boolean;
  readonly reasons: readonly string[];
  readonly discrepancies: readonly Discrepancy[];
}

/** pairs（区間内 index → target index）から、ref index r 未満で最後の文字の終了時刻と r 以上で最初の文字の開始時刻。 */
function boundaryTimes(pairs: SegmentAlignment["pairs"], r: number, stream: CharStream): { endA: number; startB: number } | null {
  let before: number | undefined;
  let after: number | undefined;
  for (const [ri, ti] of pairs) {
    if (ri < r) before = ti;
    else if (after === undefined) after = ti;
  }
  if (before === undefined || after === undefined) return null;
  return { endA: stream.endMs[before]!, startB: stream.startMs[after]! };
}

/**
 * 12 秒を超える区間を、時間の釣り合う節の切れ目（文末、または述語・接続助詞の後の読点）の直後で再帰的に分ける。
 * 15 秒を超えて節の切れ目が無ければ任意の読点で分ける。各部分は 2 秒以上。facts の途中では切らない。
 */
export function splitLongPiece(piece: Piece, alignment: SegmentAlignment, placed: PlacedSegment, stream: CharStream): Piece[] {
  if (placed.startMs === null || placed.endMs === null || placed.endMs - placed.startMs <= TARGET_MAX_SEGMENT_MS) return [piece];
  if (alignment.method === "none" || alignment.pairs.length === 0) return [piece];
  const first = choosePieceSplit(piece, alignment, placed, stream, false);
  const chosen = first ?? (placed.endMs - placed.startMs > MAX_SEGMENT_MS ? choosePieceSplit(piece, alignment, placed, stream, true) : null);
  if (chosen === null) return [piece];
  return applyPieceSplit(piece, alignment, placed, stream, chosen);
}

interface SplitChoice {
  readonly offset: number;
  readonly r: number;
  readonly endA: number;
  readonly startB: number;
}

function choosePieceSplit(piece: Piece, alignment: SegmentAlignment, placed: PlacedSegment, stream: CharStream, anyComma: boolean): SplitChoice | null {
  if (placed.startMs === null || placed.endMs === null) return null;
  const norm = normalizeChars(piece.text);
  const factRanges: Array<[number, number]> = [];
  for (const f of piece.facts) {
    const at = piece.text.indexOf(f.text);
    if (at >= 0) factRanges.push([at, at + f.text.length]);
  }
  let best: (SplitChoice & { score: number }) | null = null;
  for (const offset of splitOffsets(piece.text, anyComma)) {
    if (factRanges.some(([a, b]) => offset > a && offset < b)) continue;
    let r = 0;
    while (r < norm.origin.length && norm.origin[r]! < offset) r++;
    if (r < 2 || norm.cps.length - r < 2) continue;
    const times = boundaryTimes(alignment.pairs, r, stream);
    if (times === null) continue;
    const durA = times.endA - placed.startMs;
    const durB = placed.endMs - times.startB;
    if (durA < MIN_PART_MS || durB < MIN_PART_MS) continue;
    const score = Math.max(durA, durB);
    if (best === null || score < best.score) best = { offset, r, ...times, score };
  }
  return best;
}

function applyPieceSplit(piece: Piece, alignment: SegmentAlignment, placed: PlacedSegment, stream: CharStream, chosen: SplitChoice): Piece[] {
  const norm = normalizeChars(piece.text);
  const textA = piece.text.slice(0, chosen.offset).trim();
  const textB = piece.text.slice(chosen.offset).trim();
  const factsA = piece.facts.filter(f => textA.includes(f.text));
  const factsB = piece.facts.filter(f => !textA.includes(f.text));
  const reasons = piece.reasons;
  const a: Piece = { ...piece, text: textA, kind: piece.kind === "question" ? "statement" : piece.kind, facts: factsA, reasons };
  const b: Piece = { ...piece, text: textB, facts: factsB, reasons, discrepancies: [] };
  const pairsA = alignment.pairs.filter(([ri]) => ri < chosen.r);
  const pairsB = alignment.pairs.filter(([ri]) => ri >= chosen.r).map(([ri, ti]) => [ri - chosen.r, ti] as const);
  const alignA = subAlignment(alignment, norm.cps.slice(0, chosen.r), pairsA);
  const alignB = subAlignment(alignment, norm.cps.slice(chosen.r), pairsB);
  const placedA: PlacedSegment = { ...placed, endMs: chosen.endA };
  const placedB: PlacedSegment = { ...placed, startMs: chosen.startB };
  const parts = [...splitLongPiece(a, alignA, placedA, stream), ...splitLongPiece(b, alignB, placedB, stream)];
  return parts.map((p, idx) => ({ ...p, splitPart: idx }));
}

function placedTimes(placed: PlacedSegment | undefined): { startMs: number; endMs: number } | null {
  if (placed === undefined || placed.startMs === null || placed.endMs === null) return null;
  return { startMs: placed.startMs, endMs: placed.endMs };
}

/** 系統ごとに、どの区間にも割り当てられなかった連続 minChars 文字以上の範囲。 */
function uncoveredRuns(source: SourceKey, stream: CharStream, placed: readonly PlacedSegment[], minChars: number, skipEdges: boolean, timed: boolean): UncoveredRun[] {
  const covered = new Uint8Array(stream.cps.length);
  for (const p of placed) {
    if (p.tFrom < 0) continue;
    for (let t = p.tFrom; t <= p.tTo; t++) covered[t] = 1;
  }
  const runs: UncoveredRun[] = [];
  let t = 0;
  while (t < covered.length) {
    if (covered[t] === 1) {
      t++;
      continue;
    }
    const from = t;
    while (t < covered.length && covered[t] === 0) t++;
    const to = t - 1;
    if (to - from + 1 < minChars) continue;
    if (skipEdges && (from === 0 || to === covered.length - 1)) continue;
    runs.push({
      source,
      startMs: timed ? Math.round(stream.startMs[from]!) : null,
      endMs: timed ? Math.round(stream.endMs[to]!) : null,
      chars: to - from + 1,
      text: streamText(stream, from, to, { joiner: source === "A" ? "" : " ", labelSpeakers: source === "B" || source === "D" }),
    });
  }
  return runs;
}

/**
 * 地名の型をそろえる: window 内のどこかで place とされた語、または用語集の地名と同じ proper_noun は place にする。
 */
export function harmonizePlaceFacts(segments: readonly ReferenceSegment[], knownPlaces: readonly string[]): ReferenceSegment[] {
  const places = new Set(knownPlaces);
  for (const s of segments) for (const f of s.facts) if (f.type === "place") places.add(f.text);
  return segments.map(s => {
    if (!s.facts.some(f => f.type === "proper_noun" && places.has(f.text))) return s;
    const seen = new Set<string>();
    const facts: ReferenceFact[] = [];
    for (const f of s.facts) {
      const fixed = f.type === "proper_noun" && places.has(f.text) ? { ...f, type: "place" as const } : f;
      const key = `${fixed.type}\u0000${fixed.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fixed);
    }
    return { ...s, facts };
  });
}

/**
 * B（diarize）の話者ラベルを原稿の話者ラベルへ写す。重なり時間の合計が最大になる 1 対 1 の対応
 * （B のラベルの方が多ければ各ラベルを最も重なる原稿ラベルへ）。区間ごとに、半分以上重なる B の話者を写したものを返す。
 */
export function mapSpeakers(segments: ReadonlyArray<Pick<ReferenceSegment, "startMs" | "endMs" | "speaker">>, diarized: readonly TimedUnit[]): { map: Record<string, string>; perSegment: Array<string | null> } {
  const overlaps = segments.map(s => {
    const byLabel = new Map<string, number>();
    for (const u of diarized) {
      if (u.speaker === undefined) continue;
      const ov = Math.min(s.endMs, u.endMs) - Math.max(s.startMs, u.startMs);
      if (ov > 0) byLabel.set(u.speaker, (byLabel.get(u.speaker) ?? 0) + ov);
    }
    return byLabel;
  });
  const dLabels = [...new Set(diarized.map(u => u.speaker).filter((x): x is string => x !== undefined))].sort();
  const fLabels = [...new Set(segments.map(s => s.speaker))].sort();
  const weight = (d: string, f: string): number => segments.reduce((sum, s, i) => sum + (s.speaker === f ? (overlaps[i]!.get(d) ?? 0) : 0), 0);
  const map: Record<string, string> = {};
  if (dLabels.length > 0 && fLabels.length > 0) {
    if (dLabels.length <= fLabels.length) {
      let best = -1;
      let bestPick: string[] = [];
      const search = (i: number, used: Set<string>, pick: string[], score: number): void => {
        if (i === dLabels.length) {
          if (score > best) {
            best = score;
            bestPick = [...pick];
          }
          return;
        }
        for (const f of fLabels) {
          if (used.has(f)) continue;
          used.add(f);
          pick.push(f);
          search(i + 1, used, pick, score + weight(dLabels[i]!, f));
          pick.pop();
          used.delete(f);
        }
      };
      search(0, new Set(), [], 0);
      dLabels.forEach((d, i) => {
        map[d] = bestPick[i]!;
      });
    } else {
      for (const d of dLabels) map[d] = [...fLabels].sort((a, b) => weight(d, b) - weight(d, a) || a.localeCompare(b))[0]!;
    }
  }
  const perSegment = segments.map((s, i) => {
    let label: string | null = null;
    let most = 0;
    for (const [d, ov] of overlaps[i]!) {
      if (ov > most) {
        most = ov;
        label = d;
      }
    }
    return label !== null && most >= 0.5 * Math.max(1, s.endMs - s.startMs) ? map[label] ?? label : null;
  });
  return { map, perSegment };
}

export function buildReference(input: BuildInput): BuildResult {
  const durationMs = windowDurationMs(input);
  const kept = input.draft.map((s, i) => ({ s, i })).filter(({ s }) => visibleLength(s.text) > 0);
  const droppedDraft = input.draft.length - kept.length;
  const streamA = buildCharStream(input.whisperWords);

  // 1) whisper-1 で時刻を仮に決め、長すぎる区間を分ける。
  const firstAlign = alignSegments(kept.map(k => k.s.text), streamA.cps);
  const firstPlaced = placeSegments(firstAlign, streamA);
  const pieces: Piece[] = [];
  kept.forEach(({ s, i }, k) => {
    const piece: Piece = {
      draftIndex: i,
      splitPart: null,
      text: s.text,
      speaker: s.speaker,
      kind: s.kind,
      facts: s.facts,
      // 見直しの判断があればそれを優先し、無ければ LLM の判断と食い違いの支持で決める。
      uncertain: s.review !== undefined ? s.review.decision === "uncertain" : s.uncertain || s.discrepancies.some(isUnresolved),
      reasons: [
        ...(s.uncertain ? [`llm: ${s.uncertainReason ?? "(no reason)"}`] : []),
        ...s.discrepancies.filter(isUnresolved).map(d => `text: ${d.category} not settled (support ${d.support.join("") || "none"} vs rival ${d.rivalSupport})`),
        ...(s.review !== undefined ? [`review: ${s.review.decision} — ${s.review.note}`] : []),
      ],
      discrepancies: s.discrepancies,
    };
    pieces.push(...splitLongPiece(piece, firstAlign[k]!, firstPlaced[k]!, streamA));
  });

  // 2) 分けた後の本文で全系統へ対応付ける。
  const texts = pieces.map(p => p.text);
  const streams: Record<SourceKey, CharStream | null> = {
    A: streamA,
    B: input.diarized !== null ? buildCharStream(input.diarized) : null,
    C: input.whisperCpp !== null ? buildCharStream(input.whisperCpp) : null,
    D: input.transcript !== null ? buildCharStream(input.transcript) : null,
  };
  const aligns = {} as Record<SourceKey, SegmentAlignment[] | null>;
  const placed = {} as Record<SourceKey, PlacedSegment[] | null>;
  for (const key of SOURCE_KEYS) {
    const stream = streams[key];
    aligns[key] = stream !== null ? alignSegments(texts, stream.cps) : null;
    placed[key] = stream !== null ? placeSegments(aligns[key]!, stream) : null;
  }
  const placedA = placed.A!;

  // 3) 時刻: A → B → C → 按分。
  const times: Array<{ startMs: number; endMs: number } | null> = pieces.map((_, k) => placedTimes(placedA[k]));
  const timing: TimingMethod[] = pieces.map((_, k) => {
    const m = placedA[k]!.method;
    return m === "none" ? "interpolated" : m;
  });
  const anchorTimes = times.slice();
  const neighbourBounds = (k: number): { lo: number; hi: number } => {
    let lo = 0;
    for (let j = k - 1; j >= 0; j--) {
      const t = anchorTimes[j];
      if (t !== null && t !== undefined) {
        lo = t.endMs;
        break;
      }
    }
    let hi = durationMs;
    for (let j = k + 1; j < pieces.length; j++) {
      const t = anchorTimes[j];
      if (t !== null && t !== undefined) {
        hi = t.startMs;
        break;
      }
    }
    return { lo, hi };
  };
  pieces.forEach((_, k) => {
    if (times[k] !== null) return;
    const { lo, hi } = neighbourBounds(k);
    for (const key of ["B", "C"] as const) {
      const candidate = placedTimes(placed[key]?.[k]);
      if (candidate === null) continue;
      const startMs = Math.max(candidate.startMs, lo);
      const endMs = Math.min(candidate.endMs, hi);
      if (endMs - startMs >= 200) {
        times[k] = { startMs, endMs };
        timing[k] = key === "B" ? "fallback-B" : "fallback-C";
        return;
      }
    }
  });
  // 残りは前後の時刻の間を文字数で按分。
  let k = 0;
  while (k < pieces.length) {
    if (times[k] !== null) {
      k++;
      continue;
    }
    const from = k;
    while (k < pieces.length && times[k] === null) k++;
    const lo = from > 0 ? times[from - 1]!.endMs : 0;
    const hi = k < pieces.length ? times[k]!.startMs : durationMs;
    const weights = pieces.slice(from, k).map(p => Math.max(1, visibleLength(p.text)));
    const total = weights.reduce((a, b) => a + b, 0);
    let cursor = lo;
    for (let j = from; j < k; j++) {
      const span = Math.max(0, hi - lo) * (weights[j - from]! / total);
      times[j] = { startMs: cursor, endMs: cursor + span };
      timing[j] = "interpolated";
      cursor += span;
    }
  }

  // 4) 無音を詰め、facts を本文に合わせ、uncertain を決める。
  const mapped: ReferenceSegment[] = [];
  const reportsBase: Array<Omit<SegmentReport, "id" | "diarizeSpeaker">> = [];
  pieces.forEach((piece, k) => {
    let { startMs, endMs } = times[k]!;
    let trimmedStartMs = 0;
    let trimmedEndMs = 0;
    const length = visibleLength(piece.text);
    const reasons = [...piece.reasons];
    let uncertain = piece.uncertain;
    if (input.envelope !== null) {
      const trimmed = trimToVoiced(startMs, endMs, input.envelope);
      ({ startMs, endMs, trimmedStartMs, trimmedEndMs } = trimmed);
      if (trimmed.allSilent) {
        uncertain = true;
        reasons.push("timing: the whole segment lies in silence");
      } else if (trimmed.longSilenceAtStart || trimmed.longSilenceAtEnd) {
        uncertain = true;
        reasons.push(`timing: over 3 s of silence at the ${trimmed.longSilenceAtStart ? "start" : "end"}`);
      }
    }
    if (timing[k] === "fallback-B" || timing[k] === "fallback-C" || timing[k] === "interpolated") {
      uncertain = true;
      reasons.push(`timing: ${timing[k]} (not found in whisper-1)`);
    }
    const pa = placedA[k]!;
    const limit = unplacedLimit(length);
    if (pa.method !== "none" && pa.headUnplaced > limit) {
      uncertain = true;
      reasons.push(`timing: head ${pa.headUnplaced} chars not found in whisper-1`);
    }
    if (pa.method !== "none" && pa.tailUnplaced > limit) {
      uncertain = true;
      reasons.push(`timing: tail ${pa.tailUnplaced} chars not found in whisper-1`);
    }
    const coverage = {} as Record<SourceKey, number | null>;
    const spans = {} as Record<SourceKey, string | null>;
    for (const key of SOURCE_KEYS) {
      const a = aligns[key]?.[k];
      const stream = streams[key];
      const p = placed[key]?.[k];
      coverage[key] = a !== undefined && length > 0 ? a.matched / length : null;
      spans[key] = stream !== null && p !== undefined && p.tFrom >= 0
        ? streamText(stream, p.tFrom, p.tTo, { joiner: key === "A" ? "" : " ", labelSpeakers: key === "B" || key === "D" })
        : stream !== null ? "" : null;
    }
    const best = Math.max(...SOURCE_KEYS.map(key => coverage[key] ?? 0));
    if (length >= 4 && best < 0.5) {
      uncertain = true;
      reasons.push(`text: weakly supported by sources (best ${best.toFixed(2)})`);
    }
    const facts: ReferenceFact[] = [];
    const droppedFacts: string[] = [];
    const seen = new Set<string>();
    for (const f of piece.facts) {
      const located = locateInOriginal(piece.text, f.text.trim());
      if (located === null || located.trim().length === 0) {
        droppedFacts.push(`${f.type}:${f.text}`);
        continue;
      }
      const key = `${f.type}\u0000${located}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(f.note !== null && f.note.trim().length > 0 ? { type: f.type, text: located, note: f.note.trim() } : { type: f.type, text: located });
    }
    const base = { id: formatSegmentId(k + 1), startMs: Math.round(startMs), endMs: Math.round(endMs), speaker: piece.speaker, text: piece.text, kind: piece.kind, facts };
    mapped.push(uncertain ? { ...base, uncertain: true } : base);
    reportsBase.push({
      draftIndex: piece.draftIndex,
      splitPart: piece.splitPart,
      timing: timing[k]!,
      headUnplaced: pa.method !== "none" ? pa.headUnplaced : length,
      tailUnplaced: pa.method !== "none" ? pa.tailUnplaced : 0,
      trimmedStartMs,
      trimmedEndMs,
      coverage,
      spans,
      reasons,
      droppedFacts,
      discrepancies: piece.discrepancies,
    });
  });

  // 5) 地名の型をそろえ、整合性チェック。
  const repaired = repairReference({
    sourceId: input.sourceId,
    language: "ja",
    windowStartSec: input.windowStartSec,
    windowEndSec: input.windowEndSec,
    segments: harmonizePlaceFacts(mapped, GLOSSARY.filter(g => g.kind === "place").map(g => g.ja)),
    provenance: input.provenance,
  });
  if (repaired.doc.segments.length !== mapped.length) throw new Error("internal: repair dropped segments after filtering");

  // 6) 話者: B の話者ラベルを原稿のラベルへ 1 対 1 で写し、区間ごとに比べる。
  const speakers = mapSpeakers(repaired.doc.segments, input.diarized ?? []);
  const speakerMap = speakers.map;

  const issuesById = new Map<string, ValidationIssue[]>();
  for (const issue of repaired.issues) issuesById.set(issue.id, [...(issuesById.get(issue.id) ?? []), issue]);
  const reports: SegmentReport[] = repaired.doc.segments.map((s, i) => {
    const base = reportsBase[i]!;
    const diarizeSpeaker = speakers.perSegment[i] ?? null;
    const extra = (issuesById.get(s.id) ?? []).map(issue => `check: ${issue.code} ${issue.action}${issue.detail !== undefined ? ` (${issue.detail})` : ""}`);
    return {
      ...base,
      id: s.id,
      reasons: [...base.reasons, ...extra],
      diarizeSpeaker,
    };
  });

  const uncovered: UncoveredRun[] = [];
  for (const key of SOURCE_KEYS) {
    const stream = streams[key];
    const p = placed[key];
    if (stream === null || p === null) continue;
    uncovered.push(...uncoveredRuns(key, stream, p, 6, key === "D", key !== "D"));
  }

  return { doc: repaired.doc, reports, issues: repaired.issues, uncovered, speakerMap, droppedDraft };
}
