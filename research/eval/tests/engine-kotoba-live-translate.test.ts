import { describe, expect, it } from "vitest";
import type { EngineConfig, EngineSink } from "../src/engine.ts";
import kotobaFactory, { KOTOBA_URL, kotobaSessionUpdate, parseKotobaEvent, parseKotobaOptions } from "../src/engines/kotoba-live-translate.ts";

const CONFIG: EngineConfig = { engineId: "kotoba-live-translate", sourceLanguage: "ja", targetLanguage: "en", frameMs: 200, options: {} };
const SINK: EngineSink = { outputAudio() {}, outputTranscript() {}, inputTranscript() {}, diag() {}, fatal() {} };

describe("Kotoba live translation research protocol", () => {
  it("uses fal's documented endpoint and a quality-delay setting only when requested", () => {
    expect(KOTOBA_URL).toBe("wss://fal.run/kotoba-technologies/kotoba-sts/v1/realtime_voice");
    const plain = kotobaSessionUpdate(CONFIG, parseKotobaOptions({}));
    expect(plain).toEqual({
      type: "voice_session.update",
      session: {
        object: "realtime.voice_session",
        turn_detection: false,
        input_audio_format: "pcm16",
        input_audio_sample_rate: 24_000,
        input_audio_number_of_channels: 1,
        input_audio_transcription: { language: "ja", target_language: "en" },
      },
    });
    expect(kotobaSessionUpdate(CONFIG, parseKotobaOptions({ delay: "10" })))
      .toMatchObject({ session: { delay: 10 } });
  });

  it("refuses invalid options or missing key before opening a billable session", () => {
    for (const delay of ["-1", "21", "1.5", "010", "100", "abc"]) {
      expect(() => parseKotobaOptions({ delay })).toThrow();
    }
    expect(() => parseKotobaOptions({ prompt: "translate" })).toThrow();
    expect(() => kotobaFactory(CONFIG, SINK, { openaiApiKey: "" })).toThrow("FAL_KEY_MISSING");
  });

  it("accepts only PCM16 audio and keeps server errors free of transcript text", () => {
    const pcm = Buffer.from([1, 0, 2, 0]);
    expect(parseKotobaEvent({ type: "voice_session.updated" })).toEqual({ kind: "ready" });
    expect(parseKotobaEvent({ type: "input_audio_buffer.committed" })).toEqual({ kind: "finished" });
    expect(parseKotobaEvent({ type: "conversation.item.input_audio_transcription.audio.delta", delta: pcm.toString("base64") }))
      .toEqual({ kind: "audio", pcm });
    expect(parseKotobaEvent({ type: "conversation.item.input_audio_transcription.audio.delta", delta: Buffer.from("RIFF0000").toString("base64") }))
      .toEqual({ kind: "invalidAudio" });
    expect(parseKotobaEvent({ type: "conversation.item.input_audio_transcription.text.delta", delta: "Hello", item_id: "item_1" }))
      .toEqual({ kind: "text", text: "Hello", itemId: "item_1" });
    expect(parseKotobaEvent({ type: "error", error: { code: "bad_audio", message: "private sentence" } }))
      .toEqual({ kind: "remoteError", code: "bad_audio" });
  });
});
