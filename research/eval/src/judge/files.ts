/**
 * run ディレクトリと正解原稿の読み書き。エラーに path を出さない（ファイル名だけ）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ReferenceDocument, ReferenceSegment, RunSummary } from "../engine.ts";

export async function readBytes(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new Error(`cannot read ${basename(path)}`);
  }
}

export async function readJson(path: string): Promise<unknown> {
  const buf = await readBytes(path);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error(`${basename(path)} is not valid JSON`);
  }
}

/** 無ければ null（エンジンが字幕を出さない run）。 */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return (await readFile(path)).toString("utf8");
  } catch {
    return null;
  }
}

export async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(path)).toString("utf8"));
  } catch {
    return undefined;
  }
}

export async function writeText(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text, { mode: 0o600 });
  } catch {
    throw new Error(`cannot write ${basename(path)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 最上位か 1 段下（config / engine / args / cli など）にある文字列を探す。 */
function findString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value[key] === "string") return value[key] as string;
  for (const child of Object.values(value)) {
    if (isRecord(child) && typeof child[key] === "string") return child[key] as string;
  }
  return undefined;
}

export interface RunMeta {
  readonly runId: string;
  readonly engineId: string;
  readonly sourceId: string;
  readonly windowStartSec: number | null;
  readonly windowEndSec: number | null;
  readonly queueMaxMs: number;
}

/** summary.json を正とし、欠けた値を config.json から補う。 */
export async function readRunMeta(runDir: string): Promise<RunMeta> {
  const summary = (await readJsonIfExists(join(runDir, "summary.json"))) as Partial<RunSummary> | undefined;
  const config = await readJsonIfExists(join(runDir, "config.json"));
  const engineId = summary?.engineId ?? summary?.config?.engineId ?? findString(config, "engineId");
  const sourceId = summary?.sourceId ?? findString(config, "sourceId");
  if (!engineId || !sourceId) throw new Error("engineId/sourceId not found in summary.json or config.json");
  return {
    runId: summary?.runId ?? findString(config, "runId") ?? basename(runDir),
    engineId,
    sourceId,
    windowStartSec: typeof summary?.windowStartSec === "number" ? summary.windowStartSec : null,
    windowEndSec: typeof summary?.windowEndSec === "number" ? summary.windowEndSec : null,
    queueMaxMs: typeof summary?.queue?.maxMs === "number" ? summary.queue.maxMs : 0,
  };
}

const KINDS: ReadonlyArray<ReferenceSegment["kind"]> = ["statement", "question", "backchannel", "fragment"];

/** 最低限の形を確かめる（本文は出さない）。区間は開始時刻順に並べ直す。 */
export function parseReference(value: unknown): ReferenceDocument {
  if (!isRecord(value) || typeof value.sourceId !== "string" || !Array.isArray(value.segments)) {
    throw new Error("reference has an unexpected shape");
  }
  const ids = new Set<string>();
  for (const [k, seg] of value.segments.entries()) {
    const ok =
      isRecord(seg) &&
      typeof seg.id === "string" &&
      Number.isFinite(seg.startMs) &&
      Number.isFinite(seg.endMs) &&
      (seg.endMs as number) >= (seg.startMs as number) &&
      typeof seg.text === "string" &&
      KINDS.includes(seg.kind as ReferenceSegment["kind"]) &&
      Array.isArray(seg.facts);
    if (!ok) throw new Error(`reference segment #${k} has an unexpected shape`);
    if (ids.has(seg.id as string)) throw new Error(`reference segment #${k} has a duplicate id`);
    ids.add(seg.id as string);
  }
  const doc = value as unknown as ReferenceDocument;
  return { ...doc, segments: [...doc.segments].sort((a, b) => a.startMs - b.startMs) };
}
