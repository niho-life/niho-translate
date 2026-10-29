import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInterpreterInstructions } from "../src/prompts/interpreter.ts";
import { firstVoicedSample, formatRunId, parseCliArgs, parseOptionArgs, randomSuffix, resolveOutRoot, RunRecorder, VOICED_PEAK } from "../src/run.ts";
import { loadEngineFactory, resolveOptions } from "../src/engines/index.ts";
import { buildLiveSessionStart, parseLiveOptions } from "../src/engines/openai-live.ts";
import {
  buildRealtimeSessionUpdate,
  parseRealtimeOptions,
  parseVad,
  readUsageTokens,
  realtimeCostUsd,
  transcriptionCostUsd,
} from "../src/engines/openai-realtime.ts";
import { parseTranslateOptions, rewriteTranslateSessionUpdate } from "../src/engines/openai-translate.ts";
import type { EngineConfig } from "../src/engine.ts";

const BASE = ["--wav", "/abs/synthetic.wav", "--window", "0:20", "--source-id", "syn-1", "--engine", "openai-live"];
const CONFIG: EngineConfig = { engineId: "openai-realtime", sourceLanguage: "ja", targetLanguage: "en", frameMs: 200, options: {} };

describe("parseCliArgs", () => {
  it("applies the README defaults", () => {
    expect(parseCliArgs(BASE)).toEqual({
      wavPath: "/abs/synthetic.wav",
      window: { startSec: 0, endSec: 20 },
      sourceId: "syn-1",
      engineId: "openai-live",
      frameMs: 200,
      options: {},
      tailSilenceSec: 20,
      finishTimeoutSec: 20,
      outRoot: undefined,
      source: "ja",
      target: "en",
    });
  });

  it("collects repeated --option and accepts --flag=value", () => {
    const args = parseCliArgs([...BASE, "--option", "vad=server:500", "--option=preset=plain", "--frame-ms=100", "--tail-silence-sec", "2.5"]);
    expect(args.options).toEqual({ vad: "server:500", preset: "plain" });
    expect(args.frameMs).toBe(100);
    expect(args.tailSilenceSec).toBe(2.5);
  });

  it("rejects invalid input with English codes", () => {
    const code = (argv: string[]) => {
      try {
        parseCliArgs(argv);
        return "OK";
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    expect(code([...BASE, "--frame-ms", "150"])).toBe("INVALID_FRAME_MS");
    expect(code(["--wav", "relative.wav", ...BASE.slice(2)])).toBe("WAV_PATH_NOT_ABSOLUTE");
    expect(code([...BASE.slice(0, 2), "--window", "30:10", ...BASE.slice(4)])).toBe("INVALID_WINDOW");
    expect(code([...BASE.slice(0, 2), "--window", "0:4000", ...BASE.slice(4)])).toBe("WINDOW_TOO_LONG");
    expect(code([...BASE, "--bogus", "1"])).toBe("UNKNOWN_ARGUMENT");
    expect(code([...BASE, "/abs/positional.wav"])).toBe("UNEXPECTED_ARGUMENT");
    expect(code([...BASE, "--engine", "x"])).toBe("DUPLICATE_ARGUMENT");
    expect(code([...BASE, "--source", "en", "--target", "en"])).toBe("INVALID_LANGUAGE_PAIR");
    expect(code([...BASE, "--source-id"])).toBe("MISSING_ARGUMENT_VALUE");
    expect(code(BASE.slice(0, 6))).toBe("MISSING_ARGUMENT");
    expect(code([...BASE.slice(0, 4), "--source-id", "../x", ...BASE.slice(6)])).toBe("INVALID_SOURCE_ID");
    expect(code([...BASE, "--finish-timeout-sec", "0"])).toBe("INVALID_FINISH_TIMEOUT");
  });
});

describe("parseOptionArgs", () => {
  it("splits at the first '=' and rejects duplicates", () => {
    expect(parseOptionArgs(["a=b=c", "x.y=1"])).toEqual({ a: "b=c", "x.y": "1" });
    expect(() => parseOptionArgs(["a=1", "a=2"])).toThrow("DUPLICATE_OPTION");
    expect(() => parseOptionArgs(["=1"])).toThrow("INVALID_OPTION_FORMAT");
    expect(() => parseOptionArgs(["novalue"])).toThrow("INVALID_OPTION_FORMAT");
    expect(() => parseOptionArgs(["a="])).toThrow("INVALID_OPTION_VALUE");
  });
});

describe("run location and id", () => {
  it("refuses an output root inside the public repository", () => {
    expect(() => resolveOutRoot("/repo/research/out", undefined, "/repo")).toThrow("OUT_ROOT_INSIDE_REPO");
    expect(() => resolveOutRoot("/repo", undefined, "/repo")).toThrow("OUT_ROOT_INSIDE_REPO");
    expect(resolveOutRoot(undefined, "/private/eval", "/repo")).toBe("/private/eval/runs");
    expect(resolveOutRoot("/repo-private/runs", undefined, "/repo")).toBe("/repo-private/runs");
    expect(() => resolveOutRoot(undefined, undefined, "/repo")).toThrow("OUT_ROOT_MISSING");
    expect(() => resolveOutRoot("relative/runs", undefined, "/repo")).toThrow("OUT_ROOT_NOT_ABSOLUTE");
  });

  it("formats <YYYYMMDD-HHMMSS>-<engineId>-<sourceId>-<rand4>", () => {
    expect(formatRunId(new Date(2026, 9, 28, 3, 4, 5), "openai-live", "syn-1", "ab12")).toBe("20261028-030405-openai-live-syn-1-ab12");
    expect(randomSuffix()).toMatch(/^[a-z0-9]{4}$/u);
  });
});

describe("engine registry", () => {
  it("rejects unknown engines and reports a missing cascade as unavailable at run time", async () => {
    await expect(loadEngineFactory("nope")).rejects.toMatchObject({ code: "UNKNOWN_ENGINE" });
    await expect(loadEngineFactory("openai-realtime")).resolves.toBeTypeOf("function");
    const cascade = await loadEngineFactory("cascade").then(() => "LOADED", (error: { code?: string }) => error.code);
    expect(["LOADED", "ENGINE_UNAVAILABLE"]).toContain(cascade);
  });

  it("validates option keys and values before connecting", () => {
    expect(() => resolveOptions({ typo: "1" }, { model: { default: "a" } })).toThrow("UNKNOWN_OPTION");
    expect(() => resolveOptions({ model: "b" }, { model: { default: "a", values: ["a"] } })).toThrow("INVALID_OPTION");
    expect(resolveOptions({}, { model: { default: "a" }, extra: {} })).toEqual({ model: "a", extra: undefined });
  });
});

describe("openai-translate options", () => {
  const productUpdate = JSON.stringify({
    type: "session.update",
    session: { audio: { input: { transcription: null, noise_reduction: { type: "near_field" } }, output: { language: "en" } } },
  });

  it("keeps the product session.update byte-for-byte by default", () => {
    const settings = parseTranslateOptions({});
    expect(settings).toEqual({ noiseReduction: "near_field", inputTranscription: false });
    expect(rewriteTranslateSessionUpdate(productUpdate, settings)).toBe(productUpdate);
  });

  it("rewrites only audio.input for non-default options", () => {
    const rewritten = JSON.parse(rewriteTranslateSessionUpdate(productUpdate, parseTranslateOptions({ noiseReduction: "far_field", inputTranscription: "1" })));
    expect(rewritten).toEqual({
      type: "session.update",
      session: { audio: { input: { transcription: { model: "gpt-realtime-whisper" }, noise_reduction: { type: "far_field" } }, output: { language: "en" } } },
    });
    const none = JSON.parse(rewriteTranslateSessionUpdate(productUpdate, parseTranslateOptions({ noiseReduction: "none" })));
    expect(none.session.audio.input).toEqual({ transcription: null, noise_reduction: null });
    const audio = JSON.stringify({ type: "session.input_audio_buffer.append", audio: "AAAA" });
    expect(rewriteTranslateSessionUpdate(audio, parseTranslateOptions({ noiseReduction: "none" }))).toBe(audio);
    expect(() => parseTranslateOptions({ noiseReduction: "loud" })).toThrow("INVALID_OPTION");
  });
});

describe("openai-live session.start", () => {
  it("sends model, interpreter instructions, PCM 24 kHz and voice", () => {
    const settings = parseLiveOptions({});
    expect(settings).toEqual({ preset: "domain", voice: "marin", context: null });
    expect(buildLiveSessionStart({ ...CONFIG, engineId: "openai-live" }, settings)).toEqual({
      type: "session.start",
      event_id: "evt_eval_start",
      session: {
        model: "gpt-live-1",
        instructions: buildInterpreterInstructions("domain", "ja", "en"),
        audio: { format: { type: "audio/pcm", rate: 24_000 }, output: { voice: "marin" } },
      },
    });
    expect(() => parseLiveOptions({ inputTranscription: "1" })).toThrow("UNKNOWN_OPTION");
    expect(() => parseLiveOptions({ preset: "chatty" })).toThrow("INVALID_OPTION");
  });
  it("loads a short research context from a private file without changing the default prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "niho-eval-context-"));
    try {
      const path = join(dir, "context.txt");
      writeFileSync(path, "Two people discuss property visits in Kamakura.");
      const settings = parseLiveOptions({ preset: "plain-q", contextFile: path });
      const started = buildLiveSessionStart({ ...CONFIG, engineId: "openai-live" }, settings);
      const session = started.session as { instructions: string };
      expect(session.instructions).toContain("Background to disambiguate terms only: Two people discuss property visits in Kamakura.");
      expect(session.instructions).toContain("Do not add any fact from the background unless it is spoken in the audio.");
      expect(() => parseLiveOptions({ contextFile: "relative.txt" })).toThrow("INVALID_OPTION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openai-realtime session.update", () => {
  it("parses VAD presets", () => {
    expect(parseVad("semantic:high", false)).toEqual({ type: "semantic_vad", eagerness: "high", create_response: true, interrupt_response: false });
    expect(parseVad("server:500", true)).toEqual({ type: "server_vad", silence_duration_ms: 500, create_response: true, interrupt_response: true });
    expect(() => parseVad("server:10", false)).toThrow("INVALID_OPTION");
    expect(() => parseVad("semantic", false)).toThrow("INVALID_OPTION");
  });

  it("builds an audio-only interpreter session", () => {
    const update = buildRealtimeSessionUpdate(CONFIG, parseRealtimeOptions({}));
    expect(update).toEqual({
      type: "session.update",
      event_id: "evt_eval_session",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions: buildInterpreterInstructions("domain", "ja", "en"),
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            turn_detection: { type: "semantic_vad", eagerness: "high", create_response: true, interrupt_response: false },
          },
          output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" },
        },
      },
    });
    const withOptions = buildRealtimeSessionUpdate(CONFIG, parseRealtimeOptions({
      model: "gpt-realtime-2.1-mini", vad: "server:700", interrupt: "1", inputTranscription: "1", reasoning: "low", preset: "plain",
    })) as { session: { audio: { input: Record<string, unknown> }; reasoning?: unknown; instructions: string } };
    expect(withOptions.session.audio.input.transcription).toEqual({ model: "gpt-4o-mini-transcribe", language: "ja" });
    expect(withOptions.session.audio.input.turn_detection).toMatchObject({ type: "server_vad", silence_duration_ms: 700, interrupt_response: true });
    expect(withOptions.session.reasoning).toEqual({ effort: "low" });
    expect(withOptions.session.instructions).toBe(buildInterpreterInstructions("plain", "ja", "en"));
    expect(() => parseRealtimeOptions({ model: "gpt-4o-realtime-preview" })).toThrow("INVALID_OPTION");
  });

  it("estimates cost from response.done usage with cached input", () => {
    const tokens = readUsageTokens({
      total_tokens: 253,
      input_tokens: 132,
      output_tokens: 121,
      input_token_details: {
        text_tokens: 119,
        audio_tokens: 13,
        image_tokens: 0,
        cached_tokens: 64,
        cached_tokens_details: { text_tokens: 64, audio_tokens: 0, image_tokens: 0 },
      },
      output_token_details: { text_tokens: 30, audio_tokens: 91 },
    })!;
    expect(tokens).toMatchObject({ audioIn: 13, audioCachedIn: 0, textIn: 119, textCachedIn: 64, audioOut: 91, textOut: 30 });
    // 13*32 + 55*4 + 64*0.4 + 91*64 + 30*24 = 7,205.6 per 1M
    expect(realtimeCostUsd("gpt-realtime-2.1", tokens)).toBeCloseTo(0.0072056, 9);
    // 13*10 + 55*0.6 + 64*0.06 + 91*20 + 30*2.4 = 2,058.84 per 1M
    expect(realtimeCostUsd("gpt-realtime-2.1-mini", tokens)).toBeCloseTo(0.00205884, 9);
    // 内訳の無い token は audio 単価で数える。
    expect(readUsageTokens({ input_tokens: 10, output_tokens: 5 })).toMatchObject({ audioIn: 10, audioOut: 5, textIn: 0, textOut: 0 });
    expect(transcriptionCostUsd("gpt-transcribe", { type: "duration", seconds: 60 })).toBeCloseTo(0.0045, 9);
    expect(transcriptionCostUsd("gpt-4o-mini-transcribe", { type: "tokens", input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(1.25, 9);
    expect(transcriptionCostUsd("unknown-model", { type: "duration", seconds: 60 })).toBe(0);
  });
});

describe("RunRecorder", () => {
  it("converts sink calls to RunEvents relative to t0 with the ideal playback model", () => {
    let now = 900;
    const recorder = new RunRecorder(() => now);
    recorder.mark(t => ({ type: "engine.ready", t }));
    now = 1_000;
    recorder.markAt(1_000, t => ({ type: "frame.sent", t, idx: 0, scheduledT: 0, bytes: 9_600 }));
    now = 1_500;
    recorder.outputAudio(Buffer.alloc(4_801)); // odd byte is dropped
    recorder.outputAudio(Buffer.alloc(4_800));
    now = 1_550;
    recorder.outputTranscript("Hello", { itemId: "item_1" });
    recorder.inputTranscript("こんにちは");
    recorder.diag("finish.incomplete", { reason: "test" });
    recorder.fatal("bad code with spaces", "detail /with/path");
    recorder.seal();
    recorder.outputAudio(Buffer.alloc(4_800));
    const built = recorder.build(1_000);
    expect(recorder.incomplete).toBe(true);
    expect(recorder.fatalCode).toBe("ENGINE_FATAL");
    expect(built.events.map(event => event.type)).toEqual([
      "engine.ready", "frame.sent", "audio.out", "audio.out", "transcript.out", "transcript.in", "diag", "fatal",
    ]);
    expect(built.events[0]).toEqual({ type: "engine.ready", t: -100 });
    expect(built.events[2]).toEqual({ type: "audio.out", t: 500, bytes: 4_800, playStartT: 500, playEndT: 600, queueMs: 0 });
    expect(built.events[3]).toEqual({ type: "audio.out", t: 500, bytes: 4_800, playStartT: 600, playEndT: 700, queueMs: 100 });
    expect(built.events[4]).toEqual({ type: "transcript.out", t: 550, text: "Hello", itemId: "item_1" });
    expect(built.events[7]).toEqual({ type: "fatal", t: 550, code: "ENGINE_FATAL", detail: "detail__with_path" });
    expect(built.timeline.map(chunk => chunk.playStartT)).toEqual([500, 600]);
    expect(built.transcriptIn).toEqual([{ t: 550, text: "こんにちは" }]);
  });

  it("marks the first voiced output chunk once, without text", () => {
    let now = 0;
    const recorder = new RunRecorder(() => now);
    const quiet = Buffer.alloc(480);
    quiet.writeInt16LE(27, 10);
    const voiced = Buffer.alloc(480);
    voiced.writeInt16LE(-VOICED_PEAK, 48 * 2); // sample 48 = 2 ms
    now = 100;
    recorder.outputAudio(quiet);
    now = 300;
    recorder.outputAudio(voiced);
    recorder.outputAudio(voiced);
    now = 600;
    recorder.outputAudio(quiet);
    const diags = recorder.build(0).events.filter(event => event.type === "diag");
    expect(diags).toEqual([{ type: "diag", t: 300, kind: "harness.first_voiced_audio", data: { offsetMs: 2, thresholdPeak: VOICED_PEAK } }]);
    expect(recorder.lastVoicedAudioAt).toBe(300);
    expect(firstVoicedSample(quiet, VOICED_PEAK)).toBeUndefined();
  });
});
