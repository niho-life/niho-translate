import { describe, expect, it, vi } from "vitest";
import { AUDIO_BATCH_BYTES } from "../packages/protocol/src/index.ts";
import {
  MAX_PROVIDER_PREOPEN_BYTES,
  OPENAI_TRANSLATION_URL,
  OpenAITranslationProvider,
  type ProviderClock,
  type ProviderSink,
  type ProviderTransport,
  type ProviderTransportFactory,
} from "../packages/provider-openai/src/index.ts";

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

describe("OpenAI provider adapter", () => {
  it("queues the first audio until open and runs the documented fake event flow", () => {
    const transport = new FakeTransport();
    const factory: ProviderTransportFactory = {
      connect: (url, headers) => {
        expect(url).toBe(OPENAI_TRANSLATION_URL);
        expect(headers).toEqual({ Authorization: "Bearer key" });
        return transport;
      },
    };
    const sink = createSink();
    const provider = new OpenAITranslationProvider("key", "en", factory, sink, new FakeClock());
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");

    expect(provider.appendPcm(audio)).toBe(true);
    expect(transport.sent).toHaveLength(0);
    transport.open();
    expect(transport.sent).toHaveLength(0);
    transport.message(JSON.stringify({ type: "session.created", session: { id: "synthetic" } }));
    expect(JSON.parse(transport.sent[0]!)).toEqual({
      type: "session.update",
      session: { audio: {
        input: { transcription: null, noise_reduction: { type: "near_field" } },
        output: { language: "en" },
      } },
    });
    expect(transport.sent).toHaveLength(1);
    transport.message(JSON.stringify({ type: "session.updated", session: { id: "synthetic" } }));
    expect(JSON.parse(transport.sent[1]!)).toEqual({
      type: "session.input_audio_buffer.append",
      audio,
    });

    transport.message(JSON.stringify({ type: "rate_limits.updated", rate_limits: [] }));
    const translatedAudio = Buffer.alloc(AUDIO_BATCH_BYTES, 7).toString("base64");
    transport.message(JSON.stringify({
      type: "session.output_audio.delta",
      delta: translatedAudio,
      sample_rate: 24_000,
      channels: 1,
      format: "pcm16",
    }));
    expect(sink.onOutputAudio).toHaveBeenCalledWith(translatedAudio);
    expect(sink.onFatal).not.toHaveBeenCalled();
  });

  it("emits every non-silent even PCM delta immediately and splits only oversized deltas", async () => {
    const transport = new FakeTransport();
    const sink = createSink();
    const provider = new OpenAITranslationProvider("key", "ja", { connect: () => transport }, sink, new FakeClock());
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    transport.message(JSON.stringify({ type: "session.updated", session: {} }));
    const deltas = [
      Buffer.from([1, 2]),
      Buffer.alloc(1_002, 3),
      Buffer.alloc(AUDIO_BATCH_BYTES * 2 + 14, 4),
      Buffer.from([5, 6]),
    ];
    for (const delta of deltas) {
      const countBefore = (sink.onOutputAudio as ReturnType<typeof vi.fn>).mock.calls.length;
      transport.message(JSON.stringify({
        type: "session.output_audio.delta",
        delta: delta.toString("base64"),
      }));
      const emitted = (sink.onOutputAudio as ReturnType<typeof vi.fn>).mock.calls
        .slice(countBefore)
        .map(call => Buffer.from(call[0], "base64"));
      expect(Buffer.concat(emitted)).toEqual(delta);
      expect(emitted.every(bytes => bytes.length <= AUDIO_BATCH_BYTES && bytes.length % 2 === 0)).toBe(true);
    }
    const callsBeforeClose = (sink.onOutputAudio as ReturnType<typeof vi.fn>).mock.calls.length;
    const allOutput = (sink.onOutputAudio as ReturnType<typeof vi.fn>).mock.calls
      .map(call => Buffer.from(call[0], "base64"));
    expect(Buffer.concat(allOutput)).toEqual(Buffer.concat(deltas));
    const closing = provider.close();
    transport.message(JSON.stringify({ type: "session.closed" }));
    transport.closed();
    await closing;
    expect(sink.onOutputAudio).toHaveBeenCalledTimes(callsBeforeClose);
  });

  it("bounds only digital silence while preserving quiet speech, gaps, and new speech", () => {
    const transport = new FakeTransport();
    const sink = createSink();
    new OpenAITranslationProvider("key", "en", { connect: () => transport }, sink, new FakeClock());
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    transport.message(JSON.stringify({ type: "session.updated", session: {} }));
    const emit = (bytes: Buffer) => transport.message(JSON.stringify({
      type: "session.output_audio.delta", delta: bytes.toString("base64"),
    }));
    emit(Buffer.alloc(48_000));
    expect(sink.onOutputAudio).not.toHaveBeenCalled();
    emit(Buffer.from([1, 0])); // The quietest nonzero PCM16 sample must survive.
    emit(Buffer.alloc(1_002));
    emit(Buffer.alloc(9_600));
    emit(Buffer.alloc(2));
    emit(Buffer.from([255, 255]));
    emit(Buffer.alloc(2));
    const output = Buffer.concat((sink.onOutputAudio as ReturnType<typeof vi.fn>).mock.calls
      .map(call => Buffer.from(call[0], "base64")));
    expect(output).toEqual(Buffer.concat([
      Buffer.from([1, 0]), Buffer.alloc(9_600), Buffer.from([255, 255]), Buffer.alloc(2),
    ]));
    expect(sink.onFatal).not.toHaveBeenCalled();
  });

  it("retains all samples within a mixed voice/silence chunk without an energy threshold", () => {
    const transport = new FakeTransport();
    const sink = createSink();
    new OpenAITranslationProvider("key", "en", { connect: () => transport }, sink, new FakeClock());
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    transport.message(JSON.stringify({ type: "session.updated", session: {} }));
    const mixed = Buffer.alloc(AUDIO_BATCH_BYTES);
    mixed.writeInt16LE(1, AUDIO_BATCH_BYTES - 2);
    transport.message(JSON.stringify({ type: "session.output_audio.delta", delta: mixed.toString("base64") }));
    expect(sink.onOutputAudio).toHaveBeenCalledWith(mixed.toString("base64"));
  });

  it("ignores bounded unknown non-media controls but rejects unknown media and binary data", () => {
    const transport = new FakeTransport();
    const sink = createSink();
    new OpenAITranslationProvider("key", "ja", { connect: () => transport }, sink, new FakeClock());
    transport.open();
    transport.message(JSON.stringify({ type: "provider.notice", value: 1 }));
    expect(sink.onFatal).not.toHaveBeenCalled();
    transport.message(JSON.stringify({ type: "session.output_audio.future", delta: "AA==" }));
    expect(sink.onFatal).toHaveBeenCalledWith("PROVIDER_INVALID_PAYLOAD");

    const transport2 = new FakeTransport();
    const sink2 = createSink();
    new OpenAITranslationProvider("key", "ja", { connect: () => transport2 }, sink2, new FakeClock());
    transport2.message(new Uint8Array([1, 2]));
    expect(sink2.onFatal).toHaveBeenCalledWith("PROVIDER_INVALID_PAYLOAD");
  });

  it("fails closed on preopen and transport backpressure", () => {
    const transport = new FakeTransport();
    const sink = createSink();
    const provider = new OpenAITranslationProvider("key", "ja", { connect: () => transport }, sink, new FakeClock());
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
    for (let index = 0; index < MAX_PROVIDER_PREOPEN_BYTES / AUDIO_BATCH_BYTES; index += 1) {
      expect(provider.appendPcm(audio)).toBe(true);
    }
    expect(provider.appendPcm(audio)).toBe(false);
    expect(sink.onFatal).toHaveBeenCalledWith("BACKPRESSURE");

    const transport2 = new FakeTransport();
    const sink2 = createSink();
    const provider2 = new OpenAITranslationProvider("key", "ja", { connect: () => transport2 }, sink2, new FakeClock());
    transport2.open();
    transport2.message(JSON.stringify({ type: "session.created", session: {} }));
    transport2.message(JSON.stringify({ type: "session.updated", session: {} }));
    transport2.bufferedAmount = 999_999;
    expect(provider2.appendPcm(audio)).toBe(false);
    expect(sink2.onFatal).toHaveBeenCalledWith("BACKPRESSURE");
  });

  it("times out a connection and force-closes after a bounded close wait", async () => {
    const transport = new FakeTransport();
    const sink = createSink();
    const clock = new FakeClock();
    new OpenAITranslationProvider("key", "ja", { connect: () => transport }, sink, clock);
    clock.fireAll();
    expect(sink.onFatal).toHaveBeenCalledWith("PROVIDER_TRANSPORT");

    const transport2 = new FakeTransport();
    const clock2 = new FakeClock();
    const provider = new OpenAITranslationProvider("key", "ja", { connect: () => transport2 }, createSink(), clock2);
    transport2.open();
    const closing = provider.close(10);
    clock2.fireAll();
    await closing;
    expect(provider.outputDrained).toBe(false);
    expect(transport2.closes.some(([, reason]) => reason === "close-timeout")).toBe(true);
  });

  it("drains tail audio with a late control ACK and confirms only session.closed", async () => {
    const transport = new FakeTransport();
    const sink = createSink();
    const clock = new FakeClock();
    const provider = new OpenAITranslationProvider("key", "en", { connect: () => transport }, sink, clock);
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    transport.message(JSON.stringify({ type: "session.updated", session: {} }));
    provider.appendPcm(Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64"));
    const closing = provider.close();
    expect(provider.appendPcm(Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64"))).toBe(false);
    expect(provider.outputDrained).toBe(false);
    expect([...clock.durations.values()]).toContain(15_000);
    transport.message(JSON.stringify({ type: "session.updated", session: {} }));
    const tail = Buffer.from([1, 0]).toString("base64");
    transport.message(JSON.stringify({ type: "session.output_audio.delta", delta: tail }));
    transport.message(JSON.stringify({ type: "session.output_transcript.delta", delta: "synthetic tail" }));
    expect(sink.onOutputAudio).toHaveBeenCalledWith(tail);
    expect(sink.onOutputTranscript).toHaveBeenCalledWith("synthetic tail");
    transport.message(JSON.stringify({ type: "session.closed" }));
    await closing;
    expect(provider.outputDrained).toBe(true);
    expect(sink.onFatal).not.toHaveBeenCalled();
    expect(clock.timers).toHaveLength(0);
    transport.message(JSON.stringify({ type: "session.output_audio.delta", delta: tail }));
    expect(sink.onOutputAudio).toHaveBeenCalledTimes(1);
  });

  it("notifies once on unexpected socket/protocol close even with reentrant close callbacks", () => {
    for (const protocolClose of [false, true]) {
      const transport = new FakeTransport();
      transport.close = () => transport.closed();
      const sink = createSink();
      const clock = new FakeClock();
      const provider = new OpenAITranslationProvider("key", "en", { connect: () => transport }, sink, clock);
      transport.open();
      if (protocolClose) transport.message(JSON.stringify({ type: "session.closed" }));
      else transport.closed();
      transport.closed();
      transport.error();
      expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
      expect(provider.outputDrained).toBe(false);
      expect(provider.appendPcm(Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64"))).toBe(false);
      expect(clock.timers).toHaveLength(0);
    }
  });

  it("does not mistake a socket close without the flush ACK for output completion", async () => {
    const transport = new FakeTransport();
    const sink = createSink();
    const provider = new OpenAITranslationProvider("key", "en", { connect: () => transport }, sink, new FakeClock());
    transport.open();
    const closing = provider.close();
    transport.closed();
    await closing;
    expect(provider.outputDrained).toBe(false);
    expect(sink.onFatal).not.toHaveBeenCalled();
  });

  it("does not confirm drain if closing discarded audio awaiting initial configuration", async () => {
    const transport = new FakeTransport();
    const provider = new OpenAITranslationProvider("key", "en", { connect: () => transport }, createSink(), new FakeClock());
    provider.appendPcm(Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64"));
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    const closing = provider.close();
    transport.message(JSON.stringify({ type: "session.updated", session: {} }));
    transport.message(JSON.stringify({ type: "session.closed" }));
    await closing;
    expect(provider.outputDrained).toBe(false);
    expect(transport.sent.filter(data => JSON.parse(data).type === "session.input_audio_buffer.append")).toHaveLength(0);
  });

  it("cancels before open without a flush claim, even if transport close throws", async () => {
    const transport = new FakeTransport();
    transport.close = () => { throw new Error("synthetic close failure"); };
    const clock = new FakeClock();
    const sink = createSink();
    const provider = new OpenAITranslationProvider("key", "en", { connect: () => transport }, sink, clock);
    await provider.close();
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    expect(provider.outputDrained).toBe(false);
    expect(transport.sent).toHaveLength(0);
    expect(clock.timers).toHaveLength(0);
    expect(sink.onFatal).not.toHaveBeenCalled();
  });

  it("rejects audio after expiry even before a delayed timer callback runs", () => {
    const transport = new FakeTransport();
    const sink = createSink();
    const clock = new FakeClock();
    const provider = new OpenAITranslationProvider("key", "en", { connect: () => transport }, sink, clock);
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: { expires_at: 2 } }));
    transport.message(JSON.stringify({ type: "session.updated", session: {} }));
    clock.now = () => 2_000;
    expect(provider.appendPcm(Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64"))).toBe(false);
    expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
    expect(clock.timers).toHaveLength(0);
  });

  it("tracks the earliest advertised expiry and rejects expired or malformed deadlines", () => {
    const transport = new FakeTransport();
    const sink = createSink();
    const clock = new FakeClock();
    new OpenAITranslationProvider("key", "en", { connect: () => transport }, sink, clock);
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: { expires_at: 3_601 } }));
    transport.message(JSON.stringify({ type: "session.updated", session: { expires_at: 7_201 } }));
    expect([...clock.durations.values()]).toContain(3_600_000);
    expect(clock.timers).toHaveLength(1);
    clock.fireNext(); // Simulate one hour without a wall-clock wait.
    expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
    expect(clock.timers).toHaveLength(0);

    for (const expires_at of [null, "3601", 0, 0.5]) {
      const next = new FakeTransport();
      const nextSink = createSink();
      new OpenAITranslationProvider("key", "en", { connect: () => next }, nextSink, new FakeClock());
      next.open();
      next.message(JSON.stringify({ type: "session.created", session: { expires_at } }));
      expect(nextSink.onFatal).toHaveBeenCalledExactlyOnceWith(
        expires_at === 0.5 ? "PROVIDER_TRANSPORT" : "PROVIDER_INVALID_PAYLOAD",
      );
    }
  });

  it("keeps the configuration timeout active until session.updated", () => {
    const transport = new FakeTransport();
    const sink = createSink();
    const clock = new FakeClock();
    new OpenAITranslationProvider("key", "ja", { connect: () => transport }, sink, clock);
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    clock.fireNext();
    expect(sink.onFatal).toHaveBeenCalledWith("PROVIDER_TRANSPORT");
  });

  it("fails closed on a malformed configuration acknowledgement", () => {
    const transport = new FakeTransport();
    const sink = createSink();
    new OpenAITranslationProvider("key", "ja", { connect: () => transport }, sink, new FakeClock());
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    transport.message(JSON.stringify({ type: "session.updated" }));
    expect(sink.onFatal).toHaveBeenCalledWith("PROVIDER_INVALID_PAYLOAD");
  });

  it("uses correlated native ping/pong without mutating translation settings, including silence", () => {
    const transport = new FakeTransport();
    const native: ProviderTransport = transport;
    const pings: string[] = [];
    let pong: (payload: string) => void = () => {};
    native.ping = payload => pings.push(payload);
    native.onPong = handler => { pong = handler; };
    const sink = createSink();
    const clock = new FakeClock();
    const provider = new OpenAITranslationProvider("key", "ja", { connect: () => native }, sink, clock);
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    transport.message(JSON.stringify({ type: "session.updated", session: {} }));
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
    expect(transport.sent.filter(data => JSON.parse(data).type === "session.update")).toHaveLength(1);
    expect(provider.appendPcm(Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64"))).toBe(true);
    clock.fireNext();
    expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
    expect(clock.timers).toHaveLength(0);
    pong(pings[1]!);
    expect(clock.timers).toHaveLength(0);
  });

  it("rejects unobservable or invalid transport buffers before changing API settings or sending audio", () => {
    for (const size of [undefined, NaN, -1]) {
      const transport = new FakeTransport();
      transport.bufferedAmount = size;
      const sink = createSink();
      const provider = new OpenAITranslationProvider("key", "en", { connect: () => transport }, sink, new FakeClock());
      transport.open();
      transport.message(JSON.stringify({ type: "session.created", session: {} }));
      expect(sink.onFatal).toHaveBeenCalledExactlyOnceWith("PROVIDER_TRANSPORT");
      expect(transport.sent).toHaveLength(0);
      expect(provider.appendPcm(Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64"))).toBe(false);
    }
  });

  it("rejects mismatched optional provider audio metadata", () => {
    const transport = new FakeTransport();
    const sink = createSink();
    new OpenAITranslationProvider("key", "en", { connect: () => transport }, sink, new FakeClock());
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    transport.message(JSON.stringify({ type: "session.updated", session: {} }));
    transport.message(JSON.stringify({
      type: "session.output_audio.delta",
      delta: Buffer.alloc(2).toString("base64"),
      sample_rate: 16_000,
      channels: 1,
      format: "pcm16",
    }));
    expect(sink.onFatal).toHaveBeenCalledWith("PROVIDER_INVALID_PAYLOAD");
  });
});
