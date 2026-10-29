/**
 * Qwen3.8 LiveTranslate の研究用 WebSocket adapter。
 * 一次資料: https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen3-5-livetranslate-flash-realtime
 *              https://docs.modelstudio.console.alibabacloud.com/en/model-studio/live-translator-client-events
 *              https://docs.modelstudio.console.alibabacloud.com/en/model-studio/live-translator-server-events
 * 16 kHz PCM16 入力、24 kHz PCM16 出力。音声/字幕本文は private run のみ。
 */
import { WebSocket, type RawData } from "ws";
import type { Engine, EngineConfig, EngineFactory, EngineSink } from "../engine.ts";
import { EngineError, decodeBase64Pcm, isRecord, rawDataToString, resolveOptions, safeToken, transportErrorDetail } from "./index.ts";
import { Pcm24To16Resampler } from "./resample-24k-16k.ts";

export const QWEN_MODEL = "qwen3.8-livetranslate-flash-realtime";
const START_TIMEOUT_MS = 15_000;
const FINISH_TIMEOUT_MS = 18_000;
const MAX_BUFFERED_BYTES = 2_000_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface QwenOptions {
  readonly workspace: string;
  readonly region: "singapore" | "beijing";
  readonly hotwords: Readonly<Record<string, string>>;
  readonly turnDetection: "speaker" | "server-vad";
}

export function parseQwenOptions(options: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv = process.env): QwenOptions {
  const workspace = env.QWEN_WORKSPACE_ID?.trim();
  const resolved = resolveOptions(options, {
    region: { default: "singapore", values: ["singapore", "beijing"] },
    hotwords: { default: "off", values: ["off", "env"] },
    turnDetection: { default: "speaker", values: ["speaker", "server-vad"] },
  });
  if (!workspace || !/^[A-Za-z0-9][A-Za-z0-9-]{2,79}$/u.test(workspace)) throw new EngineError("QWEN_WORKSPACE_ID_MISSING_OR_INVALID");
  const hotwords: Record<string, string> = Object.create(null) as Record<string, string>;
  if (resolved.hotwords === "env") {
    const json = env.QWEN_HOTWORDS_JSON;
    if (!json || json.length > 8_192) throw new EngineError("QWEN_HOTWORDS_JSON_MISSING_OR_INVALID");
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { throw new EngineError("QWEN_HOTWORDS_JSON_MISSING_OR_INVALID"); }
    if (!isRecord(parsed) || Object.keys(parsed).length > 20) throw new EngineError("QWEN_HOTWORDS_JSON_MISSING_OR_INVALID");
    for (const [source, target] of Object.entries(parsed)) {
      if (source.trim().length < 1 || source.length > 80 || source === "__proto__" || source === "constructor"
        || typeof target !== "string" || target.trim().length < 1 || target.length > 120) {
        throw new EngineError("QWEN_HOTWORDS_JSON_MISSING_OR_INVALID");
      }
      hotwords[source] = target;
    }
  }
  return { workspace, region: resolved.region as QwenOptions["region"], hotwords,
    turnDetection: resolved.turnDetection as QwenOptions["turnDetection"] };
}

export function qwenUrl(settings: QwenOptions): string {
  const region = settings.region === "singapore" ? "ap-southeast-1" : "cn-beijing";
  return `wss://${settings.workspace}.${region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${QWEN_MODEL}`;
}

export function qwenSessionUpdate(config: EngineConfig, settings: QwenOptions): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      output_modalities: ["text", "audio"],
      audio: { input: { turn_detection: settings.turnDetection === "speaker"
        ? { type: "speaker_detection", threshold: 0.5 }
        : { type: "server_vad" } } },
      translation: {
        language: config.targetLanguage,
        ...(Object.keys(settings.hotwords).length ? { corpus: { phrases: settings.hotwords } } : {}),
      },
    },
  };
}

export type QwenEvent =
  | { kind: "ready" | "finished" | "responseDone" }
  | { kind: "audio"; pcm: Buffer }
  | { kind: "inputText" | "outputText"; text: string; itemId: string | undefined }
  | { kind: "inputFinal"; text: string; itemId: string | undefined }
  | { kind: "remoteError"; code: string }
  | { kind: "invalidAudio" }
  | { kind: "ignore" };

/** 本文は text / pcm のみに保持し、未知 event・error.message を診断へ出さない。 */
export function parseQwenEvent(value: unknown): QwenEvent {
  if (!isRecord(value) || typeof value.type !== "string") return { kind: "ignore" };
  const itemId = typeof value.item_id === "string" ? safeToken(value.item_id) : undefined;
  switch (value.type) {
    case "session.updated": return { kind: "ready" };
    case "session.finished": return { kind: "finished" };
    case "response.done": return { kind: "responseDone" };
    case "response.audio.delta": {
      const pcm = decodeBase64Pcm(value.delta);
      if (!pcm || pcm.subarray(0, 4).toString("ascii") === "RIFF") return { kind: "invalidAudio" };
      return { kind: "audio", pcm };
    }
    case "conversation.item.input_audio_transcription.delta":
      return typeof value.delta === "string" ? { kind: "inputText", text: value.delta, itemId } : { kind: "ignore" };
    case "conversation.item.input_audio_transcription.completed":
      return typeof value.transcript === "string" ? { kind: "inputFinal", text: value.transcript, itemId } : { kind: "ignore" };
    case "response.audio_transcript.delta":
      return typeof value.delta === "string" ? { kind: "outputText", text: value.delta, itemId } : { kind: "ignore" };
    case "error": {
      const error = isRecord(value.error) ? value.error : {};
      const code = typeof error.code === "string" || typeof error.code === "number" ? safeToken(String(error.code)) : "unknown";
      return { kind: "remoteError", code };
    }
    default: return { kind: "ignore" };
  }
}

type State = "idle" | "starting" | "ready" | "finishing" | "finished" | "failed";

class QwenLiveTranslateEngine implements Engine {
  private socket: WebSocket | undefined;
  private state: State = "idle";
  private startWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  private finishWaiter: (() => void) | undefined;
  private readonly inputDelta = new Map<string, string>();
  private responseCount = 0;
  private readonly resampler = new Pcm24To16Resampler();

  constructor(private readonly config: EngineConfig, private readonly sink: EngineSink, private readonly apiKey: string, private readonly settings: QwenOptions) {}

  start(): Promise<void> {
    if (this.state !== "idle") return Promise.reject(new EngineError("ENGINE_ALREADY_STARTED"));
    this.state = "starting";
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail("QWEN_START_TIMEOUT"), START_TIMEOUT_MS);
      this.startWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      const socket = new WebSocket(qwenUrl(this.settings), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        maxPayload: MAX_PAYLOAD_BYTES,
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
      });
      this.socket = socket;
      socket.on("open", () => this.send(qwenSessionUpdate(this.config, this.settings)));
      socket.on("message", (data: RawData) => this.handleRaw(data));
      socket.on("error", error => this.fail("QWEN_TRANSPORT_ERROR", transportErrorDetail(error)));
      socket.on("close", () => {
        if (this.state !== "finished" && this.state !== "failed") this.fail("QWEN_CLOSED_EARLY");
      });
      this.sink.diag("qwen.hotwords", { count: Object.keys(this.settings.hotwords).length });
    });
  }

  appendPcm(pcm: Buffer): void {
    if (this.state !== "ready" || !this.socket) return;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) { this.fail("QWEN_BACKPRESSURE"); return; }
    this.send({ type: "input_audio_buffer.append", audio: this.resampler.process(pcm).toString("base64") });
  }

  async finish(): Promise<void> {
    if (this.state !== "ready") { this.closeSocket(); return; }
    this.state = "finishing";
    const finished = new Promise<void>(resolve => { this.finishWaiter = resolve; });
    this.send({ type: "session.finish" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([finished, new Promise<void>(resolve => { timer = setTimeout(resolve, FINISH_TIMEOUT_MS); })]);
    clearTimeout(timer);
    if (this.state === "finishing") this.fail("QWEN_FINISH_TIMEOUT");
    this.finishWaiter = undefined;
    this.closeSocket();
    this.sink.diag("qwen.responses", { count: this.responseCount });
  }

  private send(event: Record<string, unknown>): void {
    try {
      if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("socket closed");
      this.socket.send(JSON.stringify(event));
    } catch { this.fail("QWEN_SEND_FAILED"); }
  }

  private handleRaw(data: RawData): void {
    let parsed: unknown;
    try { parsed = JSON.parse(rawDataToString(data)); } catch { this.fail("QWEN_INVALID_JSON"); return; }
    const event = parseQwenEvent(parsed);
    if (this.state === "failed" || this.state === "finished") return;
    switch (event.kind) {
      case "ready":
        if (this.state === "starting") { this.state = "ready"; this.startWaiter?.resolve(); this.startWaiter = undefined; }
        break;
      case "audio": this.sink.outputAudio(event.pcm); break;
      case "inputText": {
        this.sink.inputTranscript(event.text, event.itemId ? { itemId: event.itemId } : undefined);
        if (event.itemId) this.inputDelta.set(event.itemId, (this.inputDelta.get(event.itemId) ?? "") + event.text);
        break;
      }
      case "inputFinal": {
        const seen = event.itemId ? this.inputDelta.get(event.itemId) ?? "" : "";
        if (!seen) this.sink.inputTranscript(event.text, { final: true, ...(event.itemId ? { itemId: event.itemId } : {}) });
        else if (event.text.startsWith(seen) && event.text.length > seen.length) {
          this.sink.inputTranscript(event.text.slice(seen.length), { final: true, ...(event.itemId ? { itemId: event.itemId } : {}) });
        } else if (seen !== event.text) {
          this.sink.diag("qwen.input_revision.text", { itemId: event.itemId ?? "unknown", transcript: event.text });
        }
        if (event.itemId) this.inputDelta.delete(event.itemId);
        break;
      }
      case "outputText": this.sink.outputTranscript(event.text, event.itemId ? { itemId: event.itemId } : undefined); break;
      case "responseDone": this.responseCount += 1; break;
      case "finished":
        if (this.state !== "finishing") { this.fail("QWEN_FINISHED_EARLY"); break; }
        this.state = "finished";
        this.finishWaiter?.();
        break;
      case "remoteError": this.fail("QWEN_REMOTE_ERROR", event.code); break;
      case "invalidAudio": this.fail("QWEN_AUDIO_FORMAT"); break;
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
    try {
      if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
      else if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, "eval-finish");
    } catch { /* A closed socket needs no further action. */ }
  }
}

const factory: EngineFactory = (config, sink, secrets) => {
  if (!secrets.qwenApiKey) throw new EngineError("DASHSCOPE_API_KEY_MISSING");
  if (config.sourceLanguage === config.targetLanguage) throw new EngineError("INVALID_LANGUAGE_PAIR");
  return new QwenLiveTranslateEngine(config, sink, secrets.qwenApiKey, parseQwenOptions(config.options));
};

export default factory;
