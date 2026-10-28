import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_BATCH_BYTES,
  AUDIO_FRAME_BYTES,
  MAX_AUDIO_BATCH_BYTES,
  type Language,
} from "../packages/protocol/src/index.ts";
import {
  MAX_PROVIDER_PREOPEN_BYTES,
  type ProviderClock,
  type ProviderSink,
  type ProviderTransport,
  type ProviderTransportFactory,
} from "../packages/provider-openai/src/index.ts";
import {
  buildLiveInstructions,
  DEFAULT_LIVE_SETTINGS,
  LIVE_PRESETS,
  OPENAI_LIVE_MODEL,
  OPENAI_LIVE_URL,
  OpenAILiveTranslationProvider,
  resolveLiveSettings,
  type LiveSettings,
} from "../packages/provider-openai-live/src/index.ts";
import { buildInterpreterInstructions } from "../research/eval/src/prompts/interpreter.ts";

class FakeTransport implements ProviderTransport {
  bufferedAmount: number | undefined = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  open = () => {};
  message = (_data: string | Uint8Array) => {};
  closed = () => {};
  error = () => {};

  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closes.push([code, reason]); }
  onOpen(handler: () => void): void { this.open = handler; }
  onMessage(handler: (data: string | Uint8Array) => void): void { this.message = handler; }
  onClose(handler: () => void): void { this.closed = handler; }
  onError(handler: () => void): void { this.error = handler; }
}

class FakeClock implements ProviderClock {
  timers = new Map<number, () => void>();
  durations = new Map<number, number>();
  next = 1;
  now(): number { return 1_000; }
  setTimeout(handler: () => void, ms: number): number {
    const id = this.next++;
    this.timers.set(id, handler);
    this.durations.set(id, ms);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
    this.durations.delete(handle as number);
  }
  fireAll(): void {
    const handlers = [...this.timers.values()];
    this.timers.clear();
    for (const handler of handlers) handler();
  }
  fireNext(): void {
    const entry = this.timers.entries().next().value as [number, () => void] | undefined;
    if (!entry) return;
    this.timers.delete(entry[0]);
    entry[1]();
  }
}

function createSink(): ProviderSink {
  return {
    onOutputAudio: vi.fn(),
    onOutputTranscript: vi.fn(),
    onInputTranscript: vi.fn(),
    onFatal: vi.fn(),
  };
}

const batch = (fill = 0) => Buffer.alloc(AUDIO_BATCH_BYTES, fill).toString("base64");
const emit = (transport: FakeTransport, event: Record<string, unknown>) => transport.message(JSON.stringify(event));
const sentEvents = (transport: FakeTransport) => transport.sent.map(data => JSON.parse(data) as Record<string, unknown>);
const sentTypes = (transport: FakeTransport) => sentEvents(transport).map(event => event.type);
const outputBytes = (sink: ProviderSink) => Buffer.concat((sink.onOutputAudio as ReturnType<typeof vi.fn>).mock.calls
  .map(call => Buffer.from(call[0] as string, "base64")));

function create(options: {
  transport?: FakeTransport;
  language?: Language;
  settings?: Partial<LiveSettings>;
  started?: boolean;
  session?: Record<string, unknown>;
} = {}) {
  const transport = options.transport ?? new FakeTransport();
  const sink = createSink();
  const clock = new FakeClock();
  const provider = new OpenAILiveTranslationProvider(
    "key", options.language ?? "en", { connect: () => transport }, sink, options.settings, clock,
  );
  if (options.started) {
    transport.open();
    emit(transport, { type: "session.started", session: { id: "synthetic", ...options.session } });
  }
  return { transport, sink, clock, provider };
}

describe("OpenAI GPT-Live provider adapter", () => {
  it("connects to the Live endpoint, sends session.start first, and queues audio until session.started", () => {
    const transport = new FakeTransport();
    const factory: ProviderTransportFactory = {
      connect: (url, headers) => {
        expect(url).toBe(OPENAI_LIVE_URL);
        expect(headers).toEqual({ Authorization: "Bearer key" });
        return transport;
      },
    };
    const sink = createSink();
    const provider = new OpenAILiveTranslationProvider("key", "en", factory, sink, undefined, new FakeClock());
    const first = batch(1);
    const second = batch(2);

    expect(provider.appendPcm(first)).toBe(true);
    expect(transport.sent).toHaveLength(0);
    transport.open();
    expect(sentEvents(transport)).toEqual([{
      type: "session.start",
      session: {
        model: OPENAI_LIVE_MODEL,
        instructions: buildLiveInstructions("plain-q", "ja", "en"),
        audio: { format: { type: "audio/pcm", rate: 24_000 }, output: { voice: "marin" } },
        store: false,
      },
    }]);
    expect(OPENAI_LIVE_MODEL).toBe("gpt-live-1");
    expect(provider.appendPcm(second)).toBe(true);
    expect(transport.sent).toHaveLength(1);

    emit(transport, { type: "session.started", session: {
      id: "synthetic", model: "gpt-live-1", status: "active", expires_at: 7_201,
      audio: { format: { type: "audio/pcm", rate: 24_000 }, output: { voice: "marin" } },
    } });
    expect(sentEvents(transport).slice(1)).toEqual([
      { type: "session.input_audio.append", audio: first },
      { type: "session.input_audio.append", audio: second },
    ]);
    expect(provider.appendPcm(first)).toBe(true);
    expect(sentTypes(transport)).toEqual([
      "session.start", "session.input_audio.append", "session.input_audio.append", "session.input_audio.append",
    ]);
    expect(sink.onFatal).not.toHaveBeenCalled();
  });

  it("builds the instruction direction from the output language and validates operator settings", () => {
    const { transport } = create({ language: "ja", settings: { preset: "domain-glossary", voice: "cedar" } });
    transport.open();
    const session = sentEvents(transport)[0]!.session as Record<string, unknown>;
    expect(session.instructions).toBe(buildLiveInstructions("domain-glossary", "en", "ja"));
    expect(session.instructions).toContain("Translate English user speech into Japanese.");
    expect(session.instructions).toContain("内見 → property viewing");
    expect(session.audio).toEqual({ format: { type: "audio/pcm", rate: 24_000 }, output: { voice: "cedar" } });

    expect(resolveLiveSettings()).toEqual(DEFAULT_LIVE_SETTINGS);
    expect(DEFAULT_LIVE_SETTINGS).toEqual({ preset: "plain-q", voice: "marin" });
    expect(resolveLiveSettings({ preset: undefined, voice: undefined })).toEqual(DEFAULT_LIVE_SETTINGS);
    expect(resolveLiveSettings({ preset: "domain-glossary-q", voice: "sage" }))
      .toEqual({ preset: "domain-glossary-q", voice: "sage" });
    for (const preset of ["domain", "", "PLAIN"]) {
      expect(() => resolveLiveSettings({ preset })).toThrow("OPENAI_LIVE_PRESET_INVALID");
    }
    for (const voice of ["", "a", "Marin", "marin voice", "x".repeat(33)]) {
      expect(() => resolveLiveSettings({ voice })).toThrow("OPENAI_LIVE_VOICE_INVALID");
    }

    const connect = vi.fn(() => new FakeTransport());
    expect(() => new OpenAILiveTranslationProvider("", "en", { connect }, createSink())).toThrow("OPENAI_API_KEY_REQUIRED");
    expect(() => new OpenAILiveTranslationProvider(
      "key", "en", { connect }, createSink(), { preset: "domain" as never },
    )).toThrow("OPENAI_LIVE_PRESET_INVALID");
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps every preset identical to the evaluated interpreter prompt in both directions", () => {
    expect(LIVE_PRESETS).toEqual(["plain", "plain-q", "domain-glossary", "domain-glossary-q"]);
    for (const preset of LIVE_PRESETS) {
      for (const [source, target] of [["ja", "en"], ["en", "ja"]] as const) {
        expect(buildLiveInstructions(preset, source, target)).toBe(buildInterpreterInstructions(preset, source, target));
      }
    }
    expect(buildLiveInstructions("plain-q", "ja", "en")).toContain("Questions stay questions");
    expect(buildLiveInstructions("plain", "ja", "en")).not.toContain("Questions stay questions");
    expect(buildLiveInstructions("plain-q", "ja", "en")).not.toContain("Glossary");
  });

  it("emits every non-silent even PCM delta immediately and splits only oversized deltas", async () => {
    const { transport, sink, provider } = create({ started: true });
    const deltas = [
      Buffer.from([1, 2]),
      Buffer.alloc(1_002, 3),
      Buffer.alloc(AUDIO_BATCH_BYTES * 2 + 14, 4),
      Buffer.from([5, 6]),
    ];
    for (const delta of deltas) {
      const countBefore = (sink.onOutputAudio as ReturnType<typeof vi.fn>).mock.calls.length;
      emit(transport, { type: "session.output_audio.delta", delta: delta.toString("base64") });
      const emitted = (sink.onOutputAudio as ReturnType<typeof vi.fn>).mock.calls
        .slice(countBefore)
        .map(call => Buffer.from(call[0] as string, "base64"));
      expect(Buffer.concat(emitted)).toEqual(delta);
      expect(emitted.every(bytes => bytes.length <= AUDIO_BATCH_BYTES && bytes.length % 2 === 0)).toBe(true);
    }
    expect(outputBytes(sink)).toEqual(Buffer.concat(deltas));
    const callsBeforeClose = (sink.onOutputAudio as ReturnType<typeof vi.fn>).mock.calls.length;
    const closing = provider.close();
    emit(transport, { type: "session.closed", reason: "close_requested" });
    transport.closed();
    await closing;
    expect(sink.onOutputAudio).toHaveBeenCalledTimes(callsBeforeClose);
  });

  it("bounds only digital silence in the continuous stream while keeping low-level sound", () => {
    const { transport, sink } = create({ started: true });
    const delta = (bytes: Buffer) => emit(transport, {
      type: "session.output_audio.delta", delta: bytes.toString("base64"),
    });
    for (let index = 0; index < 20; index += 1) delta(Buffer.alloc(AUDIO_BATCH_BYTES));
    expect(sink.onOutputAudio).not.toHaveBeenCalled();
    const lowLevel = Buffer.alloc(AUDIO_BATCH_BYTES);
    for (let offset = 0; offset < lowLevel.length; offset += 2) lowLevel.writeInt16LE(offset % 4 === 0 ? 1 : -1, offset);
    delta(lowLevel); // Low-level nonzero output (not digital silence) is never trimmed.
    delta(lowLevel);
    for (let index = 0; index < 10; index += 1) delta(Buffer.alloc(AUDIO_BATCH_BYTES));
    delta(Buffer.from([1, 0]));
    delta(Buffer.alloc(1_002));
    delta(Buffer.alloc(9_600));
    expect(outputBytes(sink)).toEqual(Buffer.concat([
      lowLevel, lowLevel, Buffer.alloc(9_600), Buffer.from([1, 0]), Buffer.alloc(9_600),
    ]));
    expect(sink.onFatal).not.toHaveBeenCalled();
  });

  it("retains all samples within a mixed voice/silence chunk without an energy threshold", () => {
    const { transport, sink } = create({ started: true });
    const mixed = Buffer.alloc(AUDIO_BATCH_BYTES);
    mixed.writeInt16LE(1, AUDIO_BATCH_BYTES - 2);
    emit(transport, { type: "session.output_audio.delta", delta: mixed.toString("base64") });
    expect(sink.onOutputAudio).toHaveBeenCalledWith(mixed.toString("base64"));
  });

  it("routes the always-on source transcript and the translated transcript to their own callbacks", () => {
    const { transport, sink } = create({ started: true });
    emit(transport, { type: "session.input_transcript.delta", event_id: "e1", delta: "合成の原文", start_ms: 0, end_ms: 400 });
    emit(transport, { type: "session.output_transcript.delta", event_id: "e2", delta: "synthetic translation", start_ms: 0, end_ms: 400 });
    expect(sink.onInputTranscript).toHaveBeenCalledExactlyOnceWith("合成の原文");
    expect(sink.onOutputTranscript).toHaveBeenCalledExactlyOnceWith("synthetic translation");
    emit(transport, { type: "session.input_transcript.delta", delta: "bad\u0001" });
    expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_INVALID_PAYLOAD");

    for (const delta of ["", "x".repeat(4_097), 1]) {
      const next = create({ started: true });
      emit(next.transport, { type: "session.output_transcript.delta", delta });
      expect(next.sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_INVALID_PAYLOAD");
    }
    for (const type of ["session.input_transcript.delta", "session.output_transcript.delta"]) {
      const early = create();
      early.transport.open();
      emit(early.transport, { type, delta: "too early" });
      expect(early.sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_INVALID_PAYLOAD");
    }
  });

  it("ignores usage snapshots and bounded unknown controls but rejects unknown media and malformed data", () => {
    const { transport, sink } = create({ started: true });
    for (let index = 1; index <= 300; index += 1) {
      emit(transport, { type: "session.usage.updated", usage: { seconds: index * 15 }, context_window: { usage_ratio: 0.01 } });
    }
    for (let index = 0; index < 128; index += 1) emit(transport, { type: "info", code: "synthetic", message: "notice" });
    expect(sink.onFatal).not.toHaveBeenCalled();
    emit(transport, { type: "session.delegation.created", delegation: { id: "synthetic" } });
    expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_INVALID_PAYLOAD");

    const media = create({ started: true });
    emit(media.transport, { type: "session.output_audio.future", delta: "AA==" });
    expect(media.sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_INVALID_PAYLOAD");

    for (const data of [new Uint8Array([1, 2]), "not json", "[]", JSON.stringify({ type: "" }), "x".repeat(65_537)]) {
      const next = create();
      next.transport.open();
      next.transport.message(data);
      expect(next.sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_INVALID_PAYLOAD");
    }
  });

  it("fails closed on preopen and transport backpressure", () => {
    const queued = create();
    for (let index = 0; index < MAX_PROVIDER_PREOPEN_BYTES / AUDIO_BATCH_BYTES; index += 1) {
      expect(queued.provider.appendPcm(batch())).toBe(true);
    }
    expect(queued.provider.appendPcm(batch())).toBe(false);
    expect(queued.sink.onFatal).toHaveBeenCalledWith("BACKPRESSURE");

    const live = create({ started: true });
    live.transport.bufferedAmount = 999_999;
    expect(live.provider.appendPcm(batch())).toBe(false);
    expect(live.sink.onFatal).toHaveBeenCalledWith("BACKPRESSURE");
    expect(sentTypes(live.transport)).toEqual(["session.start"]);
  });

  it("rejects malformed client audio without failing the session", () => {
    const { transport, sink, provider } = create({ started: true });
    expect(provider.appendPcm("not base64!")).toBe(false);
    expect(provider.appendPcm(Buffer.alloc(AUDIO_FRAME_BYTES + 2).toString("base64"))).toBe(false);
    expect(provider.appendPcm(Buffer.alloc(MAX_AUDIO_BATCH_BYTES + AUDIO_FRAME_BYTES).toString("base64"))).toBe(false);
    expect(sentTypes(transport)).toEqual(["session.start"]);
    expect(sink.onFatal).not.toHaveBeenCalled();
    expect(provider.appendPcm(Buffer.alloc(MAX_AUDIO_BATCH_BYTES).toString("base64"))).toBe(true);
  });

  it("times out a connection, including a session.start that never reaches session.started", () => {
    const unopened = create();
    unopened.clock.fireAll();
    expect(unopened.sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");

    const starting = create();
    starting.transport.open();
    expect(sentTypes(starting.transport)).toEqual(["session.start"]);
    expect([...starting.clock.durations.values()]).toEqual([5_000]);
    starting.clock.fireNext();
    expect(starting.sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
    expect(starting.transport.closes).toContainEqual([1008, "PROVIDER_TRANSPORT"]);

    const started = create({ started: true });
    expect(started.clock.timers).toHaveLength(0);
  });

  it("force-closes after a bounded close wait", async () => {
    const { transport, clock, provider } = create();
    transport.open();
    const closing = provider.close(10);
    expect(sentTypes(transport)).toEqual(["session.start", "session.close"]);
    clock.fireAll();
    await closing;
    expect(provider.outputDrained).toBe(false);
    expect(transport.closes.some(([, reason]) => reason === "close-timeout")).toBe(true);
  });

  it("drains tail audio and transcripts and confirms only the requested session.closed", async () => {
    const { transport, sink, clock, provider } = create({ started: true });
    provider.appendPcm(batch());
    const closing = provider.close();
    expect(sentTypes(transport).at(-1)).toBe("session.close");
    expect(provider.appendPcm(batch())).toBe(false);
    expect(provider.outputDrained).toBe(false);
    expect([...clock.durations.values()]).toContain(15_000);
    const tail = Buffer.from([1, 0]).toString("base64");
    emit(transport, { type: "session.output_audio.delta", delta: tail });
    emit(transport, { type: "session.output_transcript.delta", delta: "synthetic tail" });
    emit(transport, { type: "session.input_transcript.delta", delta: "合成の末尾" });
    emit(transport, { type: "session.usage.updated", usage: { seconds: 3 } });
    expect(sink.onOutputAudio).toHaveBeenCalledWith(tail);
    expect(sink.onOutputTranscript).toHaveBeenCalledWith("synthetic tail");
    expect(sink.onInputTranscript).toHaveBeenCalledWith("合成の末尾");
    emit(transport, {
      type: "session.closed", reason: "close_requested", usage: { seconds: 3 },
      session: { id: "synthetic", expires_at: 7_201, model: "gpt-live-1", status: "active" },
    });
    await closing;
    expect(provider.outputDrained).toBe(true);
    expect(sink.onFatal).not.toHaveBeenCalled();
    expect(clock.timers).toHaveLength(0);
    emit(transport, { type: "session.output_audio.delta", delta: tail });
    expect(sink.onOutputAudio).toHaveBeenCalledTimes(1);
  });

  it("does not claim a flush when the drain ends with a provider-initiated reason", async () => {
    for (const reason of ["expired", "content", "remote_hangup", "connection_lost", 7]) {
      const { transport, sink, provider } = create({ started: true });
      const closing = provider.close();
      emit(transport, { type: "session.closed", reason });
      await closing;
      expect(provider.outputDrained).toBe(false);
      expect(sink.onFatal).not.toHaveBeenCalled();
    }
  });

  it("notifies once on unexpected socket/protocol close even with reentrant close callbacks", () => {
    for (const [started, protocolClose] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      const transport = new FakeTransport();
      transport.close = () => transport.closed();
      const { sink, clock, provider } = create({ transport, started });
      if (!started) transport.open();
      if (protocolClose) emit(transport, { type: "session.closed", reason: "expired", usage: { seconds: 1 } });
      else transport.closed();
      transport.closed();
      transport.error();
      expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
      expect(provider.outputDrained).toBe(false);
      expect(provider.appendPcm(batch())).toBe(false);
      expect(clock.timers).toHaveLength(0);
    }
  });

  it("does not mistake a socket close without session.closed for output completion", async () => {
    const { transport, sink, provider } = create({ started: true });
    const closing = provider.close();
    transport.closed();
    await closing;
    expect(provider.outputDrained).toBe(false);
    expect(sink.onFatal).not.toHaveBeenCalled();
  });

  it("accepts a late session.started during drain but never sends discarded queued audio", async () => {
    const { transport, sink, provider } = create();
    provider.appendPcm(batch(1));
    transport.open();
    const closing = provider.close();
    expect(sentTypes(transport)).toEqual(["session.start", "session.close"]);
    emit(transport, { type: "session.started", session: { id: "synthetic" } });
    emit(transport, { type: "session.output_audio.delta", delta: batch(2) });
    emit(transport, { type: "session.input_transcript.delta", delta: "合成" });
    emit(transport, { type: "session.closed", reason: "close_requested" });
    await closing;
    expect(provider.outputDrained).toBe(false);
    expect(sink.onFatal).not.toHaveBeenCalled();
    expect(sentTypes(transport)).toEqual(["session.start", "session.close"]);
  });

  it("cancels before open without a flush claim, even if transport close throws", async () => {
    const transport = new FakeTransport();
    transport.close = () => { throw new Error("synthetic close failure"); };
    const { sink, clock, provider } = create({ transport });
    await provider.close();
    transport.open();
    emit(transport, { type: "session.started", session: {} });
    expect(provider.outputDrained).toBe(false);
    expect(transport.sent).toHaveLength(0);
    expect(clock.timers).toHaveLength(0);
    expect(sink.onFatal).not.toHaveBeenCalled();
  });

  it("rejects audio after expiry even before a delayed timer callback runs", () => {
    const { sink, clock, provider } = create({ started: true, session: { expires_at: 2 } });
    clock.now = () => 2_000;
    expect(provider.appendPcm(batch())).toBe(false);
    expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
    expect(clock.timers).toHaveLength(0);
  });

  it("monitors the advertised two-hour expiry and rejects expired or malformed deadlines", () => {
    const { sink, clock } = create({ started: true, session: { expires_at: 7_201 } });
    expect([...clock.durations.values()]).toEqual([7_200_000]);
    clock.fireNext(); // Simulate two hours without a wall-clock wait.
    expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
    expect(clock.timers).toHaveLength(0);

    for (const expires_at of [null, "7201", 0, 0.5]) {
      const next = create({ started: true, session: { expires_at } });
      expect(next.sink.onFatal).toHaveBeenCalledExactlyOnceWith(
        expires_at === 0.5 ? "PROVIDER_TRANSPORT" : "PROVIDER_INVALID_PAYLOAD",
      );
      expect(sentTypes(next.transport)).toEqual(["session.start"]);
    }
  });

  it("fails closed on malformed, early, duplicate, mismatched, or unsolicited session events", () => {
    // [scenario, appends flushed before the failure]
    const cases: Array<[(transport: FakeTransport) => void, number]> = [
      [transport => { transport.open(); emit(transport, { type: "session.started" }); }, 0],
      [transport => { emit(transport, { type: "session.started", session: {} }); }, 0],
      [transport => {
        transport.open();
        emit(transport, { type: "session.started", session: { audio: { format: { type: "audio/pcm", rate: 16_000 } } } });
      }, 0],
      [transport => {
        transport.open();
        emit(transport, { type: "session.started", session: { audio: { format: { type: "audio/pcmu", rate: 8_000 } } } });
      }, 0],
      [transport => { transport.open(); emit(transport, { type: "session.output_audio.delta", delta: batch(1) }); }, 0],
      [transport => {
        transport.open();
        emit(transport, { type: "session.started", session: {} });
        emit(transport, { type: "session.started", session: {} });
      }, 1],
      [transport => {
        transport.open();
        emit(transport, { type: "session.started", session: {} });
        emit(transport, { type: "session.updated", session: { instructions: "changed" } });
      }, 1],
    ];
    for (const [run, appends] of cases) {
      const { transport, sink, provider } = create();
      provider.appendPcm(batch());
      run(transport);
      expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_INVALID_PAYLOAD");
      expect(sentTypes(transport).filter(type => type === "session.input_audio.append")).toHaveLength(appends);
    }
  });

  it("treats provider error events as fatal before and after session.started", () => {
    for (const started of [false, true]) {
      const { transport, sink, provider } = create({ started });
      if (!started) transport.open();
      emit(transport, { type: "error", error: { type: "invalid_request_error", code: "synthetic", message: "rejected" } });
      emit(transport, { type: "error", error: { type: "invalid_request_error", code: "synthetic", message: "again" } });
      expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
      expect(provider.appendPcm(batch())).toBe(false);
    }
  });

  it("uses correlated native ping/pong without sending settings updates, including silence", () => {
    const transport = new FakeTransport();
    const native: ProviderTransport = transport;
    const pings: string[] = [];
    let pong: (payload: string) => void = () => {};
    native.ping = payload => pings.push(payload);
    native.onPong = handler => { pong = handler; };
    const { sink, clock, provider } = create({ transport, started: true });
    expect([...clock.durations.values()]).toEqual([5_000]);
    clock.fireNext();
    expect(pings).toHaveLength(1);
    const timeout = [...clock.timers.keys()][0];
    pong("stale-pong");
    expect([...clock.timers.keys()][0]).toBe(timeout);
    pong(pings[0]!);
    clock.fireNext();
    expect(pings).toHaveLength(2);
    const nextTimeout = [...clock.timers.keys()][0];
    pong(pings[0]!);
    expect([...clock.timers.keys()][0]).toBe(nextTimeout);
    expect(sentTypes(transport)).toEqual(["session.start"]);
    expect(provider.appendPcm(batch())).toBe(true);
    clock.fireNext();
    expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
    expect(clock.timers).toHaveLength(0);
    pong(pings[1]!);
    expect(clock.timers).toHaveLength(0);
  });

  it("rejects unobservable or invalid transport buffers before session.start or audio", () => {
    for (const size of [undefined, NaN, -1]) {
      const transport = new FakeTransport();
      transport.bufferedAmount = size;
      const { sink, provider } = create({ transport });
      transport.open();
      expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
      expect(transport.sent).toHaveLength(0);
      expect(provider.appendPcm(batch())).toBe(false);
    }
  });

  it("fails closed when session.start cannot be sent", () => {
    const transport = new FakeTransport();
    transport.send = () => { throw new Error("synthetic send failure"); };
    const { sink, clock } = create({ transport });
    transport.open();
    expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
    expect(clock.timers).toHaveLength(0);
  });

  it("rejects odd, non-canonical, oversized, or non-string provider audio", () => {
    for (const delta of [
      Buffer.from([1, 2, 3]).toString("base64"),
      "AQ=",
      "AQI",
      Buffer.alloc(48_002, 1).toString("base64"),
      42,
    ]) {
      const { transport, sink } = create({ started: true });
      emit(transport, { type: "session.output_audio.delta", delta });
      expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_INVALID_PAYLOAD");
      expect(sink.onOutputAudio).not.toHaveBeenCalled();
    }
  });
});
