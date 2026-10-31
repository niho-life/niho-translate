/** Research-only Kotoba S2ST adapter. No product path uses this engine.
 * Protocol: https://fal.ai/models/kotoba-technologies/kotoba-sts/v1/realtime_voice/api
 * SDK cross-check: https://github.com/kotoba-tech/kotoba-python/blob/main/src/kotoba/_ws_s2st.py
 */
import { WebSocket, type RawData } from "ws";
import type { Engine, EngineConfig, EngineFactory, EngineSink } from "../engine.ts";
import { EngineError, decodeBase64Pcm, isRecord, rawDataToString, resolveOptions, safeToken, transportErrorDetail } from "./index.ts";

export const KOTOBA_URL = "wss://fal.run/kotoba-technologies/kotoba-sts/v1/realtime_voice";
const START_TIMEOUT_MS = 240_000; // fal may cold-start a GPU runner before the handshake.
const FINISH_TIMEOUT_MS = 60_000;
const MAX_BUFFERED_BYTES = 2_000_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const PRICE_USD_PER_MINUTE = 0.035; // fal lists session duration, not input-audio duration.

export interface KotobaOptions { readonly delay: number | undefined }

export function parseKotobaOptions(options: Readonly<Record<string, string>>): KotobaOptions {
  const resolved = resolveOptions(options, { delay: { pattern: /^(?:[0-9]|1[0-9]|20)$/u } });
  return { delay: resolved.delay === undefined ? undefined : Number(resolved.delay) };
}

export function kotobaSessionUpdate(config: EngineConfig, options: KotobaOptions): Record<string, unknown> {
  return {
    type: "voice_session.update",
    session: {
      object: "realtime.voice_session",
      turn_detection: false,
      input_audio_format: "pcm16",
      input_audio_sample_rate: 24_000,
      input_audio_number_of_channels: 1,
      input_audio_transcription: { language: config.sourceLanguage, target_language: config.targetLanguage },
      ...(options.delay === undefined ? {} : { delay: options.delay }),
    },
  };
}

export type KotobaEvent =
  | { kind: "ready" | "finished" | "ignore" }
  | { kind: "audio"; pcm: Buffer }
  | { kind: "text"; text: string; itemId: string | undefined }
  | { kind: "remoteError"; code: string }
  | { kind: "invalidAudio" };

export function parseKotobaEvent(value: unknown): KotobaEvent {
  if (!isRecord(value) || typeof value.type !== "string") return { kind: "ignore" };
  switch (value.type) {
    case "voice_session.updated": return { kind: "ready" };
    case "input_audio_buffer.committed": return { kind: "finished" };
    case "conversation.item.input_audio_transcription.text.delta":
      return typeof value.delta === "string" && value.delta.length > 0
        ? { kind: "text", text: value.delta, itemId: typeof value.item_id === "string" ? safeToken(value.item_id) : undefined }
        : { kind: "ignore" };
    case "conversation.item.input_audio_transcription.audio.delta": {
      const pcm = decodeBase64Pcm(value.delta);
      return pcm && pcm.subarray(0, 4).toString("ascii") !== "RIFF" ? { kind: "audio", pcm } : { kind: "invalidAudio" };
    }
    case "error": {
      const error = isRecord(value.error) ? value.error : {};
      return { kind: "remoteError", code: safeToken(String(error.code ?? "unknown")) };
    }
    default: return { kind: "ignore" };
  }
}

type State = "idle" | "starting" | "ready" | "finishing" | "finished" | "failed";

class KotobaLiveTranslateEngine implements Engine {
  private socket: WebSocket | undefined;
  private state: State = "idle";
  private startWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  private finishWaiter: (() => void) | undefined;
  private activeAtMs: number | undefined;
  private closedAtMs: number | undefined;
  private nextEventId = 0;

  constructor(private readonly config: EngineConfig, private readonly sink: EngineSink,
    private readonly apiKey: string, private readonly options: KotobaOptions) {}

  get costUsd(): number {
    return this.activeAtMs === undefined ? 0
      : ((this.closedAtMs ?? performance.now()) - this.activeAtMs) / 60_000 * PRICE_USD_PER_MINUTE;
  }

  start(): Promise<void> {
    if (this.state !== "idle") return Promise.reject(new EngineError("ENGINE_ALREADY_STARTED"));
    this.state = "starting";
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail("KOTOBA_START_TIMEOUT"), START_TIMEOUT_MS);
      this.startWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      const socket = new WebSocket(KOTOBA_URL, {
        headers: { Authorization: `Key ${this.apiKey}` },
        maxPayload: MAX_PAYLOAD_BYTES,
        // Match the documented ws client defaults; the server negotiates compression if available.
        perMessageDeflate: true,
        handshakeTimeout: START_TIMEOUT_MS - 5_000,
      });
      this.socket = socket;
      socket.on("open", () => this.send(kotobaSessionUpdate(this.config, this.options)));
      socket.on("message", (data: RawData, isBinary: boolean) => this.handleRaw(data, isBinary));
      socket.on("error", error => this.fail("KOTOBA_TRANSPORT_ERROR", transportErrorDetail(error)));
      socket.on("close", () => {
        if (this.state !== "finished" && this.state !== "failed") this.fail("KOTOBA_CLOSED_EARLY");
      });
      this.sink.diag("kotoba.delay", { tokens: this.options.delay ?? "provider-default" });
    });
  }

  appendPcm(pcm: Buffer): void {
    if (this.state !== "ready" || !this.socket) return;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) { this.fail("KOTOBA_BACKPRESSURE"); return; }
    this.send({ event_id: String(++this.nextEventId).padStart(7, "0"), type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }

  async finish(): Promise<void> {
    if (this.state !== "ready") { this.closeSocket(); return; }
    this.state = "finishing";
    const finished = new Promise<void>(resolve => { this.finishWaiter = resolve; });
    this.send({ type: "input_audio_buffer.commit" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([finished, new Promise<void>(resolve => { timer = setTimeout(resolve, FINISH_TIMEOUT_MS); })]);
    clearTimeout(timer);
    if (this.state === "finishing") this.fail("KOTOBA_FINISH_TIMEOUT");
    this.finishWaiter = undefined;
    this.closeSocket();
  }

  private send(event: Record<string, unknown>): void {
    try {
      if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("socket closed");
      this.socket.send(JSON.stringify(event));
    } catch { this.fail("KOTOBA_SEND_FAILED"); }
  }

  private handleRaw(data: RawData, isBinary: boolean): void {
    if (isBinary) { this.fail("KOTOBA_UNEXPECTED_BINARY"); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(rawDataToString(data)); } catch { this.fail("KOTOBA_INVALID_JSON"); return; }
    const event = parseKotobaEvent(parsed);
    if (this.state === "failed" || this.state === "finished") return;
    switch (event.kind) {
      case "ready":
        if (this.state === "starting") { this.state = "ready"; this.activeAtMs = performance.now(); this.startWaiter?.resolve(); this.startWaiter = undefined; }
        break;
      case "audio": this.sink.outputAudio(event.pcm); break;
      case "text":
        // fal realtime_voice の実接続では、入力転記というイベント名でも内容は英訳だった。
        this.sink.outputTranscript(event.text, event.itemId ? { itemId: event.itemId } : undefined);
        break;
      case "finished":
        if (this.state !== "finishing") { this.fail("KOTOBA_COMMITTED_EARLY"); break; }
        this.state = "finished";
        this.finishWaiter?.();
        break;
      case "remoteError": this.fail("KOTOBA_REMOTE_ERROR", event.code); break;
      case "invalidAudio": this.fail("KOTOBA_AUDIO_FORMAT"); break;
      case "ignore": break;
    }
  }

  private fail(code: string, detail?: string): void {
    if (this.state === "failed" || this.state === "finished") return;
    this.state = "failed";
    this.startWaiter?.reject(new EngineError(code, detail));
    this.startWaiter = undefined;
    this.finishWaiter?.();
    this.closeSocket();
    this.sink.fatal(code, detail);
  }

  private closeSocket(): void {
    if (!this.socket) return;
    this.closedAtMs ??= performance.now();
    try {
      if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
      else if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, "eval-finish");
    } catch { /* Already closed. */ }
  }
}

const factory: EngineFactory = (config, sink, secrets) => {
  if (!secrets.falApiKey) throw new EngineError("FAL_KEY_MISSING");
  if (config.sourceLanguage === config.targetLanguage) throw new EngineError("INVALID_LANGUAGE_PAIR");
  return new KotobaLiveTranslateEngine(config, sink, secrets.falApiKey, parseKotobaOptions(config.options));
};

export default factory;
