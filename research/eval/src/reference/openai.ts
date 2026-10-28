/**
 * OpenAI API（Node 24 の fetch だけ）。鍵は引数で受け、メッセージ・例外に出さない。
 * - POST /v1/audio/transcriptions（multipart）
 * - POST /v1/responses（stream: true の SSE。応答待ちで fetch の既定 300 秒 headers timeout に当たらないように）
 */

const API = "https://api.openai.com/v1";

/** エラー本文から鍵らしい文字列を消す。 */
export function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_*-]{4,}/g, "sk-***").replace(/Bearer\s+[A-Za-z0-9._*-]+/gi, "Bearer ***");
}

export class OpenAIRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(redactSecrets(message));
    this.name = "OpenAIRequestError";
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function errorMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string; code?: string } };
    const e = parsed.error;
    if (e !== undefined) return `${response.status} ${e.type ?? ""} ${e.code ?? ""} ${e.message ?? ""}`.replace(/\s+/g, " ").trim();
  } catch {
    // JSON でなければ先頭だけ
  }
  return `${response.status} ${body.slice(0, 200)}`;
}

/** 429 / 5xx / 通信失敗だけ最大 retries 回やり直す。 */
export async function postWithRetry(url: string, init: () => RequestInit, retries = 2): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(attempt * 4_000);
    try {
      const response = await fetch(url, init());
      if (response.ok) return response;
      const message = await errorMessage(response);
      if (response.status !== 429 && response.status < 500) throw new OpenAIRequestError(response.status, message);
      lastError = new OpenAIRequestError(response.status, message);
    } catch (error) {
      if (error instanceof OpenAIRequestError && error.status !== 429 && error.status < 500) throw error;
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw new OpenAIRequestError(lastError instanceof OpenAIRequestError ? lastError.status : 0, lastError.message);
  throw new OpenAIRequestError(0, "request failed");
}

export async function transcribe(apiKey: string, wav: Buffer, fields: ReadonlyArray<readonly [string, string]>, timeoutMs = 600_000): Promise<unknown> {
  const response = await postWithRetry(`${API}/audio/transcriptions`, () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "clip.wav");
    for (const [k, v] of fields) form.append(k, v);
    return { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(timeoutMs) };
  });
  return (await response.json()) as unknown;
}

export interface ResponseUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export interface ResponseResult {
  readonly status: string;
  readonly text: string;
  readonly usage: ResponseUsage;
}

function readUsage(value: unknown): ResponseUsage {
  const u = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const inputDetails = (u["input_tokens_details"] ?? {}) as Record<string, unknown>;
  const outputDetails = (u["output_tokens_details"] ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u["input_tokens"]),
    cachedInputTokens: num(inputDetails["cached_tokens"]),
    outputTokens: num(u["output_tokens"]),
    reasoningTokens: num(outputDetails["reasoning_tokens"]),
  };
}

function outputText(response: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const item of Array.isArray(response["output"]) ? response["output"] : []) {
    const rec = item as Record<string, unknown>;
    if (rec["type"] !== "message") continue;
    for (const c of Array.isArray(rec["content"]) ? rec["content"] : []) {
      const content = c as Record<string, unknown>;
      if (content["type"] === "output_text" && typeof content["text"] === "string") parts.push(content["text"]);
    }
  }
  return parts.join("");
}

/** Responses API を stream で呼び、完了イベントの応答を返す。 */
export async function createResponse(apiKey: string, body: Record<string, unknown>, timeoutMs = 1_200_000): Promise<ResponseResult> {
  const response = await postWithRetry(`${API}/responses`, () => ({
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  }), 1);
  if (response.body === null) throw new OpenAIRequestError(0, "empty stream");
  const decoder = new TextDecoder();
  let buffer = "";
  const state: { deltas: string; final: Record<string, unknown> | null } = { deltas: "", final: null };
  const handle = (block: string): void => {
    const data = block
      .split("\n")
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0 || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = event["type"];
    if (type === "response.output_text.delta" && typeof event["delta"] === "string") state.deltas += event["delta"];
    else if (type === "response.completed" || type === "response.incomplete") state.final = event["response"] as Record<string, unknown>;
    else if (type === "response.failed") {
      const r = event["response"] as Record<string, unknown> | undefined;
      const err = (r?.["error"] ?? {}) as Record<string, unknown>;
      throw new OpenAIRequestError(0, `response failed: ${String(err["code"] ?? "")} ${String(err["message"] ?? "")}`);
    } else if (type === "error") {
      throw new OpenAIRequestError(0, `stream error: ${String(event["code"] ?? "")} ${String(event["message"] ?? "")}`);
    }
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      handle(block.replace(/\r/g, ""));
    }
  }
  if (buffer.trim().length > 0) handle(buffer.replace(/\r/g, ""));
  const finalResponse = state.final;
  if (finalResponse === null) throw new OpenAIRequestError(0, "stream ended without a final response");
  const text = outputText(finalResponse) || state.deltas;
  return { status: String(finalResponse["status"] ?? ""), text, usage: readUsage(finalResponse["usage"]) };
}
