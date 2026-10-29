/**
 * Fact-level acoustic timing from reviewed source/target ASR word anchors.
 * All input/output files contain transcript text and must stay in EVAL_PRIVATE_DIR.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FactType, FactVerdict, ReferenceDocument } from "./engine.ts";
import { nearestRank } from "./judge/metrics.ts";

export interface TimedWord { readonly text: string; readonly startMs: number; readonly endMs: number }
export interface FactAnchor {
  readonly segmentId: string;
  readonly factIndex: number;
  readonly sourceWordLo: number;
  readonly sourceWordHi: number;
  readonly targetWordLo: number | null;
  readonly targetWordHi: number | null;
  /** A wrong or omitted fact is never counted as a successful latency sample. */
  readonly verdict: FactVerdict;
  /** asr-reviewed = text and ASR word times checked; audio-reviewed = the audio was also checked. */
  readonly review: "asr-reviewed" | "audio-reviewed";
}
export interface FactTiming {
  readonly segmentId: string;
  readonly factIndex: number;
  readonly type: FactType;
  readonly fact: string;
  readonly verdict: FactVerdict;
  readonly sourceText: string;
  readonly targetText: string | null;
  readonly sourceStartMs: number;
  readonly sourceEndMs: number;
  readonly targetStartMs: number | null;
  readonly targetEndMs: number | null;
  /** First target word minus the time the source fact finished being spoken. */
  readonly lFactMs: number | null;
  /** First target word minus the time the source fact began. */
  readonly lFactOnsetMs: number | null;
  readonly review: FactAnchor["review"];
}

function integer(n: number, label: string, max: number): void {
  if (!Number.isInteger(n) || n < 0 || n >= max) throw new Error(`${label}: word index out of range`);
}

function wordRange(words: readonly TimedWord[], lo: number, hi: number, label: string): { text: string; startMs: number; endMs: number } {
  integer(lo, label, words.length);
  integer(hi, label, words.length);
  if (hi < lo) throw new Error(`${label}: reversed word range`);
  const first = words[lo]!;
  const last = words[hi]!;
  if (!Number.isFinite(first.startMs) || !Number.isFinite(last.endMs) || last.endMs < first.startMs) throw new Error(`${label}: invalid word time`);
  return { text: words.slice(lo, hi + 1).map(w => w.text).join(""), startMs: first.startMs, endMs: last.endMs };
}

export function measureFacts(reference: ReferenceDocument, sourceWords: readonly TimedWord[], targetWords: readonly TimedWord[], anchors: readonly FactAnchor[]): FactTiming[] {
  const byId = new Map(reference.segments.map(s => [s.id, s]));
  const seen = new Set<string>();
  return anchors.map(a => {
    const segment = byId.get(a.segmentId);
    if (!segment) throw new Error(`unknown segment: ${a.segmentId}`);
    const fact = segment.facts[a.factIndex];
    if (!fact) throw new Error(`unknown fact: ${a.segmentId}/${a.factIndex}`);
    const id = `${a.segmentId}/${a.factIndex}`;
    if (seen.has(id)) throw new Error(`duplicate fact: ${id}`);
    seen.add(id);
    if (a.review !== "asr-reviewed" && a.review !== "audio-reviewed") throw new Error(`invalid review: ${id}`);
    if (!["ok", "wrong", "omitted", "unclear"].includes(a.verdict)) throw new Error(`invalid verdict: ${id}`);
    const source = wordRange(sourceWords, a.sourceWordLo, a.sourceWordHi, `source ${id}`);
    // A source anchor far outside its reference meaning unit is usually a bad word index.
    if (source.startMs < segment.startMs - 3_000 || source.endMs > segment.endMs + 3_000) throw new Error(`source anchor outside segment: ${id}`);
    if ((a.targetWordLo === null) !== (a.targetWordHi === null)) throw new Error(`incomplete target anchor: ${id}`);
    if (a.verdict === "ok" && a.targetWordLo === null) throw new Error(`ok fact without target anchor: ${id}`);
    if (a.verdict === "omitted" && a.targetWordLo !== null) throw new Error(`omitted fact with target anchor: ${id}`);
    const target = a.targetWordLo === null ? null : wordRange(targetWords, a.targetWordLo, a.targetWordHi!, `target ${id}`);
    return {
      segmentId: a.segmentId, factIndex: a.factIndex, type: fact.type, fact: fact.text, verdict: a.verdict,
      sourceText: source.text, targetText: target?.text ?? null,
      sourceStartMs: source.startMs, sourceEndMs: source.endMs,
      targetStartMs: target?.startMs ?? null, targetEndMs: target?.endMs ?? null,
      lFactMs: target === null || a.verdict !== "ok" ? null : target.startMs - source.endMs,
      lFactOnsetMs: target === null || a.verdict !== "ok" ? null : target.startMs - source.startMs,
      review: a.review,
    };
  });
}

export function summarizeFacts(items: readonly FactTiming[]): { total: number; correctTimed: number; preSourceEnd: number; wrong: number; omitted: number; unclear: number; asrReviewed: number; audioReviewed: number; lFactP50Ms: number | null; lFactP95Ms: number | null; lFactOnsetP50Ms: number | null; lFactOnsetP95Ms: number | null } {
  const latency = items.flatMap(i => i.lFactMs === null ? [] : [i.lFactMs]);
  const onset = items.flatMap(i => i.lFactOnsetMs === null ? [] : [i.lFactOnsetMs]);
  return {
    total: items.length, correctTimed: latency.length,
    // A target fact emitted before its source completion may be a prediction. Keep it visible.
    preSourceEnd: latency.filter(ms => ms < 0).length,
    wrong: items.filter(i => i.verdict === "wrong").length,
    omitted: items.filter(i => i.verdict === "omitted").length,
    unclear: items.filter(i => i.verdict === "unclear").length,
    asrReviewed: items.filter(i => i.review === "asr-reviewed").length,
    audioReviewed: items.filter(i => i.review === "audio-reviewed").length,
    lFactP50Ms: nearestRank(latency, 50), lFactP95Ms: nearestRank(latency, 95),
    lFactOnsetP50Ms: nearestRank(onset, 50), lFactOnsetP95Ms: nearestRank(onset, 95),
  };
}

function args(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || !argv[i + 1]) throw new Error("expected --key value arguments");
    out.set(argv[i]!.slice(2), argv[i + 1]!);
  }
  return out;
}

async function main(): Promise<void> {
  const options = args(process.argv.slice(2));
  const privateRoot = process.env.EVAL_PRIVATE_DIR;
  if (!privateRoot) throw new Error("EVAL_PRIVATE_DIR required");
  const withinPrivate = (value: string): string => {
    const root = resolve(privateRoot);
    const path = resolve(value);
    if (!path.startsWith(`${root}/`)) throw new Error("input/output must be inside EVAL_PRIVATE_DIR");
    return path;
  };
  const required = (name: string): string => {
    const value = options.get(name);
    if (!value) throw new Error(`--${name} required`);
    return withinPrivate(value);
  };
  const reference = JSON.parse(await readFile(required("reference"), "utf8")) as ReferenceDocument;
  const sourceAsr = JSON.parse(await readFile(required("source-asr"), "utf8")) as { words: Array<{ word: string; start: number; end: number }> };
  const targetAsr = JSON.parse(await readFile(required("target-asr"), "utf8")) as { words: TimedWord[] };
  const anchorDoc = JSON.parse(await readFile(required("anchors"), "utf8")) as { sourceId: string; anchors: FactAnchor[] };
  if (anchorDoc.sourceId !== reference.sourceId) throw new Error("anchor sourceId mismatch");
  const sourceWords = sourceAsr.words.map(w => ({ text: w.word, startMs: Math.round(w.start * 1_000), endMs: Math.round(w.end * 1_000) }));
  const items = measureFacts(reference, sourceWords, targetAsr.words, anchorDoc.anchors);
  const result = { sourceId: reference.sourceId, summary: summarizeFacts(items), facts: items };
  await writeFile(required("out"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  // stdout contains only aggregate counts and times, never private transcripts or paths.
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { process.stderr.write(`fact-latency: ${e instanceof Error ? e.message : "failed"}\n`); process.exitCode = 1; });
}
