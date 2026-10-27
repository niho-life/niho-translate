import { describe, expect, it } from "vitest";
import { transcriptionSessionUpdate } from "../src/engines/cascade/asr.ts";
import { estimateCascadeCostUsd } from "../src/engines/cascade/cost.ts";
import { DEFAULT_CASCADE_OPTIONS, parseCascadeOptions } from "../src/engines/cascade/options.ts";
import { TranscriptAssembler } from "../src/engines/cascade/transcript.ts";
import { EnergyVad } from "../src/engines/cascade/vad.ts";

describe("cascade options", () => {
  it("既定値と検証", () => {
    expect(parseCascadeOptions({})).toEqual(DEFAULT_CASCADE_OPTIONS);
    expect(parseCascadeOptions({ llm: "gpt-4.1-mini", context: "3", glossary: "0" })).toMatchObject({ llm: "gpt-4.1-mini", context: 3, glossary: false });
    expect(() => parseCascadeOptions({ llm: "gpt-unknown" })).toThrow();
    expect(() => parseCascadeOptions({ typo: "1" })).toThrow(/unknown cascade option/);
    expect(() => parseCascadeOptions({ asrVad: "semantic" })).toThrow(/gpt-live-transcribe/);
    expect(parseCascadeOptions({ asr: "gpt-transcribe" }).asrVad).toBe("semantic");
    expect(parseCascadeOptions({ asr: "gpt-transcribe", asrVad: "client" }).asrVad).toBe("client");
    expect(() => parseCascadeOptions({ softMaxMs: "9000", hardMaxMs: "8000" })).toThrow();
  });
});

describe("cascade ASR session", () => {
  const base = {
    model: "gpt-live-transcribe" as const,
    delay: "low" as const,
    vad: "client" as const,
    eagerness: "high" as const,
    noiseReduction: "near_field" as const,
    prompt: "用途",
    keywords: ["鎌倉", "bad<word", "内見"],
    languages: ["ja"],
  };

  it("gpt-live-transcribe は turn_detection=null・delay・keywords（不正文字は除外）", () => {
    const update = transcriptionSessionUpdate(base) as { session: { audio: { input: Record<string, unknown> } } };
    const input = update.session.audio.input;
    expect(input.turn_detection).toBeNull();
    expect(input.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(input.noise_reduction).toEqual({ type: "near_field" });
    expect(input.transcription).toEqual({ model: "gpt-live-transcribe", languages: ["ja"], prompt: "用途", keywords: ["鎌倉", "内見"], delay: "low" });
  });

  it("gpt-transcribe + semantic_vad は delay を送らない", () => {
    const update = transcriptionSessionUpdate({ ...base, model: "gpt-transcribe", vad: "semantic", noiseReduction: "none" }) as { session: { audio: { input: Record<string, unknown> } } };
    const input = update.session.audio.input;
    expect(input.turn_detection).toEqual({ type: "semantic_vad", eagerness: "high" });
    expect(input.noise_reduction).toBeNull();
    expect((input.transcription as Record<string, unknown>).delay).toBeUndefined();
  });
});

describe("cascade transcript assembler", () => {
  it("先頭の未確定 item だけを出し、後続は先頭の確定まで保留する", () => {
    const a = new TranscriptAssembler();
    a.delta("i1", "明日の");
    a.delta("i1", "内見は");
    a.delta("i2", "開催しません。");
    expect(a.text).toBe("明日の内見は");
    const done = a.completed("i1", "明日の内見は、");
    expect(done.revised).toBe(true);
    expect(done.endPos).toBe("明日の内見は、".length);
    expect(a.text).toBe("明日の内見は、開催しません。");
    expect(a.finalItemsInOrder()).toEqual(["i1"]);
    a.completed("i2", "開催しません。");
    expect(a.openItems).toBe(0);
    expect(a.textThrough("i1")).toBe("明日の内見は、");
  });

  it("item 先頭の空白は delta でも最終文字列でも落とし、書き換えに数えない", () => {
    const a = new TranscriptAssembler();
    a.delta("i1", " 我が社は");
    a.delta("i1", "五周年です。");
    expect(a.text).toBe("我が社は五周年です。");
    expect(a.completed("i1", "我が社は五周年です。").revised).toBe(false);
  });

  it("committed の previous_item_id で順序を直し、失敗した item は文字なしで確定扱い", () => {
    const a = new TranscriptAssembler();
    a.committed("i2", null);
    a.committed("i1", null);
    a.committed("i2", "i1");
    a.completed("i2", "二つ目。");
    a.failed("i1");
    expect(a.text).toBe("二つ目。");
    expect(a.finalItemsInOrder()).toEqual(["i1", "i2"]);
  });
});

describe("cascade energy VAD", () => {
  const tone = (ms: number): Buffer => {
    const samples = ms * 24;
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(8_000 * Math.sin((2 * Math.PI * 220 * i) / 24_000)), i * 2);
    return buf;
  };
  const silence = (ms: number): Buffer => Buffer.alloc(ms * 48);

  it("発話の後の無音 commitSilenceMs で speech_end（200 ms frame で送っても）", () => {
    const vad = new EnergyVad({ commitSilenceMs: 500, minSpeechMs: 60, absoluteFloorDb: -50, marginDb: 12, maxItemMs: 15_000, forceItemMs: 20_000 });
    const audio = Buffer.concat([silence(400), tone(1_000), silence(1_000)]);
    const events = [];
    for (let off = 0; off < audio.length; off += 9_600) events.push(...vad.process(audio.subarray(off, off + 9_600)));
    expect(events.map(e => e.type)).toEqual(["speech_start", "speech_end"]);
    const end = events[1];
    expect(end?.atMs).toBe(1_900);
    expect(vad.inSpeech).toBe(false);
    expect(vad.silenceSinceVoiceMs).toBeGreaterThanOrEqual(1_000);
  });

  it("無音だけでは何も起きない", () => {
    const vad = new EnergyVad();
    expect(vad.process(silence(3_000))).toEqual([]);
    expect(vad.hasSpeechSinceCommit).toBe(false);
  });

  it("切れ目の無い長い発話は maxItemMs / forceItemMs で区切る", () => {
    const vad = new EnergyVad({ commitSilenceMs: 500, minSpeechMs: 60, absoluteFloorDb: -50, marginDb: 12, maxItemMs: 2_000, forceItemMs: 3_000 });
    const events = vad.process(tone(3_500));
    expect(events.map(e => e.type)).toEqual(["speech_start", "max_length"]);
    expect(events[1]?.atMs).toBe(3_000);
  });
});

describe("cascade cost", () => {
  it("ASR 分単価 + LLM token + TTS 音声 token", () => {
    const cost = estimateCascadeCostUsd({
      asrModel: "gpt-live-transcribe",
      asrBilledSeconds: 60,
      llmModel: "gpt-5.4-mini",
      llmTier: "default",
      llmInputTokens: 1_000_000,
      llmCachedTokens: 0,
      llmOutputTokens: 0,
      tts: "gpt-4o-mini-tts",
      ttsAudioMs: 60_000,
      ttsInputChars: 0,
      realtimeTextInputTokens: 0,
      realtimeCachedInputTokens: 0,
      realtimeTextOutputTokens: 0,
      realtimeAudioOutputTokens: 0,
    });
    // 0.017 (ASR 1 分) + 0.75 (LLM 1M input) + 0.015 (TTS 1 分)
    expect(cost).toBeCloseTo(0.017 + 0.75 + 0.015, 6);
    expect(estimateCascadeCostUsd({
      asrModel: "gpt-transcribe", asrBilledSeconds: 0, llmModel: "unknown", llmTier: "default", llmInputTokens: 0, llmCachedTokens: 0, llmOutputTokens: 0,
      tts: "realtime-mini", ttsAudioMs: 0, ttsInputChars: 0, realtimeTextInputTokens: 0, realtimeCachedInputTokens: 0, realtimeTextOutputTokens: 0, realtimeAudioOutputTokens: 0,
    })).toBeUndefined();
  });
});
