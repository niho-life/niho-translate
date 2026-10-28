/**
 * openai-translate: 現行製品経路（gpt-realtime-translate）。
 * packages/provider-openai の OpenAITranslationProvider を relay-local と同じ Node `ws` transport で使う。
 * 出力の完全無音 200 ms 上限・先頭無音の破棄・入力検査・backpressure・health ping・drain まで製品と同じ。
 *
 * 既定以外のオプション（noiseReduction=far_field|none、inputTranscription=1）は、provider が送る
 * session.update の audio.input だけを transport で書き換える。event 処理と無音規則は provider の
 * 同じコードのままにするため、別実装の client を持たない。
 */
import { WebSocket } from "ws";
import {
  OpenAITranslationProvider,
  PROVIDER_DRAIN_TIMEOUT_MS,
  type ProviderSink,
  type ProviderTransport,
  type ProviderTransportFactory,
} from "../../../../packages/provider-openai/src/index.ts";
import type { Engine, EngineConfig, EngineFactory, EngineSecrets, EngineSink } from "../engine.ts";
import { BYTES_PER_MS } from "../engine.ts";
import { EngineError, errorFields, isRecord, resolveOptions, safeToken, transportErrorDetail } from "./index.ts";

/** 2026-10-28 公示: gpt-realtime-translate $0.034/分、gpt-realtime-whisper $0.017/分（音声長課金）。 */
export const TRANSLATE_USD_PER_MIN = 0.034;
export const WHISPER_USD_PER_MIN = 0.017;
export const SOURCE_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
/** provider 自身の connect timeout（5 s）より長い保険。 */
const START_TIMEOUT_MS = 15_000;
/** 制御 event（error / session.updated）だけを覗く。大きい音声 delta は二重に parse しない。 */
const PEEK_MAX_CHARS = 16_384;

export type NoiseReduction = "near_field" | "far_field" | "none";

export interface TranslateSettings {
  readonly noiseReduction: NoiseReduction;
  readonly inputTranscription: boolean;
}

export function parseTranslateOptions(options: Readonly<Record<string, string>>): TranslateSettings {
  const resolved = resolveOptions(options, {
    noiseReduction: { default: "near_field", values: ["near_field", "far_field", "none"] },
    inputTranscription: { default: "0", values: ["0", "1"] },
  });
  return {
    noiseReduction: resolved.noiseReduction as NoiseReduction,
    inputTranscription: resolved.inputTranscription === "1",
  };
}

export function isProductDefault(settings: TranslateSettings): boolean {
  return settings.noiseReduction === "near_field" && !settings.inputTranscription;
}

/**
 * provider が送る text frame のうち session.update だけ audio.input を書き換える。
 * 既定設定では入力をそのまま返す（製品と同じ byte 列）。形が想定外なら例外。
 */
export function rewriteTranslateSessionUpdate(data: string, settings: TranslateSettings): string {
  if (isProductDefault(settings) || !data.includes("session.update")) return data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return data;
  }
  if (!isRecord(parsed) || parsed.type !== "session.update") return data;
  const session = parsed.session;
  const audio = isRecord(session) ? session.audio : undefined;
  const input = isRecord(audio) ? audio.input : undefined;
  if (!isRecord(input)) throw new EngineError("TRANSLATE_CONFIG_REWRITE_FAILED");
  input.noise_reduction = settings.noiseReduction === "none" ? null : { type: settings.noiseReduction };
  input.transcription = settings.inputTranscription ? { model: SOURCE_TRANSCRIPTION_MODEL } : null;
  return JSON.stringify(parsed);
}

/** session.updated の解決済み設定（本文なし）。 */
export function describeTranslateSession(event: Record<string, unknown>): Record<string, string | null> {
  const session = isRecord(event.session) ? event.session : {};
  const audio = isRecord(session.audio) ? session.audio : {};
  const input = isRecord(audio.input) ? audio.input : {};
  const output = isRecord(audio.output) ? audio.output : {};
  const pick = (value: unknown) => (typeof value === "string" ? safeToken(value) : null);
  return {
    model: pick(session.model),
    noiseReduction: isRecord(input.noise_reduction) ? pick(input.noise_reduction.type) : null,
    transcriptionModel: isRecord(input.transcription) ? pick(input.transcription.model) : null,
    outputLanguage: pick(output.language),
  };
}

class TranslateEngine implements Engine {
  costUsd?: number;
  private provider: OpenAITranslationProvider | undefined;
  private socket: WebSocket | undefined;
  private ready = false;
  private failedCode: string | undefined;
  private rewriteFailed = false;
  private appendedBytes = 0;
  private rejectedFrames = 0;
  private collecting: Buffer[] | undefined;
  private startWaiter: { resolve(): void; reject(error: Error): void } | undefined;

  constructor(
    private readonly config: EngineConfig,
    private readonly sink: EngineSink,
    private readonly secrets: EngineSecrets,
    private readonly settings: TranslateSettings,
  ) {}

  start(): Promise<void> {
    if (this.provider) return Promise.reject(new EngineError("ENGINE_ALREADY_STARTED"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.startFailed("TRANSLATE_START_TIMEOUT"), START_TIMEOUT_MS);
      this.startWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      const factory: ProviderTransportFactory = { connect: (url, headers) => this.connect(url, headers) };
      const providerSink: ProviderSink = {
        onOutputAudio: base64 => this.handleOutputAudio(base64),
        onOutputTranscript: delta => this.sink.outputTranscript(delta),
        onInputTranscript: delta => this.sink.inputTranscript(delta),
        onFatal: code => this.handleProviderFatal(code),
      };
      try {
        this.provider = new OpenAITranslationProvider(
          this.secrets.openaiApiKey,
          this.config.targetLanguage,
          factory,
          providerSink,
        );
      } catch {
        this.startFailed("TRANSLATE_START_FAILED");
      }
    });
  }

  appendPcm(pcm: Buffer): void {
    if (!this.provider || !this.ready || this.failedCode !== undefined) {
      this.rejectedFrames += 1;
      return;
    }
    if (this.provider.appendPcm(pcm.toString("base64"))) {
      this.appendedBytes += pcm.length;
      this.costUsd = this.estimateCost();
    } else {
      this.rejectedFrames += 1;
    }
  }

  async finish(): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    if (this.ready && this.failedCode === undefined) {
      // 製品と同じ: session.close → session.closed（最大 15 s）。
      await provider.close(PROVIDER_DRAIN_TIMEOUT_MS);
      if (!provider.outputDrained) this.sink.diag("finish.incomplete", { reason: "session_closed_missing" });
    } else {
      await provider.close(1_000);
    }
    this.sink.diag("translate.input", {
      appendedMs: this.appendedBytes / BYTES_PER_MS,
      rejectedFrames: this.rejectedFrames,
      productDefault: isProductDefault(this.settings),
    });
  }

  private estimateCost(): number {
    const minutes = this.appendedBytes / BYTES_PER_MS / 60_000;
    return minutes * (TRANSLATE_USD_PER_MIN + (this.settings.inputTranscription ? WHISPER_USD_PER_MIN : 0));
  }

  /** examples/relay-local/src/server.ts の NodeWsFactory と同じ transport（送信の書き換えと覗き見だけ追加）。 */
  private connect(url: string, headers: Readonly<Record<string, string>>): ProviderTransport {
    const socket = new WebSocket(url, {
      headers: { Authorization: headers.Authorization! },
      maxPayload: 65_536,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on("error", error => this.sink.diag("translate.transport_error", { detail: transportErrorDetail(error) }));
    return {
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      ping: payload => socket.ping(payload),
      onPong: handler => socket.on("pong", data => handler(data.toString("utf8"))),
      send: data => socket.send(this.rewriteOutgoing(data)),
      close: (code, reason) => socket.close(code, reason),
      onOpen: handler => socket.on("open", handler),
      onMessage: handler => socket.on("message", (data, isBinary) => {
        this.deliver(isBinary ? new Uint8Array(data as Buffer) : (data as Buffer).toString("utf8"), handler);
      }),
      onClose: handler => socket.on("close", handler),
      onError: handler => socket.on("error", handler),
    };
  }

  private rewriteOutgoing(data: string): string {
    try {
      return rewriteTranslateSessionUpdate(data, this.settings);
    } catch (error) {
      this.rewriteFailed = true;
      throw error;
    }
  }

  /**
   * provider へ 1 message を渡す。provider が 1 つの音声 delta を 100 ms ごとに分けて同期で返すので、
   * 同じ message 内の分割を 1 chunk に戻して sink へ渡す（到着した区切りを保つ。無音の切り詰めは provider のまま）。
   */
  private deliver(value: string | Uint8Array, handler: (data: string | Uint8Array) => void): void {
    const peeked = typeof value === "string" && value.length <= PEEK_MAX_CHARS ? peekEvent(value) : undefined;
    if (peeked?.type === "error") this.sink.diag("translate.error", errorFields(peeked));
    const parts: Buffer[] = [];
    this.collecting = parts;
    try {
      handler(value);
    } finally {
      this.collecting = undefined;
      if (parts.length > 0) this.sink.outputAudio(parts.length === 1 ? parts[0]! : Buffer.concat(parts));
    }
    if (peeked?.type === "session.updated" && !this.ready && this.failedCode === undefined && this.startWaiter) {
      this.ready = true;
      this.sink.diag("translate.session", describeTranslateSession(peeked));
      const waiter = this.startWaiter;
      this.startWaiter = undefined;
      waiter.resolve();
    }
  }

  private handleOutputAudio(base64: string): void {
    const pcm = Buffer.from(base64, "base64");
    if (this.collecting) this.collecting.push(pcm);
    else this.sink.outputAudio(pcm);
  }

  private handleProviderFatal(code: string): void {
    const resolved = this.rewriteFailed ? "TRANSLATE_CONFIG_REWRITE_FAILED" : code;
    if (!this.ready) {
      this.startFailed(resolved);
      return;
    }
    if (this.failedCode !== undefined) return;
    this.failedCode = resolved;
    this.sink.fatal(resolved);
  }

  private startFailed(code: string): void {
    if (this.failedCode === undefined) this.failedCode = code;
    const waiter = this.startWaiter;
    this.startWaiter = undefined;
    if (!waiter) return;
    void this.provider?.close(0);
    this.socket?.terminate();
    waiter.reject(new EngineError(code));
  }
}

function peekEvent(value: string): (Record<string, unknown> & { type: string }) | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && typeof parsed.type === "string" ? (parsed as Record<string, unknown> & { type: string }) : undefined;
  } catch {
    return undefined;
  }
}

const createTranslateEngine: EngineFactory = (config, sink, secrets) =>
  new TranslateEngine(config, sink, secrets, parseTranslateOptions(config.options));

export default createTranslateEngine;
