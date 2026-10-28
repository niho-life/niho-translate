import { describe, expect, it } from "vitest";
import type { TimedUnit } from "../src/reference/align.ts";
import { parseMakeReferenceArgs, parseWindow } from "../src/reference/args.ts";
import { parseDiarized, parseWhisperCpp, parseWhisperVerbose, readWavPcm16 } from "../src/reference/asr.ts";
import { buildReference, harmonizePlaceFacts, mapSpeakers } from "../src/reference/build.ts";
import { buildDraftRequest, draftSchema, formatWhisperWords, isUnresolved, parseDraftSegments, type DraftSegment } from "../src/reference/draft.ts";
import { redactSecrets } from "../src/reference/openai.ts";
import { referenceStats } from "../src/reference/stats.ts";
import { checkReference } from "../src/reference/validate.ts";
import { energyEnvelope, trimToVoiced, type EnergyEnvelope } from "../src/reference/vad.ts";

function words(text: string, msPerChar: number, startMs: number): TimedUnit[] {
  const out: TimedUnit[] = [];
  let t = startMs;
  for (const ch of text) {
    const punct = /[、。？！]/.test(ch);
    out.push({ text: ch, startMs: t, endMs: punct ? t : t + msPerChar });
    if (!punct) t += msPerChar;
  }
  return out;
}

function draft(partial: Partial<DraftSegment> & Pick<DraftSegment, "text">): DraftSegment {
  return { speaker: "話者0", kind: "statement", facts: [], uncertain: false, uncertainReason: null, discrepancies: [], ...partial };
}

describe("make-reference arguments", () => {
  it("parses the required options and defaults", () => {
    expect(parseMakeReferenceArgs(["--wav", "/private/a.wav", "--window", "150:450", "--source-id", "src1-w1"])).toEqual({
      wav: "/private/a.wav",
      windowStartSec: 150,
      windowEndSec: 450,
      sourceId: "src1-w1",
      transcriptKind: "human",
      llm: "gpt-5.4",
      reasoning: "medium",
      refreshAsr: false,
      refreshLlm: false,
      vadTrim: true,
      factsPass: true,
      factsLlm: "gpt-5.4",
      factsReasoning: "low",
    });
  });

  it("accepts the optional absolute paths and flags", () => {
    const args = parseMakeReferenceArgs([
      "--wav", "/private/a.wav", "--window", "0:30.5", "--source-id", "x.1",
      "--turn-transcript", "/private/t.md", "--transcript-kind", "gemini", "--out", "/private/o.json", "--llm", "gpt-5.4-mini",
      "--whisper-cli-model", "/private/m.bin", "--draft", "/private/d.json", "--reasoning", "high",
      "--refresh-asr", "--refresh-llm", "--no-vad-trim", "--no-facts-pass", "--facts-llm", "gpt-5.4-mini", "--facts-reasoning", "medium",
    ]);
    expect(args).toMatchObject({ windowEndSec: 30.5, turnTranscript: "/private/t.md", transcriptKind: "gemini", out: "/private/o.json", whisperCliModel: "/private/m.bin", draft: "/private/d.json", reasoning: "high", refreshAsr: true, refreshLlm: true, vadTrim: false, factsPass: false, factsLlm: "gpt-5.4-mini", factsReasoning: "medium" });
  });

  it("rejects relative paths, bad windows, ids and unknown options", () => {
    const base = ["--window", "150:450", "--source-id", "s"];
    for (const argv of [
      ["--wav", "a.wav", ...base],
      ["--wav", "/a.mp3", ...base],
      ["--wav", "/a.wav", "--window", "450:150", "--source-id", "s"],
      ["--wav", "/a.wav", "--window", "0:5", "--source-id", "s"],
      ["--wav", "/a.wav", "--window", "0:601", "--source-id", "s"],
      ["--wav", "/a.wav", "--window", "150:450", "--source-id", "../x"],
      ["--wav", "/a.wav", ...base, "--turn-transcript", "/t.txt"],
      ["--wav", "/a.wav", ...base, "--reasoning", "max"],
      ["--wav", "/a.wav", ...base, "--transcript-kind", "human2"],
      ["--wav", "/a.wav", ...base, "--unknown"],
      ["--wav", "/a.wav", ...base, "--out"],
      ["--wav", "/a.wav", ...base, "--refresh-asr", "--refresh-asr"],
      [...base],
    ]) {
      expect(() => parseMakeReferenceArgs(argv)).toThrow();
    }
    expect(parseWindow("980:1280")).toEqual({ startSec: 980, endSec: 1280 });
  });
});

describe("ASR response parsing", () => {
  it("reads whisper-1 verbose_json words and segments in ms", () => {
    const parsed = parseWhisperVerbose({ text: "駅から", duration: 1.25, words: [{ word: "駅", start: 0.5, end: 0.62 }, { word: "から", start: 0.62, end: 0.9 }], segments: [{ id: 0, text: "駅から", start: 0.5, end: 0.9 }] });
    expect(parsed.words).toEqual([{ text: "駅", startMs: 500, endMs: 620 }, { text: "から", startMs: 620, endMs: 900 }]);
    expect(parsed.segments).toEqual([{ text: "駅から", startMs: 500, endMs: 900 }]);
    expect(parsed.durationMs).toBe(1250);
  });

  it("reads diarized_json segments with speakers and skips empty ones", () => {
    const parsed = parseDiarized({ segments: [{ type: "transcript.text.segment", id: "seg_0", start: 0, end: 1.5, speaker: "A", text: "はい" }, { start: 2, end: 2.5, speaker: "B", text: " " }] });
    expect(parsed).toEqual([{ text: "はい", startMs: 0, endMs: 1500, speaker: "A" }]);
  });

  it("reads whisper.cpp JSON offsets", () => {
    const parsed = parseWhisperCpp({ transcription: [{ timestamps: { from: "00:00:00,000", to: "00:00:02,000" }, offsets: { from: 0, to: 2000 }, text: " 駅から" }] });
    expect(parsed).toEqual([{ text: "駅から", startMs: 0, endMs: 2000 }]);
  });

  it("reads a PCM16 WAV and skips unknown chunks", () => {
    const samples = 1600;
    const fmt = Buffer.alloc(24);
    fmt.write("fmt ", 0, "ascii");
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(16_000, 12);
    fmt.writeUInt32LE(32_000, 16);
    fmt.writeUInt16LE(2, 20);
    fmt.writeUInt16LE(16, 22);
    const list = Buffer.concat([Buffer.from("LIST", "ascii"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc\0", "ascii")]);
    const dataHeader = Buffer.alloc(8);
    dataHeader.write("data", 0, "ascii");
    dataHeader.writeUInt32LE(samples * 2, 4);
    const data = Buffer.alloc(samples * 2);
    data.writeInt16LE(1234, 0);
    const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, list, dataHeader, data]);
    const riff = Buffer.alloc(8);
    riff.write("RIFF", 0, "ascii");
    riff.writeUInt32LE(body.length, 4);
    const wav = readWavPcm16(Buffer.concat([riff, body]));
    expect(wav).toMatchObject({ sampleRate: 16_000, channels: 1, durationMs: 100 });
    expect(wav.samples.length).toBe(samples);
    expect(wav.samples[0]).toBe(1234);
    expect(() => readWavPcm16(Buffer.from("not a wav file"))).toThrow();
  });
});

describe("draft prompt and parsing", () => {
  it("marks long pauses with a new line and short pauses with ｜", () => {
    const ws: TimedUnit[] = [
      { text: "駅", startMs: 0, endMs: 200 },
      { text: "から", startMs: 200, endMs: 500 },
      { text: "歩いて", startMs: 900, endMs: 1300 },
      { text: "10分", startMs: 2000, endMs: 2400 },
    ];
    expect(formatWhisperWords(ws)).toBe("[0.0–1.3] 駅から｜歩いて\n[2.0–2.4] 10分");
  });

  it("describes D as a Gemini transcript only when transcriptKind is gemini", () => {
    const excerpt = { utterances: [{ index: 0, line: 1, timeSec: 0, speaker: "話者1", text: "テスト", bundled: false, clippedHead: false, clippedTail: false }], candidates: 1, bundledIncluded: 0, coverage: 1 } as never;
    const base = { durationMs: 30_000, whisperWords: [], diarized: [], whisperCpp: null, transcript: excerpt, speakerLabels: ["話者1"] };
    const human = String(buildDraftRequest(base, "gpt-5.4", "medium")["instructions"]);
    const gemini = String(buildDraftRequest({ ...base, transcriptKind: "gemini" }, "gpt-5.4", "medium")["instructions"]);
    expect(human).toContain("人手未校正");
    expect(human).not.toContain("Gemini");
    expect(gemini).toContain("Gemini");
    expect(gemini).not.toContain("人手未校正");
  });

  it("asks for structured output without any time fields and with the speaker labels as an enum", () => {
    const request = buildDraftRequest({ durationMs: 30_000, whisperWords: [], diarized: [], whisperCpp: null, transcript: null, speakerLabels: ["話者0", "話者1"] }, "gpt-5.4", "medium");
    expect(request["store"]).toBe(false);
    const format = (request["text"] as { format: { type: string; strict: boolean; schema: unknown } }).format;
    expect(format).toMatchObject({ type: "json_schema", strict: true });
    const serialized = JSON.stringify(format.schema);
    expect(serialized).not.toMatch(/startMs|endMs|"start"|"end"/);
    expect(serialized).toContain('"enum":["話者0","話者1"]');
    expect(serialized).toContain('"place"');
    expect(JSON.stringify(draftSchema([]))).toContain('"speaker":{"type":"string"}');
  });

  it("validates the LLM output", () => {
    const ok = parseDraftSegments({
      segments: [{ speaker: "話者0", text: " 駅から歩いて10分です。 ", kind: "statement", facts: [{ type: "time", text: "10分", note: null }], uncertain: false, uncertainReason: null, discrepancies: [{ category: "number", support: ["A", "B", "A"], rivalSupport: 1, detail: "A:10分 / B:10分 / D:15分" }] }],
      notes: null,
    });
    expect(ok[0]).toMatchObject({ text: "駅から歩いて10分です。", facts: [{ type: "time", text: "10分", note: null }], discrepancies: [{ category: "number", support: ["A", "B"], rivalSupport: 1 }] });
    expect(isUnresolved(ok[0]!.discrepancies[0]!)).toBe(false);
    expect(isUnresolved({ category: "content_word", support: ["D"], rivalSupport: 1, detail: "" })).toBe(true);
    expect(isUnresolved({ category: "content_word", support: ["A", "D"], rivalSupport: 2, detail: "" })).toBe(true);
    expect(isUnresolved({ category: "content_word", support: [], rivalSupport: 0, detail: "" })).toBe(true);
    expect(() => parseDraftSegments({ segments: [{ speaker: "話者0", text: "x", kind: "statement", facts: [], discrepancies: [{ category: "number", support: ["E"], rivalSupport: 1, detail: "" }] }] })).toThrow();
    expect(() => parseDraftSegments({ segments: [{ speaker: "話者0", text: "x", kind: "monologue", facts: [] }] })).toThrow();
    expect(() => parseDraftSegments({ segments: [{ speaker: "話者0", text: "x", kind: "statement", facts: [{ type: "date", text: "x", note: null }] }] })).toThrow();
    expect(() => parseDraftSegments({ notes: null })).toThrow();
  });

  it("redacts secrets from error text", () => {
    expect(redactSecrets("Incorrect API key provided: sk-proj-abc*****wxyz.")).toBe("Incorrect API key provided: sk-***.");
    expect(redactSecrets("Authorization: Bearer abc.def")).toBe("Authorization: Bearer ***");
  });
});

describe("building the reference document", () => {
  // whisper-1: 相づち「そうなんですね」を落としている。長い文（16.2 秒）は読点で分けられる。
  const whisperWords = [
    ...words("駅から歩いて10分くらいです。", 100, 0),
    ...words("家賃は月に8万円でした。", 100, 2200),
    ...words("週末は海の近くを散歩して、朝早く起きて犬と一緒に歩きます。", 600, 4000),
  ];
  const diarized: TimedUnit[] = [
    { text: "駅から歩いて10分くらいです。", startMs: 0, endMs: 1400, speaker: "A" },
    { text: "そうなんですね。", startMs: 1500, endMs: 2100, speaker: "B" },
    { text: "家賃は月に8万円でした。", startMs: 2200, endMs: 3300, speaker: "A" },
    { text: "週末は海の近くを散歩して、朝早く起きて犬と一緒に歩きます。", startMs: 4000, endMs: 20_200, speaker: "A" },
  ];
  const segments: DraftSegment[] = [
    draft({ text: "駅から歩いて10分くらいです。", facts: [{ type: "time", text: "10分", note: null }, { type: "negation", text: "ありません", note: null }] }),
    draft({ text: "そうなんですね。", speaker: "話者1", kind: "backchannel" }),
    draft({ text: "家賃は月に8万円でした。", facts: [{ type: "amount", text: "８万円", note: "家賃" }] }),
    draft({ text: "週末は海の近くを散歩して、朝早く起きて犬と一緒に歩きます。", facts: [{ type: "time", text: "週末", note: null }, { type: "time", text: "朝早く", note: null }] }),
    draft({ text: "まったく別の話です。" }),
  ];
  const result = buildReference({
    sourceId: "synthetic",
    windowStartSec: 0,
    windowEndSec: 22,
    draft: segments,
    whisperWords,
    diarized,
    whisperCpp: null,
    transcript: null,
    envelope: null,
    provenance: { asr: "synthetic", proofread: "synthetic" },
  });

  it("times each segment from whisper-1 words and splits a segment longer than 15 s", () => {
    expect(result.doc.segments.map(s => [s.id, s.startMs, s.endMs, s.kind, s.uncertain === true])).toEqual([
      ["s001", 0, 1400, "statement", false],
      ["s002", 1500, 2100, "backchannel", true],
      ["s003", 2200, 3300, "statement", false],
      ["s004", 4000, 11_200, "statement", false],
      ["s005", 11_200, 20_200, "statement", false],
      ["s006", 20_200, 22_000, "statement", true],
    ]);
    expect(result.reports.map(r => r.timing)).toEqual(["exact", "fallback-B", "exact", "exact", "exact", "interpolated"]);
    expect(result.reports.map(r => r.splitPart)).toEqual([null, null, null, 0, 1, null]);
    expect(result.doc.segments.map(s => s.text).slice(3, 5)).toEqual(["週末は海の近くを散歩して、", "朝早く起きて犬と一緒に歩きます。"]);
    expect(checkReference(result.doc).filter(v => !v.tolerated)).toEqual([]);
  });

  it("keeps facts in the text's own spelling and drops facts not in the text", () => {
    expect(result.doc.segments[0]!.facts).toEqual([{ type: "time", text: "10分" }]);
    expect(result.reports[0]!.droppedFacts).toEqual(["negation:ありません"]);
    expect(result.doc.segments[2]!.facts).toEqual([{ type: "amount", text: "8万円", note: "家賃" }]);
    expect(result.doc.segments[3]!.facts).toEqual([{ type: "time", text: "週末" }]);
    expect(result.doc.segments[4]!.facts).toEqual([{ type: "time", text: "朝早く" }]);
  });

  it("explains why segments are uncertain and maps diarize speakers", () => {
    expect(result.reports[1]!.reasons.join(" ")).toContain("fallback-B");
    expect(result.reports[5]!.reasons.join(" ")).toMatch(/interpolated.*weakly supported/);
    expect(result.speakerMap).toEqual({ A: "話者0", B: "話者1" });
    expect(result.reports[0]!.coverage).toEqual({ A: 1, B: 1, C: null, D: null });
    expect(result.reports[0]!.spans.A).toBe("駅から歩いて10分くらいです");
    expect(result.uncovered).toEqual([]);
  });

  it("produces text-free stats", () => {
    const stats = referenceStats(result.doc);
    expect(stats).toMatchObject({ segments: 6, uncertain: 2, kinds: { statement: 5, backchannel: 1, question: 0, fragment: 0 } });
    expect(stats.facts).toMatchObject({ time: 3, amount: 1, negation: 0 });
    expect(JSON.stringify(stats)).not.toMatch(/駅|家賃|週末/);
  });
});

describe("splitting long segments at clause boundaries", () => {
  const build = (text: string, msPerChar: number) =>
    buildReference({
      sourceId: "synthetic",
      windowStartSec: 0,
      windowEndSec: 60,
      draft: [draft({ text })],
      whisperWords: words(text, msPerChar, 0),
      diarized: null,
      whisperCpp: null,
      transcript: null,
      envelope: null,
      provenance: { asr: "synthetic", proofread: "synthetic" },
    }).doc.segments.map(s => s.text);

  it("splits a segment over 12 s after a predicate or conjunctive particle, not after a noun list comma", () => {
    // 22 文字 × 600 ms = 13.2 秒。「海と山、」の読点は名詞の並びなので使わない。
    expect(build("週末は海と山、両方に行って、朝早く起きて歩きます。", 600)).toEqual(["週末は海と山、両方に行って、", "朝早く起きて歩きます。"]);
  });

  it("keeps a 12–15 s segment whole when only non-clause commas exist, but splits over 15 s", () => {
    // 24 文字 × 600 ms = 14.4 秒
    expect(build("海と山と川と湖、森と駅と港と町の景色の写真を撮ります。", 600)).toHaveLength(1);
    // 30 文字 × 600 ms = 18 秒
    expect(build("海と山と川と湖、森と駅と港と町と畑と村と城の景色の写真を撮ります。", 600)).toEqual(["海と山と川と湖、", "森と駅と港と町と畑と村と城の景色の写真を撮ります。"]);
  });
});

describe("speaker and fact consistency", () => {
  it("maps diarize labels one-to-one onto transcript labels by overlap", () => {
    const segments = [
      { startMs: 0, endMs: 9000, speaker: "話者0" },
      { startMs: 9000, endMs: 11_000, speaker: "話者1" },
      { startMs: 11_000, endMs: 20_000, speaker: "話者0" },
      { startMs: 20_000, endMs: 22_000, speaker: "話者1" },
    ];
    // diarize は話者 0 の 2 文目の一部を B にしているが、1 対 1 なら A→話者0, B→話者1
    const diarized: TimedUnit[] = [
      { text: "x", startMs: 0, endMs: 9000, speaker: "A" },
      { text: "x", startMs: 9000, endMs: 15_000, speaker: "B" },
      { text: "x", startMs: 15_000, endMs: 20_000, speaker: "A" },
      { text: "x", startMs: 20_000, endMs: 22_000, speaker: "B" },
    ];
    const mapped = mapSpeakers(segments, diarized);
    expect(mapped.map).toEqual({ A: "話者0", B: "話者1" });
    // 3 区間目は A と 5 秒・B と 4 秒重なる → 半分以上の A
    expect(mapped.perSegment).toEqual(["話者0", "話者1", "話者0", "話者1"]);
    expect(mapSpeakers(segments, []).perSegment).toEqual([null, null, null, null]);
  });

  it("types a name as place everywhere once it is a place anywhere in the window", () => {
    const base = { speaker: "話者0", kind: "statement" as const };
    const out = harmonizePlaceFacts(
      [
        { ...base, id: "s001", startMs: 0, endMs: 1000, text: "アメリカに行きました。", facts: [{ type: "proper_noun", text: "アメリカ" }] },
        { ...base, id: "s002", startMs: 1000, endMs: 2000, text: "アメリカと逗子に住みました。", facts: [{ type: "place", text: "アメリカ" }, { type: "proper_noun", text: "逗子" }, { type: "proper_noun", text: "山田さん" }] },
      ],
      ["逗子"],
    );
    expect(out[0]!.facts).toEqual([{ type: "place", text: "アメリカ" }]);
    expect(out[1]!.facts).toEqual([{ type: "place", text: "アメリカ" }, { type: "place", text: "逗子" }, { type: "proper_noun", text: "山田さん" }]);
  });

  it("marks a segment uncertain when the adopted reading is not settled by the sources", () => {
    const result = buildReference({
      sourceId: "synthetic",
      windowStartSec: 0,
      windowEndSec: 10,
      draft: [draft({ text: "駅から歩いて10分です。", discrepancies: [{ category: "number", support: ["D"], rivalSupport: 2, detail: "A:15分 / C:15分 / D:10分" }] })],
      whisperWords: words("駅から歩いて15分です。", 100, 0),
      diarized: null,
      whisperCpp: null,
      transcript: null,
      envelope: null,
      provenance: { asr: "synthetic", proofread: "synthetic" },
    });
    expect(result.doc.segments[0]!.uncertain).toBe(true);
    expect(result.reports[0]!.reasons.join(" ")).toContain("number not settled");
  });

  it("lets a recorded review decision settle or keep the text uncertainty, but not timing problems", () => {
    const run = (review: DraftSegment["review"], spoken: string) =>
      buildReference({
        sourceId: "synthetic",
        windowStartSec: 0,
        windowEndSec: 10,
        draft: [draft({ text: "駅から歩いて10分です。", uncertain: true, uncertainReason: "10/15", ...(review !== undefined ? { review } : {}) })],
        whisperWords: words(spoken, 100, 0),
        diarized: null,
        whisperCpp: null,
        transcript: null,
        envelope: null,
        provenance: { asr: "synthetic", proofread: "synthetic" },
      });
    const resolved = run({ decision: "resolved", note: "context" }, "駅から歩いて10分です。");
    expect(resolved.doc.segments[0]!.uncertain).toBeUndefined();
    expect(resolved.reports[0]!.reasons.join(" ")).toContain("review: resolved — context");
    expect(run({ decision: "uncertain", note: "inaudible" }, "駅から歩いて10分です。").doc.segments[0]!.uncertain).toBe(true);
    // whisper-1 に無い区間は、見直しで本文を確定しても時刻が按分なので uncertain のまま
    expect(run({ decision: "resolved", note: "context" }, "まったく別の音です。").doc.segments[0]!.uncertain).toBe(true);
    expect(() => parseDraftSegments({ segments: [{ speaker: "話者0", text: "x", kind: "statement", facts: [], review: { decision: "maybe", note: "x" } }] })).toThrow();
  });
});

describe("silence trimming at segment edges", () => {
  const envelope = (pattern: Array<[number, number]>): EnergyEnvelope => {
    const db: number[] = [];
    for (const [frames, level] of pattern) for (let i = 0; i < frames; i++) db.push(level);
    return { frameMs: 10, db: Float64Array.from(db), silentBelowDb: -60 };
  };

  it("moves edges inward over clear silence only", () => {
    const env = envelope([[50, -80], [100, -20], [50, -80]]);
    expect(trimToVoiced(0, 2000, env)).toEqual({ startMs: 460, endMs: 1540, trimmedStartMs: 460, trimmedEndMs: 460, longSilenceAtStart: false, longSilenceAtEnd: false, allSilent: false });
    expect(trimToVoiced(600, 1400, env)).toMatchObject({ startMs: 600, endMs: 1400, trimmedStartMs: 0, trimmedEndMs: 0 });
  });

  it("does not trim beyond the limit, below the minimum length, or an all-silent segment", () => {
    const env = envelope([[400, -80], [50, -20]]);
    expect(trimToVoiced(0, 4500, env)).toMatchObject({ startMs: 0, trimmedStartMs: 0, longSilenceAtStart: true });
    expect(trimToVoiced(2000, 4500, env)).toMatchObject({ startMs: 3960, trimmedStartMs: 1960, longSilenceAtStart: false });
    expect(trimToVoiced(3700, 4100, env)).toMatchObject({ startMs: 3700, endMs: 4100, trimmedStartMs: 0 });
    expect(trimToVoiced(1000, 2000, env)).toMatchObject({ startMs: 1000, endMs: 2000, trimmedStartMs: 0, trimmedEndMs: 0, allSilent: true });
  });

  it("derives the silence threshold from the noise floor", () => {
    const samples = new Int16Array(16_000);
    for (let i = 8000; i < 16_000; i++) samples[i] = Math.round(8000 * Math.sin(i / 5));
    const env = energyEnvelope(samples, 16_000);
    expect(env.db.length).toBe(100);
    expect(env.db[10]!).toBeLessThan(env.silentBelowDb);
    expect(env.db[90]!).toBeGreaterThan(env.silentBelowDb);
    expect(trimToVoiced(0, 1000, env).startMs).toBe(460);
  });
});
