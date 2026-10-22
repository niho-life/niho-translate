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
  next = 1;
  setTimeout(handler: () => void): number {
    const id = this.next++;
    this.timers.set(id, handler);
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
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
    transport.message(JSON.stringify({
      type: "session.output_audio.delta",
      delta: audio,
      sample_rate: 24_000,
      channels: 1,
      format: "pcm16",
    }));
    expect(sink.onOutputAudio).toHaveBeenCalledWith(audio);
    expect(sink.onFatal).not.toHaveBeenCalled();
  });

  it("reassembles non-frame-aligned even PCM and emits the final short tail", () => {
    const transport = new FakeTransport();
    const sink = createSink();
    new OpenAITranslationProvider("key", "ja", { connect: () => transport }, sink, new FakeClock());
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    transport.message(JSON.stringify({ type: "session.updated", session: {} }));
    const bytes = Buffer.alloc(AUDIO_BATCH_BYTES + 2, 7);
    transport.message(JSON.stringify({
      type: "session.output_audio.delta",
      delta: bytes.subarray(0, 1_002).toString("base64"),
    }));
    transport.message(JSON.stringify({
      type: "session.output_audio.delta",
      delta: bytes.subarray(1_002).toString("base64"),
    }));
    expect(sink.onOutputAudio).toHaveBeenCalledTimes(1);
    transport.message(JSON.stringify({ type: "session.closed" }));
    expect(sink.onOutputAudio).toHaveBeenCalledTimes(2);
    expect(Buffer.from((sink.onOutputAudio as ReturnType<typeof vi.fn>).mock.calls[1]![0], "base64")).toHaveLength(2);
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
    expect(transport2.closes.some(([, reason]) => reason === "close-timeout")).toBe(true);
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

  it("uses serial session.update health acknowledgements when bufferedAmount is unavailable", () => {
    const transport = new FakeTransport();
    transport.bufferedAmount = undefined;
    const sink = createSink();
    const clock = new FakeClock();
    const provider = new OpenAITranslationProvider("key", "ja", { connect: () => transport }, sink, clock);
    transport.open();
    transport.message(JSON.stringify({ type: "session.created", session: {} }));
    transport.message(JSON.stringify({ type: "session.updated", session: {}, event_id: "server-only" }));
    expect(clock.timers).toHaveLength(1);
    clock.fireNext();
    expect(JSON.parse(transport.sent.at(-1)!)).toEqual({
      type: "session.update",
      session: { audio: {} },
    });
    expect(clock.timers).toHaveLength(1);
    transport.message(JSON.stringify({ type: "session.updated", session: {}, elapsed_ms: 99 }));
    expect(clock.timers).toHaveLength(1);
    clock.fireNext();
    clock.fireNext();
    expect(sink.onFatal).toHaveBeenCalledWith("PROVIDER_TRANSPORT");
    expect(transport.closes).toContainEqual([1008, "PROVIDER_TRANSPORT"]);
    expect(provider.appendPcm(Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64"))).toBe(false);
    expect(clock.timers).toHaveLength(0);
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
