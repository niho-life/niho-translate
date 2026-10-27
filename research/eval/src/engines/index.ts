/**
 * engineId → EngineFactory の表と、OpenAI 系エンジンの共通部品。
 * エンジンは dynamic import で読む。cascade（agent B が作成）が無い・壊れていても他のエンジンは動き、
 * cascade の実行だけが ENGINE_UNAVAILABLE になる。
 */
import { WebSocket, type RawData } from "ws";
import type { EngineFactory, TranscriptMeta } from "../engine.ts";

/** エンジンの設定・起動の失敗。code は英語、detail に鍵・本文・path を入れない。 */
export class EngineError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "EngineError";
    this.code = code;
    this.detail = detail;
  }
}

export const ENGINE_IDS = ["openai-translate", "openai-live", "openai-realtime", "cascade"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

// 文字列リテラルにしないことで、cascade が未作成でも typecheck が通る。
const CASCADE_MODULE: string = new URL("./cascade/index.ts", import.meta.url).href;

export function isEngineId(value: string): value is EngineId {
  return (ENGINE_IDS as ReadonlyArray<string>).includes(value);
}

function importEngineModule(engineId: EngineId): Promise<unknown> {
  switch (engineId) {
    case "openai-translate": return import("./openai-translate.ts");
    case "openai-live": return import("./openai-live.ts");
    case "openai-realtime": return import("./openai-realtime.ts");
    case "cascade": return import(CASCADE_MODULE) as Promise<unknown>;
  }
}

export async function loadEngineFactory(engineId: string): Promise<EngineFactory> {
  if (!isEngineId(engineId)) throw new EngineError("UNKNOWN_ENGINE", engineId.slice(0, 32));
  let module: unknown;
  try {
    module = await importEngineModule(engineId);
  } catch {
    throw new EngineError("ENGINE_UNAVAILABLE", engineId);
  }
  const factory = isRecord(module) ? module.default : undefined;
  if (typeof factory !== "function") throw new EngineError("ENGINE_UNAVAILABLE", engineId);
  return factory as EngineFactory;
}

// ---- 共通部品 ----

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface OptionSpec {
  readonly default?: string;
  readonly values?: ReadonlyArray<string>;
  readonly pattern?: RegExp;
}

/** 未知の key と値の誤りは実行前に止める（typo で既定値のまま課金しないため）。 */
export function resolveOptions<K extends string>(
  options: Readonly<Record<string, string>>,
  spec: Readonly<Record<K, OptionSpec>>,
): Record<K, string | undefined> {
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(spec, key)) throw new EngineError("UNKNOWN_OPTION", key);
  }
  const result = {} as Record<K, string | undefined>;
  for (const key of Object.keys(spec) as K[]) {
    const rule = spec[key];
    const value = Object.hasOwn(options, key) ? options[key] : rule.default;
    if (value !== undefined) {
      if (rule.values && !rule.values.includes(value)) throw new EngineError("INVALID_OPTION", key);
      if (rule.pattern && !rule.pattern.test(value)) throw new EngineError("INVALID_OPTION", key);
    }
    result[key] = value;
  }
  return result;
}

export const VOICE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/u;

/** server の error event から code / type / param だけを取る（message は本文を含みうるので捨てる）。 */
export function errorFields(event: Record<string, unknown>): Record<string, string> {
  const error = isRecord(event.error) ? event.error : {};
  const fields: Record<string, string> = {};
  for (const key of ["type", "code", "param"] as const) {
    const value = error[key];
    if (typeof value === "string" && value.length > 0) fields[key] = safeToken(value);
  }
  return fields;
}

export function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:\-]/gu, "_").slice(0, 96);
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** base64 の PCM16 を Buffer に。空・奇数長は undefined。 */
export function decodeBase64Pcm(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length % 2 !== 0) return undefined;
  return bytes;
}

export function transcriptMeta(fields: { final?: boolean; itemId?: unknown; segmentId?: unknown }): TranscriptMeta | undefined {
  const meta: { final?: boolean; itemId?: string; segmentId?: string } = {};
  if (fields.final !== undefined) meta.final = fields.final;
  if (typeof fields.itemId === "string" && fields.itemId.length > 0) meta.itemId = safeToken(fields.itemId);
  if (typeof fields.segmentId === "string" && fields.segmentId.length > 0) meta.segmentId = safeToken(fields.segmentId);
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** ws の error から鍵・path を含まない短い説明を作る。 */
export function transportErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const status = /Unexpected server response: (\d{3})/u.exec(message);
  if (status) return `http_${status[1]}`;
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/u.test(code) ? code : "transport_error";
}

export function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export interface JsonSocketHandlers {
  onOpen(): void;
  onEvent(event: Record<string, unknown> & { type: string }): void;
  onInvalid(reason: "binary" | "json" | "shape"): void;
  onClose(code: number): void;
  onError(detail: string): void;
}

export interface JsonSocket {
  /** 送れなければ例外。 */
  send(event: Record<string, unknown>): void;
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
  close(code?: number, reason?: string): void;
}

export interface JsonSocketLimits {
  readonly maxPayload: number;
  readonly handshakeTimeoutMs: number;
}

/** JSON text event の WebSocket（Live / Realtime 用）。認証は Authorization header だけ。 */
export function connectJsonSocket(url: string, apiKey: string, limits: JsonSocketLimits, handlers: JsonSocketHandlers): JsonSocket {
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    maxPayload: limits.maxPayload,
    perMessageDeflate: false,
    handshakeTimeout: limits.handshakeTimeoutMs,
  });
  socket.on("open", () => handlers.onOpen());
  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      handlers.onInvalid("binary");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      handlers.onInvalid("json");
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      handlers.onInvalid("shape");
      return;
    }
    handlers.onEvent(parsed as Record<string, unknown> & { type: string });
  });
  socket.on("error", error => handlers.onError(transportErrorDetail(error)));
  socket.on("close", code => handlers.onClose(code));
  return {
    send: event => socket.send(JSON.stringify(event)),
    get bufferedAmount() { return socket.bufferedAmount; },
    get isOpen() { return socket.readyState === WebSocket.OPEN; },
    close: (code = 1000, reason = "") => {
      try {
        if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
        else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      } catch {
        // 既に閉じている。
      }
    },
  };
}
