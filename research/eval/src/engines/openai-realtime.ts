/**
 * openai-realtime: Realtime API（GA）の speech-to-speech を通訳指示で使う。
 * 一次資料（2026-10-28 確認）: /api/docs/guides/realtime-conversations、/api/docs/guides/realtime-vad、
 * /api/reference/resources/realtime/client-events、/server-events、各 model page。
 * - 接続 wss://api.openai.com/v1/realtime?model=<model>。GA なので OpenAI-Beta header は送らない。
 * - session.created の後に session.update {type: realtime, output_modalities: [audio], ...}、session.updated で ready。
 * - VAD が turn を確定し create_response で応答を作る。finish は無音を送り続けて進行中の response.done を待つ。
 * - 費用は response.done の usage と model page の単価から推定（cached input を区別する）。
 */
import type { Engine, EngineConfig, EngineFactory, EngineSecrets, EngineSink } from "../engine.ts";
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
  transcriptMeta,
  type JsonSocket,
} from "./index.ts";

export const REALTIME_URL = "wss://api.openai.com/v1/realtime";
export const REALTIME_MODELS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"] as const;
export type RealtimeModel = (typeof REALTIME_MODELS)[number];
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

const START_TIMEOUT_MS = 15_000;
/** finish の内部上限（ハーネスの --finish-timeout-sec が先に効く）。 */
const FINISH_LIMIT_MS = 60_000;
/** 応答も VAD も動かない時間がこれだけ続いたら流し終わりとみなす。 */
const SETTLE_IDLE_MS = 1_500;
const MAX_BUFFERED_BYTES = 2_000_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** USD / 1M tokens（2026-10-28 の model page）。 */
export interface RealtimePrice {
  readonly textIn: number;
  readonly textCachedIn: number;
  readonly textOut: number;
  readonly audioIn: number;
  readonly audioCachedIn: number;
  readonly audioOut: number;
}

export const REALTIME_PRICES: Readonly<Record<RealtimeModel, RealtimePrice>> = {
  "gpt-realtime-2.1": { textIn: 4, textCachedIn: 0.4, textOut: 24, audioIn: 32, audioCachedIn: 0.4, audioOut: 64 },
  "gpt-realtime-2.1-mini": { textIn: 0.6, textCachedIn: 0.06, textOut: 2.4, audioIn: 10, audioCachedIn: 0.3, audioOut: 20 },
};

/** 入力字幕の ASR 単価（分かるものだけ）。 */
const TRANSCRIPTION_PRICES: Readonly<Record<string, { readonly perMinute?: number; readonly inPer1M?: number; readonly outPer1M?: number }>> = {
  "gpt-4o-mini-transcribe": { inPer1M: 1.25, outPer1M: 5 },
  "gpt-transcribe": { perMinute: 0.0045 },
  "gpt-realtime-whisper": { perMinute: 0.017 },
};

export type TurnDetection =
  | {
    readonly type: "semantic_vad";
    readonly eagerness: "low" | "medium" | "high" | "auto";
    readonly create_response: true;
    readonly interrupt_response: boolean;
  }
  | {
    readonly type: "server_vad";
    readonly silence_duration_ms: number;
    readonly create_response: true;
    readonly interrupt_response: boolean;
  };

export interface RealtimeSettings {
  readonly model: RealtimeModel;
  readonly turnDetection: TurnDetection;
  readonly preset: InterpreterPreset;
  readonly inputTranscription: boolean;
  readonly transcriptionModel: string;
  readonly voice: string;
  readonly reasoning: (typeof REASONING_EFFORTS)[number] | undefined;
}

/** `semantic:high|medium|low|auto` または `server:<silence_ms>`。 */
export function parseVad(value: string, interrupt: boolean): TurnDetection {
  const semantic = /^semantic:(low|medium|high|auto)$/u.exec(value);
  if (semantic) {
    return {
      type: "semantic_vad",
      eagerness: semantic[1] as "low" | "medium" | "high" | "auto",
      create_response: true,
      interrupt_response: interrupt,
    };
  }
  const server = /^server:(\d{2,5})$/u.exec(value);
  const silenceMs = server ? Number(server[1]) : NaN;
  if (silenceMs >= 50 && silenceMs <= 10_000) {
    return { type: "server_vad", silence_duration_ms: silenceMs, create_response: true, interrupt_response: interrupt };
  }
  throw new EngineError("INVALID_OPTION", "vad");
}

export function parseRealtimeOptions(options: Readonly<Record<string, string>>): RealtimeSettings {
  const resolved = resolveOptions(options, {
    model: { default: "gpt-realtime-2.1", values: REALTIME_MODELS },
    vad: { default: "semantic:high" },
    interrupt: { default: "0", values: ["0", "1"] },
    preset: { default: "domain", values: INTERPRETER_PRESETS },
    inputTranscription: { default: "0", values: ["0", "1"] },
    transcriptionModel: { default: "gpt-4o-mini-transcribe", pattern: /^[a-z0-9][a-z0-9.-]{2,63}$/u },
    voice: { default: "marin", pattern: VOICE_PATTERN },
    reasoning: { values: REASONING_EFFORTS },
  });
  return {
    model: resolved.model as RealtimeModel,
    turnDetection: parseVad(resolved.vad!, resolved.interrupt === "1"),
    preset: resolved.preset as InterpreterPreset,
    inputTranscription: resolved.inputTranscription === "1",
    transcriptionModel: resolved.transcriptionModel!,
    voice: resolved.voice!,
    reasoning: resolved.reasoning as RealtimeSettings["reasoning"],
  };
}

export function realtimeUrl(model: RealtimeModel): string {
  return `${REALTIME_URL}?model=${encodeURIComponent(model)}`;
}

export function buildRealtimeSessionUpdate(config: EngineConfig, settings: RealtimeSettings): Record<string, unknown> {
  const format = { type: "audio/pcm", rate: PCM_SAMPLE_RATE };
  const input: Record<string, unknown> = { format, turn_detection: settings.turnDetection };
  if (settings.inputTranscription) {
    input.transcription = { model: settings.transcriptionModel, language: config.sourceLanguage };
  }
  const session: Record<string, unknown> = {
    type: "realtime",
    output_modalities: ["audio"],
    instructions: buildInterpreterInstructions(settings.preset, config.sourceLanguage, config.targetLanguage),
    audio: { input, output: { format, voice: settings.voice } },
  };
  if (settings.reasoning !== undefined) session.reasoning = { effort: settings.reasoning };
  return { type: "session.update", event_id: "evt_eval_session", session };
}

export interface UsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly audioIn: number;
  readonly audioCachedIn: number;
  readonly textIn: number;
  readonly textCachedIn: number;
  readonly audioOut: number;
  readonly textOut: number;
}

/** response.done の usage。内訳の無い token は audio 単価で数える（費用を低く見積もらない）。 */
export function readUsageTokens(usage: unknown): UsageTokens | undefined {
  if (!isRecord(usage)) return undefined;
  const count = (value: unknown) => Math.max(0, finiteNumber(value) ?? 0);
  const input = isRecord(usage.input_token_details) ? usage.input_token_details : {};
  const cached = isRecord(input.cached_tokens_details) ? input.cached_tokens_details : {};
  const output = isRecord(usage.output_token_details) ? usage.output_token_details : {};
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  const textIn = count(input.text_tokens);
  const imageIn = count(input.image_tokens);
  const textOut = count(output.text_tokens);
  const audioIn = count(input.audio_tokens) + Math.max(0, inputTokens - count(input.audio_tokens) - textIn - imageIn);
  const audioOut = count(output.audio_tokens) + Math.max(0, outputTokens - count(output.audio_tokens) - textOut);
  return {
    inputTokens,
    outputTokens,
    audioIn,
    audioCachedIn: Math.min(audioIn, count(cached.audio_tokens)),
    textIn,
    textCachedIn: Math.min(textIn, count(cached.text_tokens)),
    audioOut,
    textOut,
  };
}

export function realtimeCostUsd(model: RealtimeModel, tokens: UsageTokens): number {
  const price = REALTIME_PRICES[model];
  return (
    (tokens.audioIn - tokens.audioCachedIn) * price.audioIn
    + tokens.audioCachedIn * price.audioCachedIn
    + (tokens.textIn - tokens.textCachedIn) * price.textIn
    + tokens.textCachedIn * price.textCachedIn
    + tokens.audioOut * price.audioOut
    + tokens.textOut * price.textOut
  ) / 1_000_000;
}

/** 入力字幕の usage（tokens / duration）。単価が分からない model は 0。 */
export function transcriptionCostUsd(model: string, usage: unknown): number {
  const price = TRANSCRIPTION_PRICES[model];
  if (!price || !isRecord(usage)) return 0;
  if (usage.type === "duration") return ((finiteNumber(usage.seconds) ?? 0) / 60) * (price.perMinute ?? 0);
  return ((finiteNumber(usage.input_tokens) ?? 0) * (price.inPer1M ?? 0) + (finiteNumber(usage.output_tokens) ?? 0) * (price.outPer1M ?? 0)) / 1_000_000;
}

/** 応答・字幕・VAD の節目以外で、何もしない server event。 */
const IGNORED_EVENTS = new Set([
  "rate_limits.updated",
  "conversation.created",
  "conversation.item.added",
  "conversation.item.created",
  "conversation.item.done",
  "conversation.item.input_audio_transcription.delta",
  "conversation.item.input_audio_transcription.segment",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_audio.done",
  "response.output_audio_transcript.done",
  "input_audio_buffer.cleared",
]);

type State = "idle" | "connecting" | "configuring" | "ready" | "finishing" | "closed" | "failed";

class RealtimeEngine implements Engine {
  costUsd?: number;
  private socket: JsonSocket | undefined;
  private state: State = "idle";
  private readonly inflight = new Set<string>();
  private readonly pendingTranscripts = new Set<string>();
  private speechActive = false;
  private lastActivityAt = 0;
  private responseCostUsd = 0;
  private transcriptionCostUsdTotal = 0;
  private appendedBytes = 0;
  private pumpedBytes = 0;
  private droppedFrames = 0;
  private responses = 0;
  private settleCheck: (() => void) | undefined;
  private startWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  private readonly unhandled = new Set<string>();

  constructor(
    private readonly config: EngineConfig,
    private readonly sink: EngineSink,
    private readonly secrets: EngineSecrets,
    private readonly settings: RealtimeSettings,
  ) {}

  start(): Promise<void> {
    if (this.state !== "idle") return Promise.reject(new EngineError("ENGINE_ALREADY_STARTED"));
    this.state = "connecting";
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failStart("REALTIME_START_TIMEOUT"), START_TIMEOUT_MS);
      this.startWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      this.socket = connectJsonSocket(realtimeUrl(this.settings.model), this.secrets.openaiApiKey, {
        maxPayload: MAX_PAYLOAD_BYTES,
        handshakeTimeoutMs: 10_000,
      }, {
        onOpen: () => {},
        onEvent: event => this.handleEvent(event),
        onInvalid: reason => this.sink.diag("realtime.invalid_message", { reason }),
        onClose: code => this.handleClose(code),
        onError: detail => this.handleTransportError(detail),
      });
    });
  }

  appendPcm(pcm: Buffer): void {
    if (this.state !== "ready") {
      this.droppedFrames += 1;
      return;
    }
    if (this.sendAudio(pcm)) this.appendedBytes += pcm.length;
  }

  async finish(): Promise<void> {
    if (this.state === "ready") {
      this.state = "finishing";
      const settled = await this.waitForSettle();
      if (!settled) {
        this.sink.diag("finish.incomplete", {
          reason: (this.state as State) === "failed" ? "transport_failed" : "responses_pending",
          inflight: this.inflight.size,
          speechActive: this.speechActive,
          pendingTranscripts: this.pendingTranscripts.size,
        });
      }
    }
    this.socket?.close(1000, "eval-finish");
    if ((this.state as State) !== "failed") this.state = "closed";
    this.sink.diag("realtime.input", {
      appendedMs: this.appendedBytes / BYTES_PER_MS,
      finishSilenceMs: this.pumpedBytes / BYTES_PER_MS,
      droppedFrames: this.droppedFrames,
      responses: this.responses,
    });
  }

  /** 無音を実時間で送り続け、応答・VAD・入力字幕が止まったら true。上限か通信断なら false。 */
  private waitForSettle(): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const silence = Buffer.alloc(this.config.frameMs * BYTES_PER_MS);
      let done = false;
      const end = (value: boolean) => {
        if (done) return;
        done = true;
        clearInterval(pump);
        clearTimeout(limit);
        this.settleCheck = undefined;
        resolve(value);
      };
      const check = () => {
        if (this.state !== "finishing") end(false);
        else if (this.isSettled()) end(true);
      };
      const pump = setInterval(() => {
        if (this.state === "finishing" && this.sendAudio(silence)) this.pumpedBytes += silence.length;
        check();
      }, this.config.frameMs);
      const limit = setTimeout(() => end(false), FINISH_LIMIT_MS);
      this.settleCheck = check;
      check();
    });
  }

  private isSettled(): boolean {
    return this.inflight.size === 0
      && !this.speechActive
      && this.pendingTranscripts.size === 0
      && performance.now() - this.lastActivityAt >= SETTLE_IDLE_MS;
  }

  private sendAudio(pcm: Buffer): boolean {
    const socket = this.socket;
    if (!socket) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.fail("BACKPRESSURE");
      return false;
    }
    try {
      socket.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
      return true;
    } catch {
      this.fail("REALTIME_TRANSPORT", "send_failed");
      return false;
    }
  }

  private touch(): void {
    this.lastActivityAt = performance.now();
  }

  private handleEvent(event: Record<string, unknown> & { type: string }): void {
    switch (event.type) {
      case "session.created":
        if (this.state !== "connecting") return;
        this.state = "configuring";
        try {
          this.socket!.send(buildRealtimeSessionUpdate(this.config, this.settings));
        } catch {
          this.failStart("REALTIME_TRANSPORT", "send_failed");
        }
        return;
      case "session.updated":
        if (this.state !== "configuring") return;
        this.state = "ready";
        this.touch();
        this.sink.diag("realtime.session", describeRealtimeSession(event));
        this.startWaiter?.resolve();
        this.startWaiter = undefined;
        return;
      case "input_audio_buffer.speech_started":
        this.speechActive = true;
        this.touch();
        this.sink.diag("vad.speech_started", { audioStartMs: finiteNumber(event.audio_start_ms) ?? null, itemId: idOf(event.item_id) });
        return;
      case "input_audio_buffer.speech_stopped":
        this.speechActive = false;
        this.touch();
        this.sink.diag("vad.speech_stopped", { audioEndMs: finiteNumber(event.audio_end_ms) ?? null, itemId: idOf(event.item_id) });
        this.settleCheck?.();
        return;
      case "input_audio_buffer.committed": {
        this.touch();
        const itemId = idOf(event.item_id);
        if (this.settings.inputTranscription && itemId) this.pendingTranscripts.add(itemId);
        this.sink.diag("vad.committed", { itemId });
        return;
      }
      case "response.created": {
        this.touch();
        const id = responseId(event);
        if (id) this.inflight.add(id);
        this.responses += 1;
        this.sink.diag("response.created", { responseId: id });
        return;
      }
      case "response.output_audio.delta": {
        this.touch();
        const pcm = decodeBase64Pcm(event.delta);
        if (pcm) this.sink.outputAudio(pcm);
        else this.sink.diag("realtime.invalid_audio");
        return;
      }
      case "response.output_audio_transcript.delta":
        this.touch();
        if (typeof event.delta === "string" && event.delta.length > 0) {
          this.sink.outputTranscript(event.delta, transcriptMeta({ itemId: event.item_id }));
        }
        return;
      case "response.done":
        this.touch();
        this.handleResponseDone(event);
        this.settleCheck?.();
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = idOf(event.item_id);
        if (itemId) this.pendingTranscripts.delete(itemId);
        if (typeof event.transcript === "string" && event.transcript.length > 0) {
          this.sink.inputTranscript(event.transcript, transcriptMeta({ final: true, itemId: event.item_id }));
        }
        this.transcriptionCostUsdTotal += transcriptionCostUsd(this.settings.transcriptionModel, event.usage);
        this.updateCost();
        this.settleCheck?.();
        return;
      }
      case "conversation.item.input_audio_transcription.failed": {
        const itemId = idOf(event.item_id);
        if (itemId) this.pendingTranscripts.delete(itemId);
        this.sink.diag("input_transcription.failed", { itemId, ...errorFields(event) });
        this.settleCheck?.();
        return;
      }
      case "error": {
        const fields = errorFields(event);
        this.sink.diag("realtime.error", fields);
        if (this.state === "connecting" || this.state === "configuring") this.failStart("REALTIME_START_REJECTED", fields.code);
        return;
      }
      default:
        if (IGNORED_EVENTS.has(event.type)) return;
        if (!this.unhandled.has(event.type)) {
          this.unhandled.add(event.type);
          this.sink.diag("event.unhandled", { type: safeToken(event.type) });
        }
    }
  }

  private handleResponseDone(event: Record<string, unknown>): void {
    const response = isRecord(event.response) ? event.response : {};
    const id = typeof response.id === "string" ? safeToken(response.id) : null;
    if (id) this.inflight.delete(id);
    else this.inflight.clear();
    const details = isRecord(response.status_details) ? response.status_details : {};
    this.sink.diag("response.done", {
      responseId: id,
      status: typeof response.status === "string" ? safeToken(response.status) : null,
      reason: typeof details.reason === "string" ? safeToken(details.reason) : null,
    });
    const tokens = readUsageTokens(response.usage);
    if (!tokens) return;
    this.responseCostUsd += realtimeCostUsd(this.settings.model, tokens);
    this.updateCost();
    this.sink.diag("usage", { responseId: id, ...tokens });
  }

  private updateCost(): void {
    this.costUsd = this.responseCostUsd + this.transcriptionCostUsdTotal;
  }

  private handleClose(code: number): void {
    if (this.state === "connecting" || this.state === "configuring") this.failStart("REALTIME_TRANSPORT", `close_${code}`);
    else if (this.state === "ready" || this.state === "finishing") this.fail("REALTIME_TRANSPORT", `close_${code}`);
  }

  private handleTransportError(detail: string): void {
    if (this.state === "connecting" || this.state === "configuring") this.failStart("REALTIME_TRANSPORT", detail);
    else if (this.state === "ready" || this.state === "finishing") this.fail("REALTIME_TRANSPORT", detail);
    else this.sink.diag("realtime.transport_error", { detail });
  }

  private failStart(code: string, detail?: string): void {
    if (this.state !== "connecting" && this.state !== "configuring") return;
    this.state = "failed";
    this.socket?.close(1000, "eval-start-failed");
    const waiter = this.startWaiter;
    this.startWaiter = undefined;
    waiter?.reject(new EngineError(code, detail));
  }

  private fail(code: string, detail?: string): void {
    if (this.state === "failed" || this.state === "closed") return;
    this.state = "failed";
    this.sink.fatal(code, detail);
    this.socket?.close(1000, "eval-failed");
    this.settleCheck?.();
  }
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? safeToken(value) : null;
}

function responseId(event: Record<string, unknown>): string | null {
  return isRecord(event.response) ? idOf(event.response.id) : null;
}

/** session.updated の解決済み設定（本文なし）。 */
export function describeRealtimeSession(event: Record<string, unknown>): Record<string, unknown> {
  const session = isRecord(event.session) ? event.session : {};
  const audio = isRecord(session.audio) ? session.audio : {};
  const input = isRecord(audio.input) ? audio.input : {};
  const output = isRecord(audio.output) ? audio.output : {};
  const turn = isRecord(input.turn_detection) ? input.turn_detection : {};
  const transcription = isRecord(input.transcription) ? input.transcription : {};
  const reasoning = isRecord(session.reasoning) ? session.reasoning : {};
  const pick = (value: unknown) => (typeof value === "string" ? safeToken(value) : null);
  return {
    model: pick(session.model),
    voice: pick(output.voice),
    turnDetection: pick(turn.type),
    eagerness: pick(turn.eagerness),
    silenceDurationMs: finiteNumber(turn.silence_duration_ms) ?? null,
    createResponse: typeof turn.create_response === "boolean" ? turn.create_response : null,
    interruptResponse: typeof turn.interrupt_response === "boolean" ? turn.interrupt_response : null,
    transcriptionModel: pick(transcription.model),
    reasoningEffort: pick(reasoning.effort),
    outputModalities: Array.isArray(session.output_modalities) ? session.output_modalities.filter(item => typeof item === "string").map(item => safeToken(item)) : null,
  };
}

const createRealtimeEngine: EngineFactory = (config, sink, secrets) =>
  new RealtimeEngine(config, sink, secrets, parseRealtimeOptions(config.options));

export default createRealtimeEngine;
