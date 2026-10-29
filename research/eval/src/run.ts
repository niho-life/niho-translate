/**
 * 同時通訳 比較評価ハーネスの CLI（README §2〜§3）。
 *
 *   npm --silent run eval:run -- --wav /abs/path.wav --window 150:450 --source-id src1-w1 \
 *     --engine openai-translate [--frame-ms 200] [--option k=v ...] [--tail-silence-sec 6] \
 *     [--finish-timeout-sec 20] [--out-root /abs/dir] [--source ja] [--target en]
 *
 * 結果は `EVAL_PRIVATE_DIR/runs/<runId>/`（または --out-root）にだけ書く。
 * stdout は summary.json の内容だけ。本文・path・鍵は stdout / stderr に出さない。
 * 終了コード: 0 正常 / 1 内部エラー / 2 引数・入力・設定の誤り / 3 fatal 付きで完了 / 130 中断。
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine, EngineConfig, EngineSink, Language, RunEvent, TranscriptMeta } from "./engine.ts";
import { HarnessError, decodeWindowPcm, encodeWav, mixStereo, parseWindow, pcmDurationMs, type AudioWindow } from "./audio.ts";
import { EngineError, loadEngineFactory } from "./engines/index.ts";
import { FRAME_MS_CHOICES, lateStats, planFrames, sendFramesPaced, systemClock, type LateStats } from "./pacing.ts";
import {
  buildOutputTimeline,
  buildSummary,
  idealPlayback,
  roundMs,
  transcriptFileContent,
  type PlayedChunk,
  type TimedText,
  type TimelineChunk,
} from "./timeline.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const START_TIMEOUT_MS = 30_000;
const FAILED_START_FINISH_TIMEOUT_MS = 5_000;
/** mixed.wav の L（原音）の倍率。 */
const SOURCE_GAIN = 0.8;
/** 有声とみなす振幅（約 -40 dBFS）。firstAudioOutMs は完全無音以外の全 chunk を数えるため、別に印を付ける。 */
export const VOICED_PEAK = 328;
const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_USAGE = 2;
const EXIT_FATAL = 3;
const EXIT_INTERRUPTED = 130;

const VALUE_FLAGS = new Set([
  "wav", "window", "source-id", "engine", "frame-ms", "option",
  "tail-silence-sec", "finish-timeout-sec", "out-root", "source", "target",
]);
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENGINE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const OPTION_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

const USAGE = `usage: run.ts --wav <abs> --window <startSec>:<endSec> --source-id <id> --engine <id>
  [--frame-ms 100|200] [--option k=v ...] [--tail-silence-sec 6] [--finish-timeout-sec 20]
  [--out-root <abs>] [--source ja|en] [--target ja|en]
`;

export interface CliArgs {
  readonly wavPath: string;
  readonly window: AudioWindow;
  readonly sourceId: string;
  readonly engineId: string;
  readonly frameMs: number;
  readonly options: Readonly<Record<string, string>>;
  readonly tailSilenceSec: number;
  readonly finishTimeoutSec: number;
  readonly outRoot: string | undefined;
  readonly source: Language;
  readonly target: Language;
}

export function parseCliArgs(argv: ReadonlyArray<string>): CliArgs {
  const values = new Map<string, string>();
  const optionArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new HarnessError("UNEXPECTED_ARGUMENT");
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!VALUE_FLAGS.has(name)) throw new HarnessError("UNKNOWN_ARGUMENT", name.replace(/[^a-z0-9-]/gu, "_").slice(0, 32));
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined) throw new HarnessError("MISSING_ARGUMENT_VALUE", name);
    if (name === "option") optionArgs.push(value);
    else if (values.has(name)) throw new HarnessError("DUPLICATE_ARGUMENT", name);
    else values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value.length === 0) throw new HarnessError("MISSING_ARGUMENT", name);
    return value;
  };
  const wavPath = required("wav");
  if (!isAbsolute(wavPath)) throw new HarnessError("WAV_PATH_NOT_ABSOLUTE");
  const window = parseWindow(required("window"));
  const sourceId = required("source-id");
  if (!SOURCE_ID_PATTERN.test(sourceId)) throw new HarnessError("INVALID_SOURCE_ID");
  const engineId = required("engine");
  if (!ENGINE_ID_PATTERN.test(engineId)) throw new HarnessError("UNKNOWN_ENGINE");
  const frameMs = parseNumberFlag(values.get("frame-ms"), 200, "INVALID_FRAME_MS");
  if (!FRAME_MS_CHOICES.includes(frameMs)) throw new HarnessError("INVALID_FRAME_MS");
  const tailSilenceSec = parseNumberFlag(values.get("tail-silence-sec"), 6, "INVALID_TAIL_SILENCE");
  if (tailSilenceSec > 60) throw new HarnessError("INVALID_TAIL_SILENCE");
  const finishTimeoutSec = parseNumberFlag(values.get("finish-timeout-sec"), 20, "INVALID_FINISH_TIMEOUT");
  if (finishTimeoutSec < 1 || finishTimeoutSec > 600) throw new HarnessError("INVALID_FINISH_TIMEOUT");
  const source = parseLanguage(values.get("source") ?? "ja");
  const target = parseLanguage(values.get("target") ?? "en");
  if (source === target) throw new HarnessError("INVALID_LANGUAGE_PAIR");
  return {
    wavPath,
    window,
    sourceId,
    engineId,
    frameMs,
    options: parseOptionArgs(optionArgs),
    tailSilenceSec,
    finishTimeoutSec,
    outRoot: values.get("out-root"),
    source,
    target,
  };
}

/** `--option k=v` の列。値に `=` を含んでよい。同じ key は 2 回指定できない。 */
export function parseOptionArgs(list: ReadonlyArray<string>): Record<string, string> {
  const options: Record<string, string> = {};
  for (const item of list) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new HarnessError("INVALID_OPTION_FORMAT");
    const key = item.slice(0, eq);
    const value = item.slice(eq + 1);
    if (!OPTION_KEY_PATTERN.test(key)) throw new HarnessError("INVALID_OPTION_FORMAT");
    if (value.length === 0 || value.length > 256) throw new HarnessError("INVALID_OPTION_VALUE", key);
    if (Object.hasOwn(options, key)) throw new HarnessError("DUPLICATE_OPTION", key);
    options[key] = value;
  }
  return options;
}

function parseNumberFlag(value: string | undefined, fallback: number, code: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+(?:\.\d+)?$/u.test(value)) throw new HarnessError(code);
  return Number(value);
}

function parseLanguage(value: string): Language {
  if (value === "ja" || value === "en") return value;
  throw new HarnessError("INVALID_LANGUAGE");
}

/** 結果の置き場。公開リポジトリの中へは書かない。 */
export function resolveOutRoot(cliValue: string | undefined, privateDir: string | undefined, repoRoot: string = REPO_ROOT): string {
  const raw = cliValue ?? (privateDir ? join(privateDir, "runs") : undefined);
  if (!raw) throw new HarnessError("OUT_ROOT_MISSING");
  if (!isAbsolute(raw)) throw new HarnessError("OUT_ROOT_NOT_ABSOLUTE");
  const resolved = resolve(raw);
  const rel = relative(resolve(repoRoot), resolved);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new HarnessError("OUT_ROOT_INSIDE_REPO");
  }
  return resolved;
}

/** `<YYYYMMDD-HHMMSS>-<engineId>-<sourceId>-<4文字乱数>`（ローカル時刻）。 */
export function formatRunId(date: Date, engineId: string, sourceId: string, random: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stamp}-${engineId}-${sourceId}-${random}`;
}

export function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(4), byte => alphabet[byte % alphabet.length]).join("");
}

type Recorded =
  | { readonly kind: "mark"; readonly at: number; readonly make: (t: number) => RunEvent }
  | { readonly kind: "audio"; readonly at: number; readonly pcm: Buffer }
  | {
    readonly kind: "transcript";
    readonly at: number;
    readonly direction: "out" | "in";
    readonly text: string;
    readonly meta: TranscriptMeta | undefined;
  }
  | { readonly kind: "diag"; readonly at: number; readonly diagKind: string; readonly data: Readonly<Record<string, unknown>> | undefined }
  | { readonly kind: "fatal"; readonly at: number; readonly code: string; readonly detail: string | undefined };

export interface BuiltRun {
  readonly events: RunEvent[];
  readonly played: PlayedChunk[];
  readonly timeline: TimelineChunk[];
  readonly transcriptOut: TimedText[];
  readonly transcriptIn: TimedText[];
}

/**
 * EngineSink の実装。呼ばれた瞬間の時刻（絶対値）だけを記録し、t0 が決まった後で t に直す。
 * run の終わりに seal した後の呼び出しは捨てる。
 */
export class RunRecorder implements EngineSink {
  private readonly records: Recorded[] = [];
  private sealed = false;
  private voicedSeen = false;
  fatalCode: string | null = null;
  incomplete = false;

  constructor(private readonly now: () => number) {}

  markAt(at: number, make: (t: number) => RunEvent): void {
    if (!this.sealed) this.records.push({ kind: "mark", at, make });
  }

  mark(make: (t: number) => RunEvent): void {
    this.markAt(this.now(), make);
  }

  outputAudio(pcm: Buffer): void {
    if (this.sealed || !Buffer.isBuffer(pcm)) return;
    const evenBytes = pcm.length - (pcm.length % 2);
    if (evenBytes === 0) return;
    const at = this.now();
    const copy = Buffer.from(pcm.subarray(0, evenBytes));
    this.records.push({ kind: "audio", at, pcm: copy });
    if (!this.voicedSeen) {
      const onset = firstVoicedSample(copy, VOICED_PEAK);
      if (onset !== undefined) {
        this.voicedSeen = true;
        // 本文なしの印。t は chunk の到着時刻、offsetMs はその chunk 内で最初に閾値を超えた位置。
        this.records.push({
          kind: "diag",
          at,
          diagKind: "harness.first_voiced_audio",
          data: { offsetMs: roundMs(onset / 24), thresholdPeak: VOICED_PEAK },
        });
      }
    }
  }

  outputTranscript(text: string, meta?: TranscriptMeta): void {
    this.transcript("out", text, meta);
  }

  inputTranscript(text: string, meta?: TranscriptMeta): void {
    this.transcript("in", text, meta);
  }

  diag(kind: string, data?: Readonly<Record<string, unknown>>): void {
    if (this.sealed || typeof kind !== "string" || kind.length === 0) return;
    if (kind === "finish.incomplete") this.incomplete = true;
    this.records.push({ kind: "diag", at: this.now(), diagKind: kind.slice(0, 128), data: data === undefined ? undefined : jsonSafe(data) });
  }

  fatal(code: string, detail?: string): void {
    if (this.sealed) return;
    const safe = typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(code) ? code : "ENGINE_FATAL";
    if (this.fatalCode === null) this.fatalCode = safe;
    this.records.push({ kind: "fatal", at: this.now(), code: safe, detail: detail === undefined ? undefined : safeDetail(detail) });
  }

  seal(): void {
    this.sealed = true;
  }

  build(t0: number): BuiltRun {
    const audio = this.records.filter((record): record is Extract<Recorded, { kind: "audio" }> => record.kind === "audio");
    const played = idealPlayback(audio.map(record => ({ t: record.at - t0, bytes: record.pcm.length })));
    const events: RunEvent[] = [];
    const timeline: TimelineChunk[] = [];
    const transcriptOut: TimedText[] = [];
    const transcriptIn: TimedText[] = [];
    let audioIndex = 0;
    for (const record of this.records) {
      const t = record.at - t0;
      switch (record.kind) {
        case "mark":
          events.push(record.make(roundMs(t)));
          break;
        case "audio": {
          const chunk = played[audioIndex]!;
          audioIndex += 1;
          events.push({
            type: "audio.out",
            t: roundMs(t),
            bytes: chunk.bytes,
            playStartT: roundMs(chunk.playStartT),
            playEndT: roundMs(chunk.playEndT),
            queueMs: roundMs(chunk.queueMs),
          });
          timeline.push({ playStartT: chunk.playStartT, pcm: record.pcm });
          break;
        }
        case "transcript": {
          const base = { t: roundMs(t), text: record.text, ...metaFields(record.meta) };
          if (record.direction === "out") {
            events.push({ type: "transcript.out", ...base });
            transcriptOut.push({ t, text: record.text });
          } else {
            events.push({ type: "transcript.in", ...base });
            transcriptIn.push({ t, text: record.text });
          }
          break;
        }
        case "diag":
          events.push(record.data === undefined
            ? { type: "diag", t: roundMs(t), kind: record.diagKind }
            : { type: "diag", t: roundMs(t), kind: record.diagKind, data: record.data });
          break;
        case "fatal":
          events.push(record.detail === undefined
            ? { type: "fatal", t: roundMs(t), code: record.code }
            : { type: "fatal", t: roundMs(t), code: record.code, detail: record.detail });
          break;
      }
    }
    return { events, played, timeline, transcriptOut, transcriptIn };
  }

  private transcript(direction: "out" | "in", text: string, meta: TranscriptMeta | undefined): void {
    if (this.sealed || typeof text !== "string" || text.length === 0) return;
    this.records.push({ kind: "transcript", at: this.now(), direction, text, meta });
  }
}

/** 閾値以上の最初の sample の index（無ければ undefined）。 */
export function firstVoicedSample(pcm: Buffer, threshold: number): number | undefined {
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    if (Math.abs(pcm.readInt16LE(offset)) >= threshold) return offset / 2;
  }
  return undefined;
}

function metaFields(meta: TranscriptMeta | undefined): { final?: boolean; itemId?: string; segmentId?: string } {
  const fields: { final?: boolean; itemId?: string; segmentId?: string } = {};
  if (meta?.final !== undefined) fields.final = meta.final;
  if (meta?.itemId !== undefined) fields.itemId = meta.itemId;
  if (meta?.segmentId !== undefined) fields.segmentId = meta.segmentId;
  return fields;
}

function jsonSafe(data: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  try {
    const copy: unknown = JSON.parse(JSON.stringify(data));
    return copy && typeof copy === "object" && !Array.isArray(copy) ? (copy as Record<string, unknown>) : { invalid: true };
  } catch {
    return { unserializable: true };
  }
}

function safeDetail(detail: string): string {
  return String(detail).replace(/[^A-Za-z0-9_.:=-]/gu, "_").slice(0, 120);
}

function describeError(error: unknown, fallback: string): { code: string; detail: string | undefined } {
  if (error instanceof HarnessError || error instanceof EngineError) return { code: error.code, detail: error.detail };
  return { code: fallback, detail: error instanceof Error ? error.name : undefined };
}

function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HarnessError(code)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function settleWithin(run: () => Promise<void>, ms: number): Promise<"done" | "timeout" | "error"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">(resolve => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  const work = Promise.resolve().then(run).then(() => "done" as const, () => "error" as const);
  const outcome = await Promise.race([work, timeout]);
  clearTimeout(timer);
  return outcome;
}

function readCost(engine: Engine): number | null {
  const value = engine.costUsd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function writePrivate(path: string, data: string | Buffer): Promise<void> {
  await writeFile(path, data, { mode: 0o600 });
}

function installInterruptHandler(): { readonly requested: boolean; dispose(): void } {
  let requested = false;
  const handler = () => {
    if (requested) process.exit(EXIT_INTERRUPTED);
    requested = true;
  };
  process.on("SIGINT", handler);
  return {
    get requested() {
      return requested;
    },
    dispose: () => process.off("SIGINT", handler),
  };
}

export async function runHarness(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): Promise<number> {
  const args = parseCliArgs(argv);
  const apiKey = (env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey && args.engineId !== "gemini-live-translate" && args.engineId !== "qwen-live-translate") {
    throw new HarnessError("OPENAI_API_KEY_MISSING");
  }
  const outRoot = resolveOutRoot(args.outRoot, env.EVAL_PRIVATE_DIR);
  const factory = await loadEngineFactory(args.engineId);
  const config: EngineConfig = {
    engineId: args.engineId,
    sourceLanguage: args.source,
    targetLanguage: args.target,
    frameMs: args.frameMs,
    options: args.options,
  };
  const clock = systemClock;
  const recorder = new RunRecorder(() => clock.now());
  let engine: Engine;
  try {
    // option の検査はここで（接続より前）。
    const googleAccessToken = (env.GOOGLE_ACCESS_TOKEN ?? "").trim();
    const qwenApiKey = (env.DASHSCOPE_API_KEY ?? "").trim();
    engine = factory(config, recorder, {
      openaiApiKey: apiKey,
      ...(googleAccessToken ? { googleAccessToken } : {}),
      ...(qwenApiKey ? { qwenApiKey } : {}),
    });
  } catch (error) {
    if (error instanceof EngineError || error instanceof HarnessError) throw error;
    throw new HarnessError("ENGINE_CONFIG_INVALID");
  }

  try {
    await access(args.wavPath, fsConstants.R_OK);
  } catch {
    throw new HarnessError("WAV_NOT_READABLE");
  }
  const windowPcm = await decodeWindowPcm(args.wavPath, args.window);
  const plan = planFrames(windowPcm, args.frameMs, args.tailSilenceSec * 1_000);
  const durationMs = pcmDurationMs(windowPcm.length);
  const tailSilenceMs = plan.tailFrameCount * args.frameMs;

  const startedAt = new Date();
  const runId = formatRunId(startedAt, args.engineId, args.sourceId, randomSuffix());
  const runDir = join(outRoot, runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await writePrivate(join(runDir, "config.json"), `${JSON.stringify({
    runId,
    sourceId: args.sourceId,
    engineConfig: config,
    window: { startSec: args.window.startSec, endSec: args.window.endSec, decodedMs: roundMs(durationMs) },
    frameMs: args.frameMs,
    tailSilenceSec: args.tailSilenceSec,
    finishTimeoutSec: args.finishTimeoutSec,
    frames: { bytes: plan.frameBytes, window: plan.windowFrameCount, tail: plan.tailFrameCount },
    harness: { node: process.version, idealPlayback: "README §2", queueLimitMs: 2_000 },
    startedAtIso: startedAt.toISOString(),
  }, null, 2)}\n`);

  const interrupt = installInterruptHandler();
  try {
    const runStartAt = clock.now();
    recorder.markAt(runStartAt, t => ({
      type: "run.start",
      t,
      runId,
      engineId: args.engineId,
      sourceId: args.sourceId,
      config,
      durationMs: roundMs(durationMs),
      startedAtIso: startedAt.toISOString(),
    }));

    const startCalledAt = clock.now();
    let ready = false;
    try {
      await withTimeout(Promise.resolve().then(() => engine.start()), START_TIMEOUT_MS, "ENGINE_START_TIMEOUT");
      ready = true;
      recorder.mark(t => ({ type: "engine.ready", t }));
    } catch (error) {
      const { code, detail } = describeError(error, "ENGINE_START_FAILED");
      recorder.fatal(code, detail);
    }
    const startSettledAt = clock.now();

    let t0: number | undefined;
    let sentCount = 0;
    let frames: LateStats = { count: 0, maxLateMs: 0, meanLateMs: 0 };
    if (ready) {
      const result = await sendFramesPaced({
        frames: plan.frames,
        frameMs: args.frameMs,
        clock,
        send: frame => {
          try {
            engine.appendPcm(frame);
          } catch {
            recorder.fatal("ENGINE_APPEND_FAILED");
          }
        },
        shouldStop: () => interrupt.requested || recorder.fatalCode !== null,
        onSent: record => recorder.markAt(record.sentAt, t => ({
          type: "frame.sent",
          t,
          idx: record.idx,
          scheduledT: record.scheduledT,
          bytes: plan.frameBytes,
        })),
      });
      t0 = result.t0;
      sentCount = result.sent.length;
      frames = lateStats(result.sent, result.t0);
    }
    if (interrupt.requested) recorder.fatal("INTERRUPTED");

    const finishBeginAt = clock.now();
    recorder.markAt(finishBeginAt, t => ({ type: "finish.begin", t }));
    const finishLimitMs = ready ? args.finishTimeoutSec * 1_000 : FAILED_START_FINISH_TIMEOUT_MS;
    const outcome = await settleWithin(() => engine.finish(), finishLimitMs);
    if (outcome === "error") recorder.fatal("ENGINE_FINISH_FAILED");
    if (outcome === "timeout") recorder.diag("harness.finish_timeout", { limitMs: finishLimitMs });
    const finishEndAt = clock.now();
    const drained = ready && outcome === "done" && !recorder.incomplete && recorder.fatalCode === null;
    recorder.markAt(finishEndAt, t => ({ type: "finish.end", t, drained }));
    const costUsd = readCost(engine);
    const runEndAt = clock.now();
    recorder.markAt(runEndAt, t => ({ type: "run.end", t }));
    recorder.seal();

    const built = recorder.build(t0 ?? startSettledAt);
    const sentPcm = Buffer.concat(plan.frames.slice(0, sentCount));
    const timelinePcm = buildOutputTimeline(built.timeline, pcmDurationMs(sentPcm.length));
    const summary = buildSummary({
      runId,
      engineId: args.engineId,
      sourceId: args.sourceId,
      config,
      windowStartSec: args.window.startSec,
      windowEndSec: args.window.endSec,
      durationMs,
      tailSilenceMs,
      engineReadyMs: startSettledAt - startCalledAt,
      played: built.played,
      transcriptOut: built.transcriptOut,
      frames,
      fatalCode: recorder.fatalCode,
      drained,
      finishWaitMs: finishEndAt - finishBeginAt,
      costUsd,
      wallMs: runEndAt - runStartAt,
    });
    await Promise.all([
      writePrivate(join(runDir, "events.jsonl"), built.events.map(event => JSON.stringify(event)).join("\n") + "\n"),
      writePrivate(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
      writePrivate(join(runDir, "source.wav"), encodeWav(sentPcm, 1)),
      writePrivate(join(runDir, "output-timeline.wav"), encodeWav(timelinePcm, 1)),
      writePrivate(join(runDir, "mixed.wav"), encodeWav(mixStereo(sentPcm, timelinePcm, SOURCE_GAIN, 1), 2)),
      writePrivate(join(runDir, "output-transcript.txt"), transcriptFileContent(built.transcriptOut)),
      writePrivate(join(runDir, "input-transcript.txt"), transcriptFileContent(built.transcriptIn)),
    ]);
    await writeStream(process.stdout, `${JSON.stringify(summary, null, 2)}\n`);
    if (interrupt.requested) return EXIT_INTERRUPTED;
    return summary.fatal === null ? EXIT_OK : EXIT_FATAL;
  } finally {
    interrupt.dispose();
  }
}

function writeStream(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise(resolve => {
    stream.write(text, () => resolve());
  });
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    await writeStream(process.stderr, USAGE);
    process.exit(EXIT_OK);
  }
  let exitCode: number;
  try {
    exitCode = await runHarness(argv, process.env);
  } catch (error) {
    const known = error instanceof HarnessError || error instanceof EngineError;
    const { code, detail } = describeError(error, "INTERNAL_ERROR");
    await writeStream(process.stderr, `${JSON.stringify(detail === undefined ? { error: code } : { error: code, detail })}\n`);
    exitCode = known ? EXIT_USAGE : EXIT_INTERNAL;
  }
  // 時間切れのエンジンが socket を握っていても終わらせる。
  process.exit(exitCode);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2));
}
