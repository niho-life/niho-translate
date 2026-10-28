/**
 * OpenAI HTTP 呼び出し（Node 24 の fetch だけ）。鍵は引数で受け、エラーに出さない。
 * 再試行・伏せ字・Usage は http.ts（Anthropic と共有）。
 */
import { fetchWithRetry, redactSecrets, type Usage } from "./http.ts";

export { redactSecrets, type Usage };

const API_BASE = "https://api.openai.com/v1";

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
