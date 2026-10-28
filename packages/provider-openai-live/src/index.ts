import {
  AUDIO_BATCH_BYTES,
  AUDIO_SAMPLE_RATE,
  decodeInputPcmBase64,
  MAX_AUDIO_BATCH_BYTES,
  type Language,
} from "../../protocol/src/index.ts";
import {
  decodeProviderOutput,
  MAX_OUTPUT_SILENCE_BYTES,
  MAX_PROVIDER_BUFFERED_BYTES,
  MAX_PROVIDER_JSON_BYTES,
  MAX_PROVIDER_PREOPEN_BYTES,
  PROVIDER_CONNECT_TIMEOUT_MS,
  PROVIDER_DRAIN_TIMEOUT_MS,
  PROVIDER_HEALTH_INTERVAL_MS,
  validBufferSize,
  type ProviderClock,
  type ProviderSink,
  type ProviderTransport,
  type ProviderTransportFactory,
} from "../../provider-openai/src/index.ts";
import { buildLiveInstructions, LIVE_PRESETS, type LivePreset } from "./instructions.ts";

export { buildLiveInstructions, LIVE_PRESETS, type LivePreset } from "./instructions.ts";

/** GPT-Live primary WebSocket. The model and settings travel in session.start, never in the URL. */
export const OPENAI_LIVE_URL = "wss://api.openai.com/v1/live/sessions";
export const OPENAI_LIVE_MODEL = "gpt-live-1";

export interface LiveSettings {
  readonly preset: LivePreset;
  readonly voice: string;
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = Object.freeze({ preset: "plain-q", voice: "marin" });

// Built-in voice names only; custom voice objects are not accepted.
const VOICE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/u;
// v1 rooms pair exactly two languages, so the source is the other language.
const SOURCE_FOR_OUTPUT: Readonly<Record<Language, Language>> = { en: "ja", ja: "en" };

/** Validates operator settings (for example environment variables) before any connection. */
export function resolveLiveSettings(
  input: { readonly preset?: string | undefined; readonly voice?: string | undefined } = {},
): LiveSettings {
  const preset = input.preset ?? DEFAULT_LIVE_SETTINGS.preset;
  const voice = input.voice ?? DEFAULT_LIVE_SETTINGS.voice;
  if (!(LIVE_PRESETS as ReadonlyArray<string>).includes(preset)) throw new Error("OPENAI_LIVE_PRESET_INVALID");
  if (!VOICE_PATTERN.test(voice)) throw new Error("OPENAI_LIVE_VOICE_INVALID");
  return Object.freeze({ preset: preset as LivePreset, voice });
}

type State = "connecting" | "open" | "closing" | "closed";

/**
 * TranslationSession for gpt-live-1 with the same transport, queue, backpressure, silence,
 * health, expiry, and drain rules as OpenAITranslationProvider. GPT-Live always streams the
 * source transcript and continuous output audio (including silence).
 */
export class OpenAILiveTranslationProvider {
  private readonly transport: ProviderTransport;
  private readonly startMessage: string;
  private state: State = "connecting";
  private started = false;
  private awaitingStart = false;
  private readonly preopen: string[] = [];
  private preopenBytes = 0;
  private outputHasContent = false;
  private outputSilenceBytes = 0;
  private ignoredControlEvents = 0;
  private connectTimeout: unknown;
  private healthTimer: unknown;
  private expiryTimer: unknown;
  private expiresAtMs: number | undefined;
  private drained = false;
  private discardedInput = false;
  private pingSequence = 0;
  private awaitingPong: string | undefined;
  private closedResolve!: () => void;
  private readonly closedPromise = new Promise<void>(resolve => {
    this.closedResolve = resolve;
  });

  constructor(
    apiKey: string,
    outputLanguage: Language,
    factory: ProviderTransportFactory,
    private readonly sink: ProviderSink,
    settings: Partial<LiveSettings> = DEFAULT_LIVE_SETTINGS,
    private readonly clock: ProviderClock = defaultClock,
  ) {
    if (!apiKey) throw new Error("OPENAI_API_KEY_REQUIRED");
    const resolved = resolveLiveSettings(settings);
    this.startMessage = JSON.stringify({
      type: "session.start",
      session: {
        model: OPENAI_LIVE_MODEL,
        instructions: buildLiveInstructions(resolved.preset, SOURCE_FOR_OUTPUT[outputLanguage], outputLanguage),
        audio: {
          format: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE },
          output: { voice: resolved.voice },
        },
        // The documented default, stated explicitly: no stored session or recording download.
        store: false,
      },
    });
    this.transport = factory.connect(OPENAI_LIVE_URL, { Authorization: `Bearer ${apiKey}` });
    // Covers the socket handshake and session.start -> session.started.
    this.connectTimeout = this.clock.setTimeout(
      () => this.fail("PROVIDER_TRANSPORT"),
      PROVIDER_CONNECT_TIMEOUT_MS,
    );
    this.transport.onPong?.(payload => this.handlePong(payload));
    this.transport.onOpen(() => this.open());
    this.transport.onMessage(data => this.handleMessage(data));
    this.transport.onError(() => this.fail("PROVIDER_TRANSPORT"));
    this.transport.onClose(() => {
      if (this.state === "open" || this.state === "connecting") this.fail("PROVIDER_TRANSPORT");
      else this.finishClosed();
    });
  }

  /** Server input/output flush acknowledged; this does not measure device playback. */
  get outputDrained(): boolean { return this.drained; }

  appendPcm(base64Pcm: string): boolean {
    if (this.state === "open" && this.expiresAtMs !== undefined
      && this.expiresAtMs <= (this.clock.now?.() ?? Date.now())) {
      this.fail("PROVIDER_TRANSPORT");
      return false;
    }
    let byteLength: number;
    try {
      byteLength = decodeInputPcmBase64(base64Pcm).byteLength;
    } catch {
      return false;
    }
    if (byteLength > MAX_AUDIO_BATCH_BYTES || this.state === "closing" || this.state === "closed") {
      return false;
    }
    if (this.state === "connecting" || !this.started) {
      if (this.preopenBytes + byteLength > MAX_PROVIDER_PREOPEN_BYTES) {
        this.fail("BACKPRESSURE");
        return false;
      }
      this.preopen.push(base64Pcm);
      this.preopenBytes += byteLength;
      return true;
    }
    return this.sendAudio(base64Pcm);
  }

  async close(timeoutMs = PROVIDER_DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.state === "closed") return;
    if (this.connectTimeout !== undefined) {
      this.clock.clearTimeout(this.connectTimeout);
      this.connectTimeout = undefined;
    }
    this.clearHealthTimer();
    this.clearExpiryTimer();
    this.awaitingPong = undefined;
    this.awaitingStart = false;
    this.discardedInput ||= this.preopenBytes > 0;
    this.preopen.length = 0;
    this.preopenBytes = 0;
    if (this.state === "connecting") {
      this.state = "closing";
      this.finishClosed();
      this.closeTransport(1000, "closed-before-open");
    } else if (this.state === "open") {
      this.state = "closing";
      try {
        this.transport.send(JSON.stringify({ type: "session.close" }));
      } catch {
        this.finishClosed();
        this.closeTransport(1000, "closed");
      }
    }

    let timeoutHandle: unknown;
    await Promise.race([
      this.closedPromise,
      new Promise<void>(resolve => {
        timeoutHandle = this.clock.setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timeoutHandle !== undefined) this.clock.clearTimeout(timeoutHandle);
    if ((this.state as State) !== "closed") {
      this.finishClosed();
      this.closeTransport(1000, "close-timeout");
    }
  }

  private open(): void {
    if (this.state !== "connecting") return;
    this.state = "open";
    // GPT-Live expects the client to speak first: session.start must be the first message.
    if (!validBufferSize(this.transport.bufferedAmount)) {
      this.fail("PROVIDER_TRANSPORT");
      return;
    }
    try {
      this.transport.send(this.startMessage);
      this.awaitingStart = true;
    } catch {
      this.fail("PROVIDER_TRANSPORT");
    }
  }

  private sendAudio(base64Pcm: string): boolean {
    if (this.state !== "open") return false;
    try {
      const message = JSON.stringify({
        type: "session.input_audio.append",
        audio: base64Pcm,
      });
      const bufferedAmount = this.transport.bufferedAmount;
      if (!validBufferSize(bufferedAmount)) {
        this.fail("PROVIDER_TRANSPORT");
        return false;
      }
      if (bufferedAmount + Buffer.byteLength(message) > MAX_PROVIDER_BUFFERED_BYTES) {
        this.fail("BACKPRESSURE");
        return false;
      }
      this.transport.send(message);
      return true;
    } catch {
      this.fail("PROVIDER_TRANSPORT");
      return false;
    }
  }

  private handleMessage(data: string | Uint8Array): void {
    if (this.state === "closed") return;
    if (typeof data !== "string" || Buffer.byteLength(data) > MAX_PROVIDER_JSON_BYTES) {
      this.fail("PROVIDER_INVALID_PAYLOAD");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.fail("PROVIDER_INVALID_PAYLOAD");
      return;
    }
    if (!isRecord(parsed)) {
      this.fail("PROVIDER_INVALID_PAYLOAD");
      return;
    }
    const event = parsed;
    if (typeof event.type !== "string" || event.type.length < 1 || event.type.length > 128) {
      this.fail("PROVIDER_INVALID_PAYLOAD");
      return;
    }

    switch (event.type) {
      case "session.output_audio.delta":
        if (!this.started) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        this.handleOutputAudio(event.delta);
        return;
      case "session.output_transcript.delta":
        if (!this.started) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        this.handleTranscript(event.delta, this.sink.onOutputTranscript);
        return;
      case "session.input_transcript.delta":
        if (!this.started) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        this.handleTranscript(event.delta, this.sink.onInputTranscript);
        return;
      case "session.usage.updated":
        // Cumulative snapshots about every 15 s. Host-side leases are the cost authority.
        return;
      case "session.started":
        if (!isRecord(event.session)) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        if (this.state === "closing") {
          // A start ACK already in flight may arrive during drain. GPT-Live streams audio
          // continuously, so accept media until session.closed; queued input stays discarded.
          this.started = true;
          return;
        }
        if (!this.awaitingStart || !validResolvedAudioFormat(event.session)) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        if (!this.observeExpiry(event.session)) return;
        this.handleStarted();
        return;
      case "session.updated":
        // This adapter never sends session.update, so a settings change is unexpected.
        if (this.state !== "closing") this.fail("PROVIDER_INVALID_PAYLOAD");
        return;
      case "session.closed":
        if (this.state !== "closing") {
          this.fail("PROVIDER_TRANSPORT");
          return;
        }
        // Only the requested close flushes the stream; expiry or safety closes do not.
        this.drained = !this.discardedInput
          && (event.reason === undefined || event.reason === "close_requested");
        this.finishClosed();
        this.closeTransport(1000, "session-closed");
        return;
      case "error":
        this.fail("PROVIDER_TRANSPORT");
        return;
      default:
        if (/audio|transcript/u.test(event.type)) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        this.ignoredControlEvents += 1;
        if (this.ignoredControlEvents > 128) this.fail("PROVIDER_INVALID_PAYLOAD");
    }
  }

  private handleOutputAudio(value: unknown): void {
    let chunk: Buffer;
    try {
      chunk = decodeProviderOutput(value);
    } catch {
      this.fail("PROVIDER_INVALID_PAYLOAD");
      return;
    }
    for (let offset = 0; offset < chunk.byteLength; offset += AUDIO_BATCH_BYTES) {
      const part = chunk.subarray(offset, offset + AUDIO_BATCH_BYTES);
      if (part.every(byte => byte === 0)) {
        // Only digital silence is shortened. Quiet/nonzero sound is never gated.
        if (!this.outputHasContent) continue;
        const keep = Math.min(part.byteLength, MAX_OUTPUT_SILENCE_BYTES - this.outputSilenceBytes);
        this.outputSilenceBytes += keep;
        if (keep > 0) this.sink.onOutputAudio(part.subarray(0, keep).toString("base64"));
      } else {
        this.outputHasContent = true;
        this.outputSilenceBytes = 0;
        this.sink.onOutputAudio(part.toString("base64"));
      }
    }
  }

  private handleTranscript(value: unknown, handler: (delta: string) => void): void {
    if (
      typeof value !== "string" || value.length < 1 || value.length > 4_096
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
    ) {
      this.fail("PROVIDER_INVALID_PAYLOAD");
      return;
    }
    handler(value);
  }

  private handleStarted(): void {
    this.awaitingStart = false;
    this.started = true;
    if (this.connectTimeout !== undefined) {
      this.clock.clearTimeout(this.connectTimeout);
      this.connectTimeout = undefined;
    }
    for (const audio of this.preopen) {
      if (!this.sendAudio(audio)) return;
    }
    this.preopen.length = 0;
    this.preopenBytes = 0;
    this.scheduleHealthCheck();
  }

  private handlePong(payload: string): void {
    if (this.state !== "open" || this.awaitingPong === undefined || payload !== this.awaitingPong) return;
    this.awaitingPong = undefined;
    this.clearHealthTimer();
    this.scheduleHealthCheck();
  }

  private scheduleHealthCheck(): void {
    if (this.state !== "open" || !this.started || !this.transport.ping || !this.transport.onPong) return;
    this.healthTimer = this.clock.setTimeout(() => {
      this.healthTimer = undefined;
      if (this.state !== "open") return;
      this.awaitingPong = `live-health-${++this.pingSequence}`;
      this.healthTimer = this.clock.setTimeout(() => {
        this.healthTimer = undefined;
        if (this.awaitingPong !== undefined) this.fail("PROVIDER_TRANSPORT");
      }, PROVIDER_HEALTH_INTERVAL_MS);
      try { this.transport.ping!(this.awaitingPong); }
      catch { this.fail("PROVIDER_TRANSPORT"); }
    }, PROVIDER_HEALTH_INTERVAL_MS);
  }

  private clearHealthTimer(): void {
    if (this.healthTimer === undefined) return;
    this.clock.clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
  }

  private observeExpiry(session: Record<string, unknown>): boolean {
    if (session.expires_at === undefined) return true;
    const expiry = typeof session.expires_at === "number" ? session.expires_at * 1_000 : NaN;
    if (!Number.isSafeInteger(expiry) || expiry <= 0) {
      this.fail("PROVIDER_INVALID_PAYLOAD");
      return false;
    }
    const remaining = expiry - (this.clock.now?.() ?? Date.now());
    if (remaining <= 0) {
      this.fail("PROVIDER_TRANSPORT");
      return false;
    }
    if (this.expiresAtMs !== undefined && this.expiresAtMs <= expiry) return true;
    this.expiresAtMs = expiry;
    this.clearExpiryTimer();
    this.expiryTimer = this.clock.setTimeout(() => {
      this.expiryTimer = undefined;
      this.fail("PROVIDER_TRANSPORT");
    }, Math.min(remaining, 2_147_483_647));
    return true;
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === undefined) return;
    this.clock.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private fail(code: Parameters<ProviderSink["onFatal"]>[0]): void {
    if (this.state === "closed") return;
    // Fence reentrant close/error callbacks before notifying either side.
    this.finishClosed();
    this.closeTransport(1008, code);
    this.sink.onFatal(code);
  }

  private closeTransport(code: number, reason: string): void {
    try { this.transport.close(code, reason); } catch { /* Already fenced and terminal. */ }
  }

  private finishClosed(): void {
    if (this.state === "closed") return;
    if (this.connectTimeout !== undefined) {
      this.clock.clearTimeout(this.connectTimeout);
      this.connectTimeout = undefined;
    }
    this.clearHealthTimer();
    this.clearExpiryTimer();
    this.awaitingPong = undefined;
    this.awaitingStart = false;
    this.preopen.length = 0;
    this.preopenBytes = 0;
    this.outputHasContent = false;
    this.outputSilenceBytes = 0;
    this.state = "closed";
    this.closedResolve();
  }
}

const defaultClock: ProviderClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The audio format is fixed at startup for both directions; reject a resolved mismatch. */
function validResolvedAudioFormat(session: Record<string, unknown>): boolean {
  if (session.audio === undefined || session.audio === null) return true;
  if (!isRecord(session.audio)) return false;
  const format = session.audio.format;
  if (format === undefined || format === null) return true;
  return isRecord(format) && format.type === "audio/pcm" && format.rate === AUDIO_SAMPLE_RATE;
}
