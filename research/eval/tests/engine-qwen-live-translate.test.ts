import { describe, expect, it } from "vitest";
import type { EngineConfig, EngineSink } from "../src/engine.ts";
import qwenFactory, {
  QWEN_MODEL,
  parseQwenEvent,
  parseQwenOptions,
  qwenSessionUpdate,
  qwenUrl,
} from "../src/engines/qwen-live-translate.ts";

const CONFIG: EngineConfig = { engineId: "qwen-live-translate", sourceLanguage: "ja", targetLanguage: "en", frameMs: 200, options: {} };
const SINK: EngineSink = { outputAudio() {}, outputTranscript() {}, inputTranscript() {}, diag() {}, fatal() {} };

describe("Qwen LiveTranslate contract", () => {
  it("uses the documented Singapore model endpoint and sends one-speaker audio/text translation", () => {
    const settings = parseQwenOptions({ hotwords: "env" }, { QWEN_WORKSPACE_ID: "ws-test123", QWEN_HOTWORDS_JSON: '{"鎌倉":"Kamakura","湘南":"Shonan"}' });
    expect(qwenUrl(settings)).toBe(`wss://ws-test123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=${QWEN_MODEL}`);
    expect(qwenSessionUpdate(CONFIG, settings)).toEqual({
      type: "session.update",
      session: {
        output_modalities: ["text", "audio"],
        audio: { input: { turn_detection: { type: "speaker_detection", threshold: 0.5 } } },
        translation: { language: "en", corpus: { phrases: { 鎌倉: "Kamakura", 湘南: "Shonan" } } },
      },
    });
    const vad = parseQwenOptions({ turnDetection: "server-vad" }, { QWEN_WORKSPACE_ID: "ws-test123" });
    expect(qwenSessionUpdate(CONFIG, vad)).toMatchObject({
      session: { audio: { input: { turn_detection: { type: "server_vad" } } } },
    });
    expect(qwenUrl(parseQwenOptions({ region: "beijing" }, { QWEN_WORKSPACE_ID: "ws-test123" })))
      .toContain("ws-test123.cn-beijing.maas.aliyuncs.com");
  });

  it("rejects malformed workspace and hotwords before opening a billable session", () => {
    expect(() => parseQwenOptions({}, {})).toThrow();
    expect(() => parseQwenOptions({ region: "other" }, { QWEN_WORKSPACE_ID: "ws-test123" })).toThrow();
    expect(() => parseQwenOptions({ turnDetection: "manual" }, { QWEN_WORKSPACE_ID: "ws-test123" })).toThrow();
    expect(() => parseQwenOptions({}, { QWEN_WORKSPACE_ID: "bad.example.org" })).toThrow();
    expect(() => parseQwenOptions({ hotwords: "env" }, { QWEN_WORKSPACE_ID: "ws-test123" })).toThrow();
    expect(() => parseQwenOptions({ hotwords: "env" }, { QWEN_WORKSPACE_ID: "ws-test123", QWEN_HOTWORDS_JSON: "not json" })).toThrow();
    expect(() => parseQwenOptions({ hotwords: "env" }, { QWEN_WORKSPACE_ID: "ws-test123", QWEN_HOTWORDS_JSON: '{"__proto__":"x"}' })).toThrow();
    expect(() => qwenFactory(CONFIG, SINK, { openaiApiKey: "" })).toThrow("DASHSCOPE_API_KEY_MISSING");
  });

  it("converts documented delta events and strips error messages from diagnostics", () => {
    const pcm = Buffer.from([1, 0, 2, 0]);
    expect(parseQwenEvent({ type: "session.updated" })).toEqual({ kind: "ready" });
    expect(parseQwenEvent({ type: "session.finished" })).toEqual({ kind: "finished" });
    expect(parseQwenEvent({ type: "response.audio.delta", delta: pcm.toString("base64") })).toEqual({ kind: "audio", pcm });
    expect(parseQwenEvent({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_1", delta: "鎌倉" }))
      .toEqual({ kind: "inputText", text: "鎌倉", itemId: "item_1" });
    expect(parseQwenEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "鎌倉です" }))
      .toEqual({ kind: "inputFinal", text: "鎌倉です", itemId: "item_1" });
    expect(parseQwenEvent({ type: "response.audio_transcript.delta", item_id: "item_2", delta: "Kamakura" }))
      .toEqual({ kind: "outputText", text: "Kamakura", itemId: "item_2" });
    expect(parseQwenEvent({ type: "error", error: { code: "invalid_request", message: "secret transcript" } }))
      .toEqual({ kind: "remoteError", code: "invalid_request" });
    expect(parseQwenEvent({ type: "response.audio.delta", delta: Buffer.from("RIFF0000").toString("base64") }))
      .toEqual({ kind: "invalidAudio" });
  });
});
