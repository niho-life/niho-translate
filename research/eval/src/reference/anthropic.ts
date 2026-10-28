/**
 * Anthropic Messages API（stream）で原稿の下書き・facts を作る経路。--llm anthropic:<model id> で選ぶ。
 * 要求は OpenAI Responses 形（buildDraftRequest / buildFactsRequest）のまま受け取り、ここで Messages 形に写す
 * （要求 JSON の SHA-256 がキャッシュ鍵なので、要求の形は変えない）。鍵は引数で受け、メッセージ・例外に出さない。
 */
import { OpenAIRequestError, postWithRetry, type ResponseResult, type ResponseUsage } from "./openai.ts";

const API = "https://api.anthropic.com/v1";
const API_VERSION = "2026-10-21";
export const ANTHROPIC_PREFIX = "anthropic:";

export function isAnthropicModel(model: string): boolean {
  return model.startsWith(ANTHROPIC_PREFIX);
}

/** OpenAI の reasoning.effort（none/minimal/low/medium/high/xhigh）を Anthropic の effort に写す。 */
export function mapEffort(effort: unknown): string {
  switch (effort) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return "medium";
  }
}

/** Responses 形の要求を Messages 形に写す（純関数）。instructions は system、input_text は 1 つの user turn。 */
export function toMessagesBody(request: Record<string, unknown>): Record<string, unknown> {
  const model = String(request["model"] ?? "");
  if (!isAnthropicModel(model)) throw new Error("not an anthropic model");
  const texts: string[] = [];
  if (typeof request["input"] === "string") texts.push(request["input"]);
  for (const item of Array.isArray(request["input"]) ? request["input"] : []) {
    const rec = item as Record<string, unknown>;
    for (const c of Array.isArray(rec["content"]) ? rec["content"] : []) {
      const content = c as Record<string, unknown>;
      if (content["type"] === "input_text" && typeof content["text"] === "string") texts.push(content["text"]);
    }
  }
  const format = ((request["text"] as Record<string, unknown> | undefined)?.["format"] ?? {}) as Record<string, unknown>;
  const reasoning = (request["reasoning"] ?? {}) as Record<string, unknown>;
  return {
    model: model.slice(ANTHROPIC_PREFIX.length),
    max_tokens: typeof request["max_output_tokens"] === "number" ? request["max_output_tokens"] : 32_000,
    stream: true,
    ...(typeof request["instructions"] === "string" ? { system: request["instructions"] } : {}),
    messages: [{ role: "user", content: texts.join("\n") }],
    thinking: { type: "adaptive" },
    output_config: {
      effort: mapEffort(reasoning["effort"]),
      ...(format["type"] === "json_schema" && format["schema"] !== undefined ? { format: { type: "json_schema", schema: format["schema"] } } : {}),
    },
  };
}

export interface StreamState {
  text: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export function newStreamState(): StreamState {
  return { text: "", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, stopReason: null };
}

/** SSE の 1 イベント（data の JSON）を状態に反映する。error イベントは例外。 */
export function applyStreamEvent(state: StreamState, event: Record<string, unknown>): void {
  const type = event["type"];
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  if (type === "message_start") {
    const usage = ((event["message"] as Record<string, unknown> | undefined)?.["usage"] ?? {}) as Record<string, unknown>;
    state.cachedInputTokens = num(usage["cache_read_input_tokens"]);
    state.inputTokens = num(usage["input_tokens"]) + num(usage["cache_creation_input_tokens"]) + state.cachedInputTokens;
    state.outputTokens = num(usage["output_tokens"]);
  } else if (type === "content_block_delta") {
    const delta = (event["delta"] ?? {}) as Record<string, unknown>;
    if (delta["type"] === "text_delta" && typeof delta["text"] === "string") state.text += delta["text"];
  } else if (type === "message_delta") {
    const delta = (event["delta"] ?? {}) as Record<string, unknown>;
    if (typeof delta["stop_reason"] === "string") state.stopReason = delta["stop_reason"];
    const usage = (event["usage"] ?? {}) as Record<string, unknown>;
    if (typeof usage["output_tokens"] === "number") state.outputTokens = usage["output_tokens"];
  } else if (type === "error") {
    const err = (event["error"] ?? {}) as Record<string, unknown>;
    throw new OpenAIRequestError(0, `stream error: ${String(err["type"] ?? "")} ${String(err["message"] ?? "")}`);
  }
}

/** end_turn → completed、max_tokens → incomplete。それ以外（refusal 等）は stop_reason をそのまま status にする。 */
export function finishStream(state: StreamState): ResponseResult {
  const status = state.stopReason === "end_turn" ? "completed" : state.stopReason === "max_tokens" ? "incomplete" : (state.stopReason ?? "unknown");
  const usage: ResponseUsage = {
    inputTokens: state.inputTokens,
    cachedInputTokens: state.cachedInputTokens,
    outputTokens: state.outputTokens,
    // thinking の token は output_tokens に含まれ、内訳は返らない
    reasoningTokens: 0,
  };
  return { status, text: state.text, usage };
}

/** Messages API を stream で呼び、完了時の本文と usage を返す。 */
export async function createAnthropicResponse(apiKey: string, request: Record<string, unknown>, timeoutMs = 1_200_000): Promise<ResponseResult> {
  const body = toMessagesBody(request);
  const response = await postWithRetry(`${API}/messages`, () => ({
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": API_VERSION, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }), 1);
  if (response.body === null) throw new OpenAIRequestError(0, "empty stream");
  const state = newStreamState();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (block: string): void => {
    const data = block
      .split("\n")
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0) return;
    applyStreamEvent(state, JSON.parse(data) as Record<string, unknown>);
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
  if (state.stopReason === null) throw new OpenAIRequestError(0, "stream ended without message_delta");
  return finishStream(state);
}
