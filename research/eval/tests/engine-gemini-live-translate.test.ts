import { describe, expect, it } from "vitest";
import type { EngineConfig } from "../src/engine.ts";
import {
  GEMINI_LIVE_TRANSLATE_MODEL,
  buildGeminiSetup,
  downsample24kTo16k,
  geminiLiveUrl,
  parseGeminiMessage,
  parseGeminiOptions,
} from "../src/engines/gemini-live-translate.ts";

const CONFIG: EngineConfig = { engineId: "gemini-live-translate", sourceLanguage: "ja", targetLanguage: "en", frameMs: 200, options: {} };

describe("parseGeminiOptions", () => {
  it("takes the project from the option or GOOGLE_CLOUD_PROJECT and defaults to global without echo", () => {
    expect(parseGeminiOptions({ project: "niho-app-stg" }, {})).toEqual({ project: "niho-app-stg", location: "global", echo: false });
    expect(parseGeminiOptions({}, { GOOGLE_CLOUD_PROJECT: "my-proj-1" })).toEqual({ project: "my-proj-1", location: "global", echo: false });
    expect(parseGeminiOptions({ project: "p-1234", location: "us-central1", echo: "true" }, {})).toEqual({ project: "p-1234", location: "us-central1", echo: true });
  });

  it("rejects a missing project, a bad location and unknown options", () => {
    expect(() => parseGeminiOptions({}, {})).toThrow();
    expect(() => parseGeminiOptions({ project: "niho-app-stg", location: "Tokyo!" }, {})).toThrow();
    expect(() => parseGeminiOptions({ project: "niho-app-stg", voice: "marin" }, {})).toThrow();
  });
});

describe("buildGeminiSetup / geminiLiveUrl", () => {
  it("names the Vertex model resource and enables translation to the target language with both transcripts", () => {
    const setup = buildGeminiSetup(CONFIG, { project: "niho-app-stg", location: "global", echo: false }) as { setup: Record<string, unknown> };
    expect(setup.setup.model).toBe(`projects/niho-app-stg/locations/global/publishers/google/models/${GEMINI_LIVE_TRANSLATE_MODEL}`);
    expect(setup.setup.generationConfig).toEqual({
      responseModalities: ["AUDIO"],
      translationConfig: { targetLanguageCode: "en", echoTargetLanguage: false },
    });
    expect(setup.setup.inputAudioTranscription).toEqual({});
    expect(setup.setup.outputAudioTranscription).toEqual({});
    expect(JSON.stringify(setup)).not.toContain("systemInstruction");
  });

  it("uses the global host without a region prefix", () => {
    expect(geminiLiveUrl("global")).toBe("wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent");
    expect(geminiLiveUrl("us-central1")).toMatch(/^wss:\/\/us-central1-aiplatform\.googleapis\.com\//u);
  });
});

describe("downsample24kTo16k", () => {
  it("turns 200 ms at 24 kHz (9600 bytes) into 200 ms at 16 kHz (6400 bytes) and keeps a constant signal", () => {
    const pcm = Buffer.alloc(9600);
    for (let i = 0; i < 4800; i += 1) pcm.writeInt16LE(1000, i * 2);
    const out = downsample24kTo16k(pcm);
    expect(out.length).toBe(6400);
    expect(out.readInt16LE(0)).toBe(1000);
    expect(out.readInt16LE(6398)).toBe(1000);
  });

  it("averages the second and third sample of each group and drops a trailing remainder", () => {
    const pcm = Buffer.alloc(8);
    [10, 20, 40, 7].forEach((v, i) => pcm.writeInt16LE(v, i * 2));
    const out = downsample24kTo16k(pcm);
    expect(out.length).toBe(4);
    expect([out.readInt16LE(0), out.readInt16LE(2)]).toEqual([10, 30]);
  });
});

describe("parseGeminiMessage", () => {
  it("splits serverContent into audio, transcripts and turn markers", () => {
    const audio = Buffer.from([1, 0, 2, 0]).toString("base64");
    const events = parseGeminiMessage({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }] },
        outputTranscription: { text: "Hello" },
        inputTranscription: { text: "こんにちは" },
        turnComplete: true,
      },
    });
    expect(events.map(e => e.kind)).toEqual(["audio", "outputText", "inputText", "turnComplete"]);
    expect((events[0] as { pcm: Buffer }).pcm.length).toBe(4);
  });

  it("reads setupComplete, usage, goAway and error, and reports unknown keys without the body", () => {
    expect(parseGeminiMessage({ setupComplete: {} })).toEqual([{ kind: "setupComplete" }]);
    expect(parseGeminiMessage({ usageMetadata: { promptTokenCount: 120, responseTokenCount: 30, totalTokenCount: 150 } })).toEqual([{ kind: "usage", promptTokens: 120, responseTokens: 30 }]);
    expect(parseGeminiMessage({ goAway: { timeLeft: "60s" } })).toEqual([{ kind: "goAway", timeLeft: "60s" }]);
    expect(parseGeminiMessage({ error: { code: 400, status: "INVALID_ARGUMENT", message: "bad field x" } })[0]).toMatchObject({ kind: "error" });
    expect(parseGeminiMessage({ somethingNew: { text: "secret body" } })).toEqual([{ kind: "unknown", keys: "somethingNew" }]);
  });
});
