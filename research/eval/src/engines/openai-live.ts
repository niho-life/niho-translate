/**
 * openai-live: GPT-Live（gpt-live-1）の primary WebSocket に通訳専用の instructions を渡す。
 * 一次資料（2026-10-28 確認）: developers.openai.com/api/docs/guides/voice-websockets?api=live、
 * /api/reference/resources/live/primary-websocket、/api/docs/guides/live-conversations。
 * - 接続 wss://api.openai.com/v1/live/sessions（query なし、Authorization: Bearer のみ）。
 * - 最初に session.start、session.started を待ってから session.input_audio.append。
 * - 原文字幕 session.input_transcript.delta は設定なしで常に届く（有効化の設定は無い）。
 * - 終端は session.close → session.closed（最終 usage.seconds と reason）。
 * - delegation は省略（= client）。通訳では backend へ委ねない。
 */
import type { Engine, EngineConfig, EngineFactory, EngineSecrets, EngineSink } from "../engine.ts";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BYTES_PER_MS, PCM_SAMPLE_RATE } from "../engine.ts";
import { buildInterpreterInstructions, INTERPRETER_PRESETS, type InterpreterPreset } from "../prompts/interpreter.ts";
import {
  EngineError,
  VOICE_PATTERN,
  connectJsonSocket,
  decodeBase64Pcm,
  errorFields,
  finiteNumber,
  isRecord,
  resolveOptions,
  safeToken,
  type JsonSocket,
} from "./index.ts";

export const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
export const LIVE_MODEL = "gpt-live-1";
/** 2026-10-28 公示: $0.05/分、秒単位課金（usage.seconds）。 */
export const LIVE_USD_PER_MIN = 0.05;
const START_TIMEOUT_MS = 15_000;
/** session.closed を待つ上限（公式例は 15 s。ハーネスの --finish-timeout-sec が先に効く）。 */
const CLOSE_TIMEOUT_MS = 30_000;
const MAX_BUFFERED_BYTES = 2_000_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface LiveSettings {
  readonly preset: InterpreterPreset;
  readonly voice: string;
  /** Research-only. Plain text kept in the private evaluation directory. */
  readonly context: string | null;
}

export function parseLiveOptions(options: Readonly<Record<string, string>>): LiveSettings {
  const resolved = resolveOptions(options, {
    preset: { default: "domain", values: INTERPRETER_PRESETS },
    voice: { default: "marin", pattern: VOICE_PATTERN },
    contextFile: {},
  });
  if (resolved.preset === "official-short" && resolved.contextFile !== undefined) {
    throw new EngineError("INVALID_OPTION", "contextFile");
  }
  let context: string | null = null;
  if (resolved.contextFile !== undefined) {
    if (!isAbsolute(resolved.contextFile)) throw new EngineError("INVALID_OPTION", "contextFile");
    try { context = readFileSync(resolved.contextFile, "utf8").trim(); }
    catch { throw new EngineError("INVALID_OPTION", "contextFile"); }
    if (context.length < 20 || context.length > 800 || /[\u0000-\u001f]/u.test(context)) throw new EngineError("INVALID_OPTION", "contextFile");
  }
  return { preset: resolved.preset as InterpreterPreset, voice: resolved.voice!, context };
}

export function buildLiveSessionStart(config: EngineConfig, settings: LiveSettings): Record<string, unknown> {
  return {
    type: "session.start",
    event_id: "evt_eval_start",
    session: {
      model: LIVE_MODEL,
      instructions: buildInterpreterInstructions(settings.preset, config.sourceLanguage, config.targetLanguage, settings.context ?? undefined),
      audio: {
        format: { type: "audio/pcm", rate: PCM_SAMPLE_RATE },
        output: { voice: settings.voice },
      },
    },
  };
}

type State = "idle" | "starting" | "ready" | "closing" | "closed" | "failed";

class LiveEngine implements Engine {
  costUsd?: number;
  private socket: JsonSocket | undefined;
  private state: State = "idle";
  private usageSeconds: number | undefined;
  private sessionStartedAt: number | undefined;
  private appendedBytes = 0;
  private droppedFrames = 0;
  private sessionClosed = false;
  private closeWaiter: (() => void) | undefined;
  private startWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  private readonly unhandled = new Set<string>();

  constructor(
    private readonly config: EngineConfig,
    private readonly sink: EngineSink,
    private readonly secrets: EngineSecrets,
    private readonly settings: LiveSettings,
  ) {}

  start(): Promise<void> {
    if (this.state !== "idle") return Promise.reject(new EngineError("ENGINE_ALREADY_STARTED"));
    this.state = "starting";
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failStart("LIVE_START_TIMEOUT"), START_TIMEOUT_MS);
      this.startWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      this.socket = connectJsonSocket(LIVE_URL, this.secrets.openaiApiKey, {
        maxPayload: MAX_PAYLOAD_BYTES,
        handshakeTimeoutMs: 10_000,
      }, {
        onOpen: () => this.sendOrFail(buildLiveSessionStart(this.config, this.settings)),
        onEvent: event => this.handleEvent(event),
        onInvalid: reason => this.sink.diag("live.invalid_message", { reason }),
        onClose: code => this.handleClose(code),
        onError: detail => this.handleTransportError(detail),
      });
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
    if (this.sendOrFail({ type: "session.input_audio.append", audio: pcm.toString("base64") })) {
      this.appendedBytes += pcm.length;
    }
  }

  async finish(): Promise<void> {
    if (this.state === "ready" && this.socket) {
      this.state = "closing";
      const closed = new Promise<void>(resolve => { this.closeWaiter = resolve; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); });
      if (this.sendOrFail({ type: "session.close", event_id: "evt_eval_close" })) {
        await Promise.race([closed, timeout]);
      }
      clearTimeout(timer);
      this.closeWaiter = undefined;
      if (!this.sessionClosed) {
        this.sink.diag("finish.incomplete", { reason: this.state === "closing" ? "session_closed_timeout" : "socket_closed_first" });
      }
    }
    this.socket?.close(1000, "eval-finish");
    if ((this.state as State) !== "failed") this.state = "closed";
    this.updateCost();
    this.sink.diag("live.input", { appendedMs: this.appendedBytes / BYTES_PER_MS, droppedFrames: this.droppedFrames });
  }

  private handleEvent(event: Record<string, unknown> & { type: string }): void {
    switch (event.type) {
      case "session.started": {
        if (this.state !== "starting") return;
        this.state = "ready";
        this.sessionStartedAt = performance.now();
        const session = isRecord(event.session) ? event.session : {};
        const expiresAt = finiteNumber(session.expires_at);
        this.sink.diag("live.session", {
          model: typeof session.model === "string" ? safeToken(session.model) : null,
          expiresInSec: expiresAt === undefined ? null : Math.round(expiresAt - Date.now() / 1_000),
        });
        const waiter = this.startWaiter;
        this.startWaiter = undefined;
        waiter?.resolve();
        return;
      }
      case "session.output_audio.delta": {
        const pcm = decodeBase64Pcm(event.delta);
        if (pcm) this.sink.outputAudio(pcm);
        else this.sink.diag("live.invalid_audio");
        return;
      }
      case "session.output_transcript.delta":
        this.transcript("out", event);
        return;
      case "session.input_transcript.delta":
        this.transcript("in", event);
        return;
      case "session.usage.updated": {
        const usage = isRecord(event.usage) ? event.usage : {};
        const seconds = finiteNumber(usage.seconds);
        if (seconds !== undefined) this.usageSeconds = seconds;
        const contextWindow = isRecord(event.context_window) ? event.context_window : {};
        this.updateCost();
        this.sink.diag("usage", { seconds: seconds ?? null, contextUsageRatio: finiteNumber(contextWindow.usage_ratio) ?? null });
        return;
      }
      case "session.closed": {
        const usage = isRecord(event.usage) ? event.usage : {};
        const seconds = finiteNumber(usage.seconds);
        if (seconds !== undefined) this.usageSeconds = seconds;
        this.sessionClosed = true;
        this.updateCost();
        this.sink.diag("usage", { seconds: seconds ?? null, final: true });
        this.sink.diag("live.closed", { reason: typeof event.reason === "string" ? safeToken(event.reason) : null });
        if (this.state === "closing") {
          this.state = "closed";
          this.closeWaiter?.();
        } else if (this.state === "ready") {
          // 期限切れ・安全フィルタなどで server が先に閉じた。
          this.fail("LIVE_SESSION_CLOSED", typeof event.reason === "string" ? safeToken(event.reason) : undefined);
        }
        return;
      }
      case "error": {
        const fields = errorFields(event);
        this.sink.diag("live.error", fields);
        if (this.state === "starting") this.failStart("LIVE_START_REJECTED", fields.code);
        return;
      }
      case "info":
        this.sink.diag("live.info", { code: typeof event.code === "string" ? safeToken(event.code) : null });
        return;
      case "session.delegation.created":
        this.sink.diag("live.delegation.created");
        return;
      default:
        if (!this.unhandled.has(event.type)) {
          this.unhandled.add(event.type);
          this.sink.diag("event.unhandled", { type: safeToken(event.type) });
        }
    }
  }

  private transcript(stream: "in" | "out", event: Record<string, unknown>): void {
    const delta = event.delta;
    if (typeof delta !== "string" || delta.length === 0) return;
    if (stream === "out") this.sink.outputTranscript(delta);
    else this.sink.inputTranscript(delta);
    const startMs = finiteNumber(event.start_ms);
    const endMs = finiteNumber(event.end_ms);
    // session timeline 上の区間（model 内部の遅れの分析用。本文なし）。
    if (startMs !== undefined || endMs !== undefined) {
      this.sink.diag("live.transcript.timing", { stream, startMs: startMs ?? null, endMs: endMs ?? null });
    }
  }

  private updateCost(): void {
    let seconds = this.usageSeconds;
    if (seconds === undefined && this.sessionStartedAt !== undefined) {
      seconds = (performance.now() - this.sessionStartedAt) / 1_000;
    }
    if (seconds !== undefined) this.costUsd = (seconds / 60) * LIVE_USD_PER_MIN;
  }

  private sendOrFail(event: Record<string, unknown>): boolean {
    try {
      this.socket!.send(event);
      return true;
    } catch {
      if (this.state === "starting") this.failStart("LIVE_TRANSPORT", "send_failed");
      else this.fail("LIVE_TRANSPORT", "send_failed");
      return false;
    }
  }

  private handleClose(code: number): void {
    if (this.state === "starting") {
      this.failStart("LIVE_TRANSPORT", `close_${code}`);
    } else if (this.state === "ready") {
      this.fail("LIVE_TRANSPORT", `close_${code}`);
    } else if (this.state === "closing") {
      // session.closed より先に socket が閉じた。
      this.state = "failed";
      this.closeWaiter?.();
    }
  }

  private handleTransportError(detail: string): void {
    if (this.state === "starting") this.failStart("LIVE_TRANSPORT", detail);
    else if (this.state === "ready") this.fail("LIVE_TRANSPORT", detail);
    else this.sink.diag("live.transport_error", { detail });
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

const createLiveEngine: EngineFactory = (config, sink, secrets) =>
  new LiveEngine(config, sink, secrets, parseLiveOptions(config.options));

export default createLiveEngine;
