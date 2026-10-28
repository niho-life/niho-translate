/**
 * Anthropic Messages API（Node 24 の fetch だけ）。判定の構造化出力（output_config.format = json_schema）に使う。
 * 鍵は引数で受け、エラーに出さない。thinking は adaptive（Claude 4.6 以降のモデル）、深さは --effort。
 */
import { fetchWithRetry, type Usage } from "./http.ts";

const API_BASE = "https://api.anthropic.com/v1";
/** API 版。temperature 等は送らない。 */
const API_VERSION = "2026-10-21";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface AnthropicJsonRequest {
  readonly apiKey: string;
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly schema: Record<string, unknown>;
  readonly effort?: string;
  /** thinking の token も含む上限。 */
  readonly maxOutputTokens?: number;
}

/** 送信本文（純関数）。instructions は system、input は 1 つの user turn。 */
export function buildAnthropicBody(req: Omit<AnthropicJsonRequest, "apiKey">): Record<string, unknown> {
  return {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? 32_000,
    system: req.instructions,
    messages: [{ role: "user", content: req.input }],
    thinking: { type: "adaptive" },
    output_config: {
      format: { type: "json_schema", schema: req.schema },
      ...(req.effort ? { effort: req.effort } : {}),
    },
  };
}

interface AnthropicMessage {
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  content?: ReadonlyArray<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** 応答を JSON 値と usage にする（純関数）。refusal / max_tokens は例外。本文はエラーに含めない。 */
export function parseAnthropicResponse(json: unknown): { value: unknown; usage: Usage } {
  const msg = (typeof json === "object" && json !== null ? json : {}) as AnthropicMessage;
  const usage: Usage = {
    inputTokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0) + (msg.usage?.cache_read_input_tokens ?? 0),
    outputTokens: msg.usage?.output_tokens ?? 0,
    // thinking の token は output_tokens に含まれ、内訳は返らない
    reasoningTokens: 0,
  };
  if (msg.stop_reason === "refusal") {
    throw new Error(`judge refused the request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ""}`);
  }
  if (msg.stop_reason === "max_tokens") throw new Error("judge response hit max_tokens");
  const text = (msg.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
  if (text.length === 0) throw new Error("judge response has no text");
  try {
    return { value: JSON.parse(text), usage };
  } catch {
    throw new Error("judge output is not valid JSON");
  }
}

/** POST /v1/messages（非 stream）。構造化出力の JSON を返す。 */
export async function createAnthropicJsonResponse(req: AnthropicJsonRequest): Promise<{ value: unknown; usage: Usage }> {
  const { apiKey, ...rest } = req;
  const body = buildAnthropicBody(rest);
  const res = await fetchWithRetry(
    `${API_BASE}/messages`,
    () => ({
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": API_VERSION, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "judge request (anthropic)",
  );
  return parseAnthropicResponse(await res.json());
}
