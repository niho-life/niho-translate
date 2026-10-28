/** make-reference の引数（純関数）。path は絶対 path だけを受け付ける。 */
import { isAbsolute } from "node:path";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
const EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];

/** `--turn-transcript` の種類。human = 録音付属の人手（未校正）転記、gemini = Gemini（Vertex AI）の文字起こし（同じ `[hh:mm:ss] 話者N: 本文` 形式）。 */
export type TranscriptKind = "human" | "gemini";
const TRANSCRIPT_KINDS: readonly TranscriptKind[] = ["human", "gemini"];

export interface MakeReferenceArgs {
  readonly wav: string;
  readonly windowStartSec: number;
  readonly windowEndSec: number;
  readonly sourceId: string;
  readonly turnTranscript?: string;
  readonly transcriptKind: TranscriptKind;
  readonly out?: string;
  readonly llm: string;
  readonly reasoning: ReasoningEffort;
  readonly whisperCliModel?: string;
  /** LLM を呼ばず、この下書き（draft.json の形式）に時刻を付け直す。 */
  readonly draft?: string;
  readonly refreshAsr: boolean;
  readonly refreshLlm: boolean;
  readonly vadTrim: boolean;
  /** 下書きの後に facts だけを抜き出し直すパス（既定 on）。 */
  readonly factsPass: boolean;
  readonly factsLlm: string;
  readonly factsReasoning: ReasoningEffort;
}

export const MIN_WINDOW_SEC = 10;
export const MAX_WINDOW_SEC = 600;

export function parseWindow(value: string): { startSec: number; endSec: number } {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
  if (m === null) throw new Error("--window must be <startSec>:<endSec>");
  const startSec = Number(m[1]);
  const endSec = Number(m[2]);
  const length = endSec - startSec;
  if (!(length >= MIN_WINDOW_SEC && length <= MAX_WINDOW_SEC)) throw new Error(`--window length must be ${MIN_WINDOW_SEC}-${MAX_WINDOW_SEC} seconds`);
  return { startSec, endSec };
}

function absolutePath(flag: string, value: string, extension: string): string {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  if (!value.toLowerCase().endsWith(extension)) throw new Error(`${flag} must end with ${extension}`);
  return value;
}

export function parseMakeReferenceArgs(argv: readonly string[]): MakeReferenceArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const withValue = new Set(["--wav", "--window", "--source-id", "--turn-transcript", "--transcript-kind", "--out", "--llm", "--reasoning", "--whisper-cli-model", "--draft", "--facts-llm", "--facts-reasoning"]);
  const booleans = new Set(["--refresh-asr", "--refresh-llm", "--no-vad-trim", "--no-facts-pass"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (booleans.has(arg)) {
      if (flags.has(arg)) throw new Error(`${arg} given twice`);
      flags.add(arg);
      continue;
    }
    if (!withValue.has(arg)) throw new Error(`unknown option ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    if (values.has(arg)) throw new Error(`${arg} given twice`);
    values.set(arg, value);
    i++;
  }
  const wav = values.get("--wav");
  const window = values.get("--window");
  const sourceId = values.get("--source-id");
  if (wav === undefined || window === undefined || sourceId === undefined) throw new Error("--wav, --window and --source-id are required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sourceId)) throw new Error("--source-id must be [A-Za-z0-9._-] (max 64)");
  const { startSec, endSec } = parseWindow(window);
  const llm = values.get("--llm") ?? "anthropic:claude-opus-5-5";
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(llm)) throw new Error("--llm must be a model id");
  const reasoning = (values.get("--reasoning") ?? "medium") as ReasoningEffort;
  if (!EFFORTS.includes(reasoning)) throw new Error(`--reasoning must be one of ${EFFORTS.join("|")}`);
  const factsLlm = values.get("--facts-llm") ?? llm;
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(factsLlm)) throw new Error("--facts-llm must be a model id");
  const factsReasoning = (values.get("--facts-reasoning") ?? "low") as ReasoningEffort;
  if (!EFFORTS.includes(factsReasoning)) throw new Error(`--facts-reasoning must be one of ${EFFORTS.join("|")}`);
  const transcriptKind = (values.get("--transcript-kind") ?? "human") as TranscriptKind;
  if (!TRANSCRIPT_KINDS.includes(transcriptKind)) throw new Error(`--transcript-kind must be one of ${TRANSCRIPT_KINDS.join("|")}`);
  const out: MakeReferenceArgs = {
    wav: absolutePath("--wav", wav, ".wav"),
    windowStartSec: startSec,
    windowEndSec: endSec,
    sourceId,
    transcriptKind,
    llm,
    reasoning,
    refreshAsr: flags.has("--refresh-asr"),
    refreshLlm: flags.has("--refresh-llm"),
    vadTrim: !flags.has("--no-vad-trim"),
    factsPass: !flags.has("--no-facts-pass"),
    factsLlm,
    factsReasoning,
  };
  const optional: Array<[string, keyof MakeReferenceArgs, string]> = [
    ["--turn-transcript", "turnTranscript", ".md"],
    ["--out", "out", ".json"],
    ["--whisper-cli-model", "whisperCliModel", ".bin"],
    ["--draft", "draft", ".json"],
  ];
  let result: MakeReferenceArgs = out;
  for (const [flag, key, extension] of optional) {
    const value = values.get(flag);
    if (value !== undefined) result = { ...result, [key]: absolutePath(flag, value, extension) };
  }
  return result;
}
