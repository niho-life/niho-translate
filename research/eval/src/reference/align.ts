/**
 * 語→時刻の決定的な対応付け。
 *
 * 1. ASR の語（whisper-1 の word、または区間）を正規化文字の列（CharStream）にし、
 *    各文字へ語の時刻を文字数で按分した時刻を持たせる。
 * 2. 原稿の区間本文（正規化）を、まず完全一致（一意・位置が妥当・8 文字以上）で錨にし、
 *    錨の間を最長共通部分列（LCS）で対応付ける。LCS は 2 文字以上連続した一致だけを残し、
 *    区間ごとに主な塊から離れた一致を外れ値として捨てる。
 * 3. 区間の先頭/末尾の文字が ASR 側に無い（言い直し・固有名詞の訂正など）ときは、
 *    隣の区間との間に残った ASR 文字を、未対応の文字数の比で前後の区間へ配る。
 */
import { findAll, normalizeChars } from "./normalize.ts";

export interface TimedUnit {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker?: string;
}

export interface CharStream {
  readonly cps: readonly number[];
  readonly startMs: readonly number[];
  readonly endMs: readonly number[];
  /** 文字の元になった unit の index。 */
  readonly unit: readonly number[];
  /** unit.text 内の UTF-16 offset（開始・終了 exclusive）。 */
  readonly offset: readonly number[];
  readonly offsetEnd: readonly number[];
  readonly units: readonly TimedUnit[];
}

export function buildCharStream(units: readonly TimedUnit[]): CharStream {
  const cps: number[] = [];
  const startMs: number[] = [];
  const endMs: number[] = [];
  const unit: number[] = [];
  const offset: number[] = [];
  const offsetEnd: number[] = [];
  let lastStart = Number.NEGATIVE_INFINITY;
  units.forEach((u, ui) => {
    const norm = normalizeChars(u.text);
    const k = norm.cps.length;
    if (k === 0) return;
    const s = Math.max(u.startMs, lastStart);
    const e = Math.max(u.endMs, s);
    for (let j = 0; j < k; j++) {
      cps.push(norm.cps[j]!);
      startMs.push(s + ((e - s) * j) / k);
      endMs.push(s + ((e - s) * (j + 1)) / k);
      unit.push(ui);
      offset.push(norm.origin[j]!);
      offsetEnd.push(norm.originEnd[j]!);
    }
    lastStart = s;
  });
  return { cps, startMs, endMs, unit, offset, offsetEnd, units };
}

/** stream の文字 first..last（inclusive）に当たる元の表記を返す。 */
export function streamText(stream: CharStream, first: number, last: number, options: { joiner?: string; labelSpeakers?: boolean } = {}): string {
  if (first < 0 || last < first || last >= stream.cps.length) return "";
  const joiner = options.joiner ?? "";
  const u0 = stream.unit[first]!;
  const u1 = stream.unit[last]!;
  const parts: string[] = [];
  let lastSpeaker: string | undefined;
  for (let u = u0; u <= u1; u++) {
    const unitValue = stream.units[u]!;
    const from = u === u0 ? stream.offset[first]! : 0;
    const to = u === u1 ? stream.offsetEnd[last]! : unitValue.text.length;
    let piece = unitValue.text.slice(from, to);
    if (options.labelSpeakers && unitValue.speaker !== undefined && unitValue.speaker !== lastSpeaker) {
      piece = `[${unitValue.speaker}] ${piece}`;
      lastSpeaker = unitValue.speaker;
    }
    parts.push(piece);
  }
  return parts.join(joiner).trim();
}

const MAX_LCS_CELLS = 64_000_000;

/**
 * 連続一致を優先する最長共通部分列の対応（a の index, b の index）。両方とも単調増加。
 * 一致 1 文字 = 1 点、直前も一致（両辺で連続）なら 2 点。同点の一致が複数あるとき（文末の「ます」など）
 * 遠くの同じ文字より連続した側を選ぶ。
 */
export function lcsPairs(a: readonly number[], b: readonly number[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const width = m + 1;
  const cells = (n + 1) * width;
  if (cells > MAX_LCS_CELLS) throw new Error(`lcs too large: ${n}x${m}`);
  const big = Math.min(n, m) >= 32_000;
  // best: 接頭辞どうしの最高点。run: (i-1, j-1) を一致で終える最高点（0 = 一致でない）。
  const best = big ? new Uint32Array(cells) : new Uint16Array(cells);
  const run = big ? new Uint32Array(cells) : new Uint16Array(cells);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const row = i * width;
    const prev = (i - 1) * width;
    for (let j = 1; j <= m; j++) {
      const up = best[prev + j]!;
      const left = best[row + j - 1]!;
      let value = up >= left ? up : left;
      if (ai === b[j - 1]) {
        const fresh = best[prev + j - 1]! + 1;
        const before = run[prev + j - 1]!;
        const extend = before > 0 ? before + 2 : 0;
        const r = fresh >= extend ? fresh : extend;
        run[row + j] = r;
        if (r >= value) value = r;
      }
      best[row + j] = value;
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  let inRun = false;
  while (i > 0 && j > 0) {
    const idx = i * width + j;
    if (!inRun) {
      if (run[idx]! > 0 && run[idx] === best[idx]) {
        inRun = true;
        continue;
      }
      if (best[(i - 1) * width + j] === best[idx]) i--;
      else j--;
      continue;
    }
    pairs.push([i - 1, j - 1]);
    const p = (i - 1) * width + (j - 1);
    inRun = run[p]! > 0 && run[idx] === run[p]! + 2;
    i--;
    j--;
  }
  pairs.reverse();
  return pairs;
}

interface Run {
  readonly start: number; // index into pairs
  readonly end: number; // inclusive
}

function splitRuns(pairs: ReadonlyArray<readonly [number, number]>): Run[] {
  const runs: Run[] = [];
  let start = 0;
  for (let k = 1; k <= pairs.length; k++) {
    const prev = pairs[k - 1]!;
    const cur = pairs[k];
    if (cur === undefined || cur[0] !== prev[0] + 1 || cur[1] !== prev[1] + 1) {
      runs.push({ start, end: k - 1 });
      start = k;
    }
  }
  return runs;
}

/** 両辺で連続した一致が minRun 文字以上の部分だけを残す。 */
export function filterRuns(pairs: ReadonlyArray<readonly [number, number]>, minRun: number): Array<[number, number]> {
  if (pairs.length === 0) return [];
  const out: Array<[number, number]> = [];
  for (const run of splitRuns(pairs)) {
    if (run.end - run.start + 1 < minRun) continue;
    for (let k = run.start; k <= run.end; k++) out.push([pairs[k]![0], pairs[k]![1]]);
  }
  return out;
}

/**
 * 1 区間の対応から、最長の塊に連なる塊だけを残す（間隔が釣り合わない塊は外れ値）。
 * 塊どうしの ASR 側の隙間は、原稿側の隙間の 2 倍 + 12 文字まで許す。
 */
export function clusterPairs(pairs: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  if (pairs.length === 0) return [];
  const runs = splitRuns(pairs);
  let main = 0;
  for (let r = 1; r < runs.length; r++) {
    if (runs[r]!.end - runs[r]!.start > runs[main]!.end - runs[main]!.start) main = r;
  }
  const fits = (left: Run, right: Run): boolean => {
    const refGap = pairs[right.start]![0] - pairs[left.end]![0] - 1;
    const tGap = pairs[right.start]![1] - pairs[left.end]![1] - 1;
    return tGap <= 2 * refGap + 12;
  };
  let lo = main;
  while (lo > 0 && fits(runs[lo - 1]!, runs[lo]!)) lo--;
  let hi = main;
  while (hi < runs.length - 1 && fits(runs[hi]!, runs[hi + 1]!)) hi++;
  const out: Array<[number, number]> = [];
  for (let k = runs[lo]!.start; k <= runs[hi]!.end; k++) out.push([pairs[k]![0], pairs[k]![1]]);
  return out;
}

export type AlignMethod = "exact" | "lcs" | "none";

export interface SegmentAlignment {
  readonly method: AlignMethod;
  /** 区間本文の正規化後の文字（code point）。 */
  readonly cps: readonly number[];
  /** 区間本文の正規化後の文字数。 */
  readonly length: number;
  /** [区間内の正規化文字 index, target の文字 index]。 */
  readonly pairs: ReadonlyArray<readonly [number, number]>;
  /** 対応した target 文字の最初と最後（無ければ -1）。 */
  readonly first: number;
  readonly last: number;
  /** 対応した区間側の最初と最後の文字（無ければ -1）。 */
  readonly refFirst: number;
  readonly refLast: number;
  readonly matched: number;
}

export interface AlignOptions {
  /** 完全一致の錨に使う最小の文字数。 */
  readonly minExact?: number;
  /** LCS で残す最小の連続一致。 */
  readonly minRun?: number;
  /** 錨の位置が比例配分の期待位置から離れてよい割合。 */
  readonly positionTolerance?: number;
}

function fromPairs(method: AlignMethod, cps: readonly number[], pairs: ReadonlyArray<readonly [number, number]>): SegmentAlignment {
  const length = cps.length;
  if (pairs.length === 0) return { method: "none", cps, length, pairs: [], first: -1, last: -1, refFirst: -1, refLast: -1, matched: 0 };
  const firstPair = pairs[0]!;
  const lastPair = pairs[pairs.length - 1]!;
  return { method, cps, length, pairs, first: firstPair[1], last: lastPair[1], refFirst: firstPair[0], refLast: lastPair[0], matched: pairs.length };
}

/** 一部の pairs だけを持つ対応（区間を分けたとき用）。pairs の区間側 index は cps に合わせて 0 始まり。 */
export function subAlignment(base: SegmentAlignment, cps: readonly number[], pairs: ReadonlyArray<readonly [number, number]>): SegmentAlignment {
  return fromPairs(pairs.length > 0 ? base.method : "none", cps, pairs);
}

/**
 * 区間本文（発話順）を target の正規化文字列へ単調に対応付ける。
 * 完全一致を先に錨とし、錨の間だけ LCS を取る。
 */
export function alignSegments(texts: readonly string[], target: readonly number[], options: AlignOptions = {}): SegmentAlignment[] {
  const minExact = options.minExact ?? 8;
  const minRun = options.minRun ?? 2;
  const tolerance = options.positionTolerance ?? 0.25;
  const segs = texts.map(text => normalizeChars(text).cps);
  const offsets: number[] = [];
  let total = 0;
  for (const s of segs) {
    offsets.push(total);
    total += s.length;
  }
  const targetLength = target.length;
  const result: Array<SegmentAlignment | undefined> = new Array(segs.length);

  // 1) 完全一致の錨。原稿側でも一意（他の区間の本文に含まれない）で、残りの target でも一意、
  //    かつ比例位置から大きく外れないもの。原稿側の一意性が無いと、ASR が落とした短い区間が
  //    後の区間の中の同じ語句に錨を下ろしてしまう。
  const joined: number[] = [];
  for (const s of segs) joined.push(...s, -1);
  let lo = 0;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]!;
    if (s.length < minExact) continue;
    if (findAll(joined, s, 0, 2).length !== 1) continue;
    const hits = findAll(target, s, lo, 2);
    if (hits.length !== 1) continue;
    const pos = hits[0]!;
    const expected = total > 0 ? (offsets[k]! / total) * targetLength : 0;
    if (Math.abs(pos - expected) > tolerance * targetLength + 50) continue;
    result[k] = fromPairs("exact", s, s.map((_, i) => [i, pos + i] as const));
    lo = pos + s.length;
  }

  // 2) 錨の間を LCS で。
  let k = 0;
  while (k < segs.length) {
    if (result[k] !== undefined) {
      k++;
      continue;
    }
    const g0 = k;
    while (k < segs.length && result[k] === undefined) k++;
    const g1 = k - 1;
    const prevAnchor = g0 > 0 ? result[g0 - 1] : undefined;
    const nextAnchor = k < segs.length ? result[k] : undefined;
    const tLo = prevAnchor !== undefined ? prevAnchor.last + 1 : 0;
    const tHi = nextAnchor !== undefined ? nextAnchor.first : targetLength;
    const ref: number[] = [];
    const refSeg: number[] = [];
    const refPos: number[] = [];
    for (let g = g0; g <= g1; g++) {
      segs[g]!.forEach((cp, i) => {
        ref.push(cp);
        refSeg.push(g);
        refPos.push(i);
      });
    }
    const perSeg = new Map<number, Array<[number, number]>>();
    if (tHi > tLo && ref.length > 0) {
      const pairs = filterRuns(lcsPairs(ref, target.slice(tLo, tHi)), minRun);
      for (const [ri, ti] of pairs) {
        const g = refSeg[ri]!;
        const list = perSeg.get(g) ?? [];
        list.push([refPos[ri]!, tLo + ti]);
        perSeg.set(g, list);
      }
    }
    for (let g = g0; g <= g1; g++) {
      const pairs = clusterPairs(filterRuns(perSeg.get(g) ?? [], minRun));
      result[g] = fromPairs("lcs", segs[g]!, pairs);
    }
  }
  return result.map((r, i) => r ?? fromPairs("none", segs[i]!, []));
}

/** 整数 total を weights の比で配る（最大剰余法）。 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map(w => (total * w) / sum);
  const out = raw.map(x => Math.floor(x));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    if (weights[i]! > 0) {
      out[i]! += 1;
      rest--;
    }
  }
  return out;
}

export type PlaceMethod = "exact" | "lcs" | "gap" | "none";

export interface PlacedSegment {
  readonly method: PlaceMethod;
  readonly startMs: number | null;
  readonly endMs: number | null;
  /** 区間に割り当てた target 文字の範囲（無ければ -1）。 */
  readonly tFrom: number;
  readonly tTo: number;
  /** 時刻を置けなかった先頭/末尾の文字数。 */
  readonly headUnplaced: number;
  readonly tailUnplaced: number;
}

const HAN = /\p{Script=Han}/u;

/** 読みの長さの目安（漢字 2、それ以外 1）。ASR がかなで書いた語と漢字の語の長さを釣り合わせる。 */
export function readingWeight(cps: readonly number[], from = 0, to = cps.length): number {
  let w = 0;
  for (let i = from; i < to; i++) w += HAN.test(String.fromCodePoint(cps[i]!)) ? 2 : 1;
  return w;
}

/**
 * 対応付けから各区間の時刻を決める。先頭は割り当てた最初の文字の開始、末尾は最後の文字の終了。
 *
 * 区間どうしの間に残った target 文字（間隙）は、前区間の未対応の末尾・間の未対応区間・次区間の未対応の先頭が
 * 「読みの長さ」（漢字 2・他 1）で取り合う:
 * - 間隙が取り分の合計以下なら、全部を取り分の比で配る。
 * - 多ければ、前区間の末尾と次区間の先頭は隣接する側から取り分だけ取り、残りを間の未対応区間へ配る
 *   （残りが未対応区間の取り分の 1.5 倍 + 2 文字以内のときだけ。超えれば未対応区間は置かない）。
 *   どの区間にも配らなかった文字は、言いよどみなど原稿から除いた語とみなす。
 */
export function placeSegments(alignments: readonly SegmentAlignment[], stream: CharStream): PlacedSegment[] {
  const n = alignments.length;
  const targetLength = stream.cps.length;
  const headAssign = new Array<number>(n).fill(0);
  const tailAssign = new Array<number>(n).fill(0);
  const headUnplaced = new Array<number>(n).fill(0);
  const tailUnplaced = new Array<number>(n).fill(0);
  const gapRange: Array<readonly [number, number] | null> = new Array(n).fill(null);
  let p = -1;
  for (let k = 0; k <= n; k++) {
    const current = k < n ? alignments[k]! : undefined;
    if (current !== undefined && current.method === "none") continue;
    const prev = p >= 0 ? alignments[p]! : undefined;
    const regionLo = prev !== undefined ? prev.last + 1 : 0;
    const regionHi = current !== undefined ? current.first : targetLength;
    const gap = Math.max(0, regionHi - regionLo);
    const tailW = prev !== undefined ? readingWeight(prev.cps, prev.refLast + 1, prev.length) : 0;
    const headW = current !== undefined ? readingWeight(current.cps, 0, current.refFirst) : 0;
    const middle: number[] = [];
    for (let m = p + 1; m < k; m++) middle.push(m);
    const middleWs = middle.map(m => readingWeight(alignments[m]!.cps));
    const middleW = middleWs.reduce((a, b) => a + b, 0);
    const want = tailW + middleW + headW;
    const placeMiddle = (from: number, count: number): void => {
      const counts = apportion(count, middleWs);
      let cursor = from;
      middle.forEach((m, idx) => {
        const c = counts[idx]!;
        if (c > 0) gapRange[m] = [cursor, cursor + c - 1];
        cursor += c;
      });
    };
    if (gap > 0 && want > 0) {
      if (gap <= want) {
        const counts = apportion(gap, [tailW, ...middleWs, headW]);
        if (prev !== undefined) tailAssign[p] = counts[0]!;
        if (current !== undefined) headAssign[k] = counts[counts.length - 1]!;
        placeMiddle(regionLo + counts[0]!, gap - counts[0]! - counts[counts.length - 1]!);
      } else {
        if (prev !== undefined) tailAssign[p] = tailW;
        if (current !== undefined) headAssign[k] = headW;
        const rest = gap - tailW - headW;
        if (middle.length > 0 && rest <= Math.ceil(middleW * 1.5) + 2) placeMiddle(regionLo + tailW, rest);
      }
    }
    if (prev !== undefined) tailUnplaced[p] = tailW > 0 && tailAssign[p] === 0 ? prev.length - 1 - prev.refLast : 0;
    if (current !== undefined) headUnplaced[k] = headW > 0 && headAssign[k] === 0 ? current.refFirst : 0;
    p = k;
  }
  return alignments.map((a, k): PlacedSegment => {
    if (a.method !== "none") {
      const from = a.first - headAssign[k]!;
      const to = a.last + tailAssign[k]!;
      return { method: a.method, startMs: stream.startMs[from]!, endMs: stream.endMs[to]!, tFrom: from, tTo: to, headUnplaced: headUnplaced[k]!, tailUnplaced: tailUnplaced[k]! };
    }
    const range = gapRange[k];
    if (range !== null && range !== undefined) {
      return { method: "gap", startMs: stream.startMs[range[0]]!, endMs: stream.endMs[range[1]]!, tFrom: range[0], tTo: range[1], headUnplaced: 0, tailUnplaced: 0 };
    }
    return { method: "none", startMs: null, endMs: null, tFrom: -1, tTo: -1, headUnplaced: a.length, tailUnplaced: 0 };
  });
}
