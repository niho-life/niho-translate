/**
 * HTTP の共通部（Node 24 の fetch だけ）。OpenAI と Anthropic の呼び出しで共有する。
 * 鍵はヘッダにだけ入れ、エラー文からは伏せる。
 */

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

/** sk- で始まる文字列（OpenAI・Anthropic の鍵、マスク済みを含む）を伏せ、長さを切る。 */
export function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_\-*]{4,}/g, "sk-***").slice(0, 400);
}

/** 一時的な失敗。529 は Anthropic の overloaded。 */
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

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
export async function fetchWithRetry(url: string, init: () => RequestInit, label: string, attempts = 4, timeoutMs = 300_000): Promise<Response> {
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
