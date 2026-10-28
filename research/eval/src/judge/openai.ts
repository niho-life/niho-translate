/**
 * OpenAI HTTP 呼び出し（Node 24 の fetch だけ）。鍵は引数で受け、エラーに出さない。
 */

const API_BASE = "https://api.openai.com/v1";
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

/** sk- で始まる文字列（マスク済みを含む）を伏せ、長さを切る。 */
export function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_\-*]{4,}/g, "sk-***").slice(0, 400);
}

async function errorSummary(res: Response): Promise<string> {
  let detail = "";
  try {
    const body: unknown = await res.json();
    const err = typeof body === "object" && body !== null ? (body as { error?: { type?: unknown; code?: unknown; message?: unknown } }).error : undefined;
    if (err) detail = [err.type, err.code, err.message].filter((v) => typeof v === "string" && v).join(": ");
  } catch {
    // 本文を出さない
  }
  return redactSecrets(`HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 一時的な失敗（429/5xx/通信）だけ最大 attempts 回まで再試行する。 */
async function fetchWithRetry(url: string, init: () => RequestInit, label: string, attempts = 4, timeoutMs = 300_000): Promise<Response> {
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { ...init(), signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
      lastError = await errorSummary(res);
      if (!RETRY_STATUS.has(res.status)) break;
    } catch (error) {
      lastError = redactSecrets(error instanceof Error ? `${error.name}: ${error.message}` : "network error");
    }
    if (attempt < attempts) await sleep(1_500 * 2 ** (attempt - 1));
  }
  throw new Error(`${label} failed: ${lastError}`);
}

export interface WhisperWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

export interface WhisperVerbose {
  readonly text: string;
  readonly duration?: number;
  readonly words?: ReadonlyArray<WhisperWord>;
  readonly segments?: ReadonlyArray<{ readonly start: number; readonly end: number; readonly text: string; readonly no_speech_prob?: number }>;
}

/** whisper-1 / verbose_json / word+segment の時刻付き文字起こし。 */
export async function transcribeWav(apiKey: string, wav: Buffer, model = "whisper-1", language = "en", prompt = ""): Promise<WhisperVerbose> {
  const res = await fetchWithRetry(
    `${API_BASE}/audio/transcriptions`,
    () => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
      form.append("model", model);
      form.append("language", language);
      form.append("response_format", "verbose_json");
      form.append("temperature", "0");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      if (prompt) form.append("prompt", prompt);
      return { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form };
    },
    "transcription",
  );
  const body = (await res.json()) as WhisperVerbose;
  if (typeof body.text !== "string") throw new Error("transcription response has no text");
  return body;
}

/** 時刻なしの文字起こし（gpt-4o-transcribe など。照合用）。 */
export async function transcribeText(apiKey: string, wav: Buffer, model: string, language = "en"): Promise<string> {
  const res = await fetchWithRetry(
    `${API_BASE}/audio/transcriptions`,
    () => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
      form.append("model", model);
      form.append("language", language);
      form.append("response_format", "json");
      return { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form };
    },
    "cross-check transcription",
  );
  const body = (await res.json()) as { text?: unknown };
  if (typeof body.text !== "string") throw new Error("cross-check transcription has no text");
  return body.text;
}

export interface JsonResponseRequest {
  readonly apiKey: string;
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly schemaName: string;
  readonly schema: Record<string, unknown>;
  /** reasoning 系モデル（gpt-5* / o*）にだけ送る。 */
  readonly effort?: string;
  readonly maxOutputTokens?: number;
}

export function supportsReasoning(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

/** Responses API + strict JSON schema。output_text を JSON として返す。store=false。 */
export async function createJsonResponse(req: JsonResponseRequest): Promise<{ value: unknown; usage: Usage }> {
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.instructions,
    input: req.input,
    store: false,
    max_output_tokens: req.maxOutputTokens ?? 32_000,
    text: { format: { type: "json_schema", name: req.schemaName, strict: true, schema: req.schema } },
  };
  if (req.effort && supportsReasoning(req.model)) body.reasoning = { effort: req.effort };
  const res = await fetchWithRetry(
    `${API_BASE}/responses`,
    () => ({
      method: "POST",
      headers: { Authorization: `Bearer ${req.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    "judge request",
  );
  const json = (await res.json()) as {
    status?: string;
    incomplete_details?: { reason?: string } | null;
    output?: ReadonlyArray<{ type?: string; content?: ReadonlyArray<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
  };
  const usage: Usage = {
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    reasoningTokens: json.usage?.output_tokens_details?.reasoning_tokens ?? 0,
  };
  if (json.status && json.status !== "completed") {
    throw new Error(`judge response ${json.status}${json.incomplete_details?.reason ? `: ${json.incomplete_details.reason}` : ""}`);
  }
  const parts: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "refusal") throw new Error("judge refused the request");
      if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  if (parts.length === 0) throw new Error("judge response has no output_text");
  try {
    return { value: JSON.parse(parts.join("")), usage };
  } catch {
    throw new Error("judge output is not valid JSON");
  }
}
