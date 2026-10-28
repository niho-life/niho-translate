import {
  AUDIO_BATCH_BYTES,
  decodeInputPcmBase64,
  MAX_AUDIO_BATCH_BYTES,
  type Language,
} from "../../protocol/src/index.ts";

export const OPENAI_TRANSLATION_URL = "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";
export const MAX_PROVIDER_JSON_BYTES = 65_536;
export const MAX_PROVIDER_BUFFERED_BYTES = 192_000;
export const MAX_PROVIDER_PREOPEN_BYTES = 240_000;
export const PROVIDER_CONNECT_TIMEOUT_MS = 5_000;
export const PROVIDER_HEALTH_INTERVAL_MS = 5_000;
export const MAX_OUTPUT_SILENCE_BYTES = 9_600; // 200 ms at 24 kHz mono PCM16.
export const PROVIDER_DRAIN_TIMEOUT_MS = 15_000;

export interface ProviderTransport {
  readonly bufferedAmount: number | undefined;
  ping?(payload: string): void;
  onPong?(handler: (payload: string) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string | Uint8Array) => void): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
}

export interface ProviderTransportFactory {
  connect(url: string, headers: Readonly<Record<string, string>>): ProviderTransport;
}

export interface ProviderClock {
  now?(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProviderSink {
  onOutputAudio(base64Pcm: string): void;
  onOutputTranscript(delta: string): void;
  onInputTranscript(delta: string): void;
  onFatal(code: "PROVIDER_INVALID_PAYLOAD" | "PROVIDER_TRANSPORT" | "BACKPRESSURE"): void;
}

type State = "connecting" | "open" | "closing" | "closed";

export class OpenAITranslationProvider {
  private readonly transport: ProviderTransport;
  private readonly outputLanguage: Language;
  private state: State = "connecting";
  private configured = false;
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
  private awaitingUpdate: "initial" | undefined;
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
    private readonly clock: ProviderClock = defaultClock,
  ) {
    if (!apiKey) throw new Error("OPENAI_API_KEY_REQUIRED");
    this.outputLanguage = outputLanguage;
    this.transport = factory.connect(OPENAI_TRANSLATION_URL, { Authorization: `Bearer ${apiKey}` });
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
    if (this.state === "connecting" || !this.configured) {
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
    this.awaitingUpdate = undefined;
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
  }

  private configure(): void {
    if (this.state !== "open" || this.configured || this.awaitingUpdate !== undefined) return;
    if (!validBufferSize(this.transport.bufferedAmount)) {
      this.fail("PROVIDER_TRANSPORT");
      return;
    }
    try {
      this.transport.send(JSON.stringify({
        type: "session.update",
        session: { audio: {
          input: { transcription: null, noise_reduction: { type: "near_field" } },
          output: { language: this.outputLanguage },
        } },
      }));
      this.awaitingUpdate = "initial";
    } catch {
      this.fail("PROVIDER_TRANSPORT");
    }
  }

  private sendAudio(base64Pcm: string): boolean {
    if (this.state !== "open") return false;
    try {
      const message = JSON.stringify({
        type: "session.input_audio_buffer.append",
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.fail("PROVIDER_INVALID_PAYLOAD");
      return;
    }
    const event = parsed as Record<string, unknown>;
    if (typeof event.type !== "string" || event.type.length < 1 || event.type.length > 128) {
      this.fail("PROVIDER_INVALID_PAYLOAD");
      return;
    }

    switch (event.type) {
      case "session.output_audio.delta":
        if (!this.configured || !validOptionalAudioMetadata(event)) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        this.handleOutputAudio(event.delta);
        return;
      case "session.output_transcript.delta":
        if (!this.configured) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        this.handleTranscript(event.delta, this.sink.onOutputTranscript);
        return;
      case "session.input_transcript.delta":
        if (!this.configured) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        this.handleTranscript(event.delta, this.sink.onInputTranscript);
        return;
      case "session.output_audio.done":
        if (!this.configured || !validOptionalAudioMetadata(event)) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
        }
        return;
      case "session.output_transcript.done":
      case "session.input_transcript.done":
        if (!this.configured) this.fail("PROVIDER_INVALID_PAYLOAD");
        return;
      case "rate_limits.updated":
        return;
      case "session.created":
        if (!isRecord(event.session)) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        if (!this.observeExpiry(event.session)) return;
        this.configure();
        return;
      case "session.updated":
        if (!isRecord(event.session)) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        // An initial configuration ACK already in flight may arrive during drain.
        if (this.state === "closing") return;
        if (this.awaitingUpdate === undefined) {
          this.fail("PROVIDER_INVALID_PAYLOAD");
          return;
        }
        if (!this.observeExpiry(event.session)) return;
        this.handleSessionUpdated();
        return;
      case "session.closed":
        if (this.state !== "closing") {
          this.fail("PROVIDER_TRANSPORT");
          return;
        }
        this.drained = !this.discardedInput;
        this.finishClosed();
        this.closeTransport(1000, "session-closed");
        return;
      case "error":
        this.fail("PROVIDER_TRANSPORT");
        return;
      default:
        if (/audio|transcript|input_audio_buffer/u.test(event.type)) {
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
        // Only digital silence is shortened. Quiet/nonzero speech is never gated.
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

  private handleSessionUpdated(): void {
    const acknowledged = this.awaitingUpdate;
    this.awaitingUpdate = undefined;
    this.clearHealthTimer();
    if (acknowledged === "initial") {
      this.configured = true;
      if (this.connectTimeout !== undefined) {
        this.clock.clearTimeout(this.connectTimeout);
        this.connectTimeout = undefined;
      }
      for (const audio of this.preopen) {
        if (!this.sendAudio(audio)) return;
      }
      this.preopen.length = 0;
      this.preopenBytes = 0;
    }
    this.scheduleHealthCheck();
  }

  private handlePong(payload: string): void {
    if (this.state !== "open" || this.awaitingPong === undefined || payload !== this.awaitingPong) return;
    this.awaitingPong = undefined;
    this.clearHealthTimer();
    this.scheduleHealthCheck();
  }

  private scheduleHealthCheck(): void {
    if (this.state !== "open" || !this.configured || !this.transport.ping || !this.transport.onPong) return;
    this.healthTimer = this.clock.setTimeout(() => {
      this.healthTimer = undefined;
      if (this.state !== "open") return;
      this.awaitingPong = `translate-health-${++this.pingSequence}`;
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
    // An update cannot silently extend the originally announced session lifetime.
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
    this.awaitingUpdate = undefined;
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

export function decodeProviderOutput(value: unknown): Buffer {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > Math.ceil(48_000 / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error("INVALID_PROVIDER_AUDIO");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0
    || bytes.length > 48_000
    || bytes.length % 2 !== 0
    || bytes.toString("base64") !== value
  ) {
    throw new Error("INVALID_PROVIDER_AUDIO");
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validOptionalAudioMetadata(event: Record<string, unknown>): boolean {
  return (event.sample_rate === undefined || event.sample_rate === 24_000)
    && (event.channels === undefined || event.channels === 1)
    && (event.format === undefined || event.format === "pcm16");
}

export function validBufferSize(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}
