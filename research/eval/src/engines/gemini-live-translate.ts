/**
 * gemini-live-translate: Vertex AI の Gemini 3.5 Live Translate（gemini-3.5-live-translate-preview）を
 * Live API（WebSocket, BidiGenerateContent）で呼ぶ。通訳専用モデルで instructions・tools・voice 指定は無い。
 * 一次資料（2026-10-29 確認）: ai.google.dev/gemini-api/docs/live-api/live-translate（setup の形・音声形式）、
 * docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-live-translate（Vertex。location は global のみ）。
 * - 入力 16 kHz PCM16（ハーネスの 24 kHz を 3:2 に間引く）、出力 24 kHz PCM16（そのまま sink へ）。
 * - 認証は Google Cloud のアクセストークン（GOOGLE_ACCESS_TOKEN。gcloud auth print-access-token）。ログに出さない。
 * - サーバーのメッセージは binary frame の JSON で届くことがあるので、text/binary の両方を JSON として読む。
 * - 終端は realtimeInput.audioStreamEnd → turnComplete の後に音声が 1.5 秒途切れたら閉じる。
 */
import { WebSocket, type RawData } from "ws";
import type { Engine, EngineConfig, EngineFactory, EngineSecrets, EngineSink } from "../engine.ts";
import { BYTES_PER_MS } from "../engine.ts";
import { EngineError, decodeBase64Pcm, finiteNumber, isRecord, rawDataToString, resolveOptions, safeToken, transportErrorDetail } from "./index.ts";

export const GEMINI_LIVE_TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";
export const GEMINI_PROJECT_ENV = "GOOGLE_CLOUD_PROJECT";
/** token 単価（USD / 1M）。第三者集計（2026-10-29）で、公式の価格表は未確認。summary の costUsdEstimate は目安。 */
export const GEMINI_USD_PER_M_INPUT = 3.5;
export const GEMINI_USD_PER_M_OUTPUT = 21;
export const GEMINI_INPUT_RATE = 16_000;
const START_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 30_000;
/** audioStreamEnd の後、turnComplete を見てから音声が止まったと判断する無音。turnComplete が来ないときは長めに待つ。 */
const QUIET_AFTER_TURN_MS = 1_500;
const QUIET_WITHOUT_TURN_MS = 6_000;
const MAX_BUFFERED_BYTES = 2_000_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface GeminiSettings {
  readonly project: string;
  readonly location: string;
  readonly echo: boolean;
}

export function parseGeminiOptions(options: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv = process.env): GeminiSettings {
  const envProject = env[GEMINI_PROJECT_ENV]?.trim();
  const resolved = resolveOptions(options, {
    project: { ...(envProject ? { default: envProject } : {}), pattern: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u },
    location: { default: "global", pattern: /^[a-z][a-z0-9-]{1,31}$/u },
    echo: { default: "false", values: ["true", "false"] },
  });
  if (!resolved.project) throw new EngineError("INVALID_OPTION", "project");
  return { project: resolved.project, location: resolved.location!, echo: resolved.echo === "true" };
}

export function geminiLiveUrl(location: string): string {
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `wss://${host}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`;
}

/**
 * 最初のメッセージ。Vertex では inputAudioTranscription / outputAudioTranscription は setup の直下
 * （generationConfig の中に置くと 1007 Unknown name で切られる。2026-10-29 実測）。translationConfig は generationConfig の中。
 */
export function buildGeminiSetup(config: EngineConfig, settings: GeminiSettings): Record<string, unknown> {
  return {
    setup: {
      model: `projects/${settings.project}/locations/${settings.location}/publishers/google/models/${GEMINI_LIVE_TRANSLATE_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: { targetLanguageCode: config.targetLanguage, echoTargetLanguage: settings.echo },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

/** 24 kHz PCM16 → 16 kHz PCM16。3 サンプルを 2 サンプルに（先頭はそのまま、2 つ目は後ろ 2 つの平均）。端数は捨てる。 */
export function downsample24kTo16k(pcm: Buffer): Buffer {
  const groups = Math.floor(pcm.length / 6);
  const out = Buffer.alloc(groups * 4);
  for (let g = 0; g < groups; g += 1) {
    const i = g * 6;
    out.writeInt16LE(pcm.readInt16LE(i), g * 4);
    out.writeInt16LE(Math.round((pcm.readInt16LE(i + 2) + pcm.readInt16LE(i + 4)) / 2), g * 4 + 2);
  }
  return out;
}

export type GeminiEvent =
  | { kind: "setupComplete" }
  | { kind: "audio"; pcm: Buffer }
  | { kind: "outputText" | "inputText"; text: string }
  | { kind: "turnComplete" | "generationComplete" | "interrupted" }
  | { kind: "usage"; promptTokens: number; responseTokens: number }
  | { kind: "goAway"; timeLeft: string | null }
  | { kind: "error"; detail: string }
  | { kind: "unknown"; keys: string };

/** サーバーメッセージ 1 つを出来事の列にする。本文は text にだけ入る（diag に出さない）。 */
export function parseGeminiMessage(message: Record<string, unknown>): GeminiEvent[] {
  const events: GeminiEvent[] = [];
  if (isRecord(message.setupComplete)) events.push({ kind: "setupComplete" });
  if (isRecord(message.serverContent)) {
    const content = message.serverContent;
    const turn = isRecord(content.modelTurn) ? content.modelTurn : undefined;
    const parts: unknown[] = turn && Array.isArray(turn.parts) ? turn.parts : [];
    for (const part of parts) {
      const inline = isRecord(part) && isRecord(part.inlineData) ? part.inlineData : undefined;
      const pcm = inline ? decodeBase64Pcm(inline.data) : undefined;
      if (pcm) events.push({ kind: "audio", pcm });
    }
    const outText = isRecord(content.outputTranscription) ? content.outputTranscription.text : undefined;
    if (typeof outText === "string" && outText.length > 0) events.push({ kind: "outputText", text: outText });
    const inText = isRecord(content.inputTranscription) ? content.inputTranscription.text : undefined;
    if (typeof inText === "string" && inText.length > 0) events.push({ kind: "inputText", text: inText });
    if (content.turnComplete === true) events.push({ kind: "turnComplete" });
    if (content.generationComplete === true) events.push({ kind: "generationComplete" });
    if (content.interrupted === true) events.push({ kind: "interrupted" });
  }
  if (isRecord(message.usageMetadata)) {
    const usage = message.usageMetadata;
    events.push({ kind: "usage", promptTokens: finiteNumber(usage.promptTokenCount) ?? 0, responseTokens: finiteNumber(usage.responseTokenCount) ?? 0 });
  }
  if (isRecord(message.goAway)) {
    events.push({ kind: "goAway", timeLeft: typeof message.goAway.timeLeft === "string" ? safeToken(message.goAway.timeLeft) : null });
  }
  if (isRecord(message.error)) {
    const error = message.error;
    const detail = [error.status, error.code, error.message]
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .map(String)
      .join("_");
    events.push({ kind: "error", detail: safeToken(detail) });
  }
  if (events.length === 0) events.push({ kind: "unknown", keys: safeToken(Object.keys(message).sort().join(",")) });
  return events;
}

type State = "idle" | "starting" | "ready" | "closing" | "closed" | "failed";

class GeminiLiveTranslateEngine implements Engine {
  costUsd?: number;
  private socket: WebSocket | undefined;
  private state: State = "idle";
  private appendedBytes = 0;
  private droppedFrames = 0;
  private promptTokens = 0;
  private responseTokens = 0;
  private turnsCompleted = 0;
  private sawTurnCompleteAfterEnd = false;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private closeWaiter: (() => void) | undefined;
  private startWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  private readonly unhandled = new Set<string>();

  constructor(
    private readonly config: EngineConfig,
    private readonly sink: EngineSink,
    private readonly token: string,
    private readonly settings: GeminiSettings,
  ) {}

  start(): Promise<void> {
    if (this.state !== "idle") return Promise.reject(new EngineError("ENGINE_ALREADY_STARTED"));
    this.state = "starting";
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failStart("GEMINI_START_TIMEOUT"), START_TIMEOUT_MS);
      this.startWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      const socket = new WebSocket(geminiLiveUrl(this.settings.location), {
        headers: { Authorization: `Bearer ${this.token}` },
        maxPayload: MAX_PAYLOAD_BYTES,
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
      });
      this.socket = socket;
      socket.on("open", () => this.sendOrFail(buildGeminiSetup(this.config, this.settings)));
      socket.on("message", (data: RawData) => this.handleRaw(data));
      socket.on("error", error => this.handleTransportError(transportErrorDetail(error)));
      socket.on("close", (code, reason) => this.handleClose(code, safeToken(rawDataToString(reason)).slice(0, 80)));
    });
  }

  appendPcm(pcm: Buffer): void {
    if (this.state !== "ready" || !this.socket) {
      this.droppedFrames += 1;
      return;
    }
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.fail("BACKPRESSURE");
      return;
    }
    const audio = downsample24kTo16k(pcm);
    if (this.sendOrFail({ realtimeInput: { audio: { data: audio.toString("base64"), mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}` } } })) {
      this.appendedBytes += pcm.length;
    }
  }

  async finish(): Promise<void> {
    if (this.state === "ready" && this.socket) {
      this.state = "closing";
      const closed = new Promise<void>(resolve => { this.closeWaiter = resolve; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); });
      if (this.sendOrFail({ realtimeInput: { audioStreamEnd: true } })) {
        this.armQuietTimer(QUIET_WITHOUT_TURN_MS);
        await Promise.race([closed, timeout]);
      }
      clearTimeout(timer);
      this.clearQuietTimer();
      this.closeWaiter = undefined;
      if (!this.sawTurnCompleteAfterEnd) this.sink.diag("finish.incomplete", { reason: "no_turn_complete_after_end" });
    }
    this.socket?.close(1000, "eval-finish");
    if ((this.state as State) !== "failed") this.state = "closed";
    this.updateCost();
    this.sink.diag("gemini.input", { appendedMs: this.appendedBytes / BYTES_PER_MS, droppedFrames: this.droppedFrames, turnsCompleted: this.turnsCompleted });
  }

  private handleRaw(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      this.sink.diag("gemini.invalid_message", { reason: "json" });
      return;
    }
    if (!isRecord(parsed)) {
      this.sink.diag("gemini.invalid_message", { reason: "shape" });
      return;
    }
    for (const event of parseGeminiMessage(parsed)) this.handleEvent(event);
  }

  private handleEvent(event: GeminiEvent): void {
    switch (event.kind) {
      case "setupComplete": {
        if (this.state !== "starting") return;
        this.state = "ready";
        this.sink.diag("gemini.setup_complete", { model: GEMINI_LIVE_TRANSLATE_MODEL, location: this.settings.location });
        const waiter = this.startWaiter;
        this.startWaiter = undefined;
        waiter?.resolve();
        return;
      }
      case "audio":
        this.sink.outputAudio(event.pcm);
        this.touchQuiet();
        return;
      case "outputText":
        this.sink.outputTranscript(event.text);
        this.touchQuiet();
        return;
      case "inputText":
        this.sink.inputTranscript(event.text);
        return;
      case "turnComplete":
        this.turnsCompleted += 1;
        this.sink.diag("gemini.turn_complete");
        if (this.state === "closing") {
          this.sawTurnCompleteAfterEnd = true;
          this.armQuietTimer(QUIET_AFTER_TURN_MS);
        }
        return;
      case "generationComplete":
        this.sink.diag("gemini.generation_complete");
        return;
      case "interrupted":
        this.sink.diag("gemini.interrupted");
        return;
      case "usage":
        this.promptTokens += event.promptTokens;
        this.responseTokens += event.responseTokens;
        this.updateCost();
        this.sink.diag("usage", { promptTokens: event.promptTokens, responseTokens: event.responseTokens });
        return;
      case "goAway":
        this.sink.diag("gemini.go_away", { timeLeft: event.timeLeft });
        return;
      case "error":
        this.sink.diag("gemini.error", { detail: event.detail });
        if (this.state === "starting") this.failStart("GEMINI_START_REJECTED", event.detail);
        return;
      case "unknown":
        if (!this.unhandled.has(event.keys)) {
          this.unhandled.add(event.keys);
          this.sink.diag("event.unhandled", { keys: event.keys });
        }
        return;
    }
  }

  private touchQuiet(): void {
    if (this.state === "closing") this.armQuietTimer(this.sawTurnCompleteAfterEnd ? QUIET_AFTER_TURN_MS : QUIET_WITHOUT_TURN_MS);
  }

  private armQuietTimer(ms: number): void {
    this.clearQuietTimer();
    this.quietTimer = setTimeout(() => {
      if (this.state === "closing") this.closeWaiter?.();
    }, ms);
  }

  private clearQuietTimer(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
  }

  private updateCost(): void {
    this.costUsd = (this.promptTokens * GEMINI_USD_PER_M_INPUT + this.responseTokens * GEMINI_USD_PER_M_OUTPUT) / 1_000_000;
  }

  private sendOrFail(message: Record<string, unknown>): boolean {
    try {
      this.socket!.send(JSON.stringify(message));
      return true;
    } catch {
      if (this.state === "starting") this.failStart("GEMINI_TRANSPORT", "send_failed");
      else this.fail("GEMINI_TRANSPORT", "send_failed");
      return false;
    }
  }

  private handleClose(code: number, reason: string): void {
    this.sink.diag("gemini.closed", { code, reason });
    if (this.state === "starting") {
      this.failStart("GEMINI_TRANSPORT", `close_${code}_${reason}`);
    } else if (this.state === "ready") {
      this.fail("GEMINI_TRANSPORT", `close_${code}_${reason}`);
    } else if (this.state === "closing") {
      // audioStreamEnd の後にサーバー側が閉じた。
      this.closeWaiter?.();
    }
  }

  private handleTransportError(detail: string): void {
    if (this.state === "starting") this.failStart("GEMINI_TRANSPORT", detail);
    else if (this.state === "ready") this.fail("GEMINI_TRANSPORT", detail);
    else this.sink.diag("gemini.transport_error", { detail });
  }

  private failStart(code: string, detail?: string): void {
    if (this.state !== "starting") return;
    this.state = "failed";
    this.socket?.close(1000, "eval-start-failed");
    const waiter = this.startWaiter;
    this.startWaiter = undefined;
    waiter?.reject(new EngineError(code, detail));
  }

  private fail(code: string, detail?: string): void {
    if (this.state === "failed" || this.state === "closed") return;
    this.state = "failed";
    this.updateCost();
    this.sink.fatal(code, detail);
    this.socket?.close(1000, "eval-failed");
    this.closeWaiter?.();
  }
}

const createGeminiLiveTranslateEngine: EngineFactory = (config, sink, secrets) => {
  const token = secrets.googleAccessToken?.trim();
  if (!token) throw new EngineError("GOOGLE_ACCESS_TOKEN_MISSING");
  return new GeminiLiveTranslateEngine(config, sink, token, parseGeminiOptions(config.options));
};

export default createGeminiLiveTranslateEngine;
