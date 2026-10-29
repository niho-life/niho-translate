/**
 * LLM 判定のプロンプト・入力・JSON schema・応答検証。
 * 時刻は LLM に出させない。LLM は英単語の index だけを選び、ms はコードが引く。
 */
import type { FactVerdict, JudgeFlag, ReferenceSegment } from "../engine.ts";
import { FACT_VERDICTS, JUDGE_FLAGS } from "./metrics.ts";
import type { BatchPlan, EnSentence, OutputWord, RawSegmentJudgement } from "./types.ts";

export const DEFAULT_PROMPT_VERSION = "v2";
export const CONTEXT_SEGMENTS = 3;
/** 対象区間の開始より前に見せる英語（正解原稿の時刻誤差ぶん）。 */
export const WINDOW_BEFORE_MS = 2_000;
/** 対象区間の終了より後に見せる英語の最小幅。 */
export const WINDOW_AFTER_MS = 25_000;

const JUDGE_INSTRUCTIONS_V1 = `You evaluate Japanese→English simultaneous interpretation for a research benchmark. Be strict and literal.

INPUT
- Reference segments: the Japanese source, split into meaning units. Each has an id, kind (statement / question / backchannel / fragment), start–end time in ms, the Japanese text, and numbered facts written as in the source. Fact types: number (counts, durations), time (times, dates), amount (money), negation, place (place names), proper_noun (other names), condition, subject, tense.
  Segments marked JUDGE must be judged. Segments marked CONTEXT are neighbours shown only for context: never judge them, but English words that translate a CONTEXT segment belong to it and must not be assigned to a JUDGE segment.
- English words: automatic speech recognition (ASR) of the interpreter's English output audio, on the SAME clock as the Japanese (ms from the start). Each line is "[word index] start_ms word". Lines are grouped into sentences by punctuation and pauses. The ASR may misspell names or numbers it heard (e.g. "Kamakra" for Kamakura); judge what a listener would understand, not the spelling.

ALIGNMENT (for each JUDGE segment)
- aligned = true if some English words convey this segment's meaning (fully or partly). If nothing in the English conveys it, aligned = false and both word indices are null.
- enStartWordIdx = the index of the FIRST English word that carries this segment's meaning. Do not count fillers or lead-in sounds ("Well,", "Um", "So,", "Okay,", "Yeah"), acknowledgements, or words that still belong to the previous segment's translation.
  Example: for 「我が社は今年で5周年になります」 rendered as "Our company is celebrating its fifth anniversary", the first word is "Our".
  Example: in "...this year. Tomorrow's viewing will not be held", the segment about the viewing starts at "Tomorrow's".
  If one English sentence covers two segments, the second segment starts in the middle of that sentence, at the first word of its own meaning.
- enEndWordIdx = the index of the LAST English word that carries this segment's meaning (exclude trailing fillers and words of the next segment).
- Causality: an interpreter cannot translate what has not been said yet. English words that start well before the segment's start time are not its translation (allow about 1 s for timing error). A translation normally starts 1–10 s after the segment starts, and can be much later when the output audio is queued; use meaning and order, not distance alone.
- Choose the rendering that is actually this segment's translation. If the same content was rendered twice, align to the FIRST rendering and add the flag repeat.
- An English word should belong to at most one JUDGE segment.

MEANING (0–3), judged only from the aligned English words
- 3 = the meaning of the Japanese is conveyed (paraphrase is fine).
- 2 = slight omission or unnatural wording, but every fact is correct.
- 1 = an important part is missing or wrong. Any wrong number, amount, time, date, negation (polarity), condition, subject or place name caps the score at 1.
- 0 = mistranslation, no translation, or fabricated content.
- aligned = false → meaning 0.

FACTS: return one verdict per listed fact index of the segment.
- ok = preserved (equivalent renderings are fine: 3,000万円 = 30 million yen; 2年半 = two and a half years; 午後3時 = 3 p.m.).
- wrong = rendered with a different value, polarity, subject, condition, time, place or name (e.g. 2年半 → "three and a half years"; 開催しません → "will be held"; 鎌倉 → "Kyoto"). A place fact is also wrong when the English names another place or invents one; a usual romanization or English name of the same place is ok (逗子 = Zushi).
- omitted = not rendered.
- unclear = cannot be decided (e.g. the English is garbled).
- aligned = false → every fact is omitted.

FLAGS (zero or more per JUDGE segment)
- omission: the segment's content, or a substantial part of it, is absent from the English. Do not use omission for backchannel or fragment segments (interpreters may skip them).
- hallucination: the English adds facts, details or responses that are not in the source. Put it on the segment whose English contains the addition.
- answered_question: the interpreter answered the speaker, replied to them, or spoke as itself instead of interpreting.
- repeat: the same content was rendered more than once.
- wrong_language: the output is not in English.
- garbled: the English is broken or unintelligible.

KINDS
- backchannel (e.g. はい, うん): a short acknowledgement such as "Yes." or "Right." is correct; skipping it is acceptable.
- question: the English must still be a question addressed to the listener; answering it is answered_question.
- fragment: a restart or unfinished phrase; judge only what it says.
- A reference segment marked "reference uncertain" may itself contain recognition errors; be lenient where the reference is doubtful.

NOTE: one short sentence in Japanese (at most 80 characters) explaining the score and any flags.

Return exactly one item per JUDGE segment, in the given order, using the given ids.`;

const JUDGE_INSTRUCTIONS_V2 = JUDGE_INSTRUCTIONS_V1
  .replace("place (place names), proper_noun", "place (place names), legal_right (property ownership or leasehold rights), proper_noun")
  .replace("condition, subject or place name caps the score at 1", "condition, subject, legal right or place name caps the score at 1")
  .replace("different value, polarity, subject, condition, time, place or name", "different value, polarity, subject, condition, time, place, legal right or name")
  .replace('鎌倉 → "Kyoto"). A place fact', '鎌倉 → "Kyoto"; 所有権 → "for sale"). A place fact')
  .replace("(逗子 = Zushi).", "(逗子 = Zushi). Freehold ownership and leasehold are distinct legal rights.");
const PROMPTS: Readonly<Record<string, string>> = { v1: JUDGE_INSTRUCTIONS_V1, v2: JUDGE_INSTRUCTIONS_V2 };

export function judgeInstructions(version: string): string {
  const text = PROMPTS[version];
  if (!text) throw new Error(`unknown prompt version: ${version} (known: ${Object.keys(PROMPTS).join(", ")})`);
  return text;
}

/** 二分探索: startMs >= ms となる最初の語 index。 */
function lowerBound(words: ReadonlyArray<OutputWord>, ms: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((words[mid]?.startMs ?? Infinity) < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 区間を batchSize ずつに分け、前後 CONTEXT_SEGMENTS 区間の文脈と、
 * 対象の開始 −beforeMs 〜 終了 +afterMs に始まる英単語の範囲を決める。
 */
export function planBatches(
  segments: ReadonlyArray<ReferenceSegment>,
  words: ReadonlyArray<OutputWord>,
  options: { readonly batchSize: number; readonly beforeMs?: number; readonly afterMs?: number; readonly contextSize?: number },
): BatchPlan[] {
  const beforeMs = options.beforeMs ?? WINDOW_BEFORE_MS;
  const afterMs = options.afterMs ?? WINDOW_AFTER_MS;
  const context = options.contextSize ?? CONTEXT_SEGMENTS;
  const size = Math.max(1, Math.floor(options.batchSize));
  const plans: BatchPlan[] = [];
  for (let from = 0; from < segments.length; from += size) {
    const targets = segments.slice(from, from + size);
    const windowStartMs = Math.min(...targets.map((s) => s.startMs)) - beforeMs;
    const windowEndMs = Math.max(...targets.map((s) => s.endMs)) + afterMs;
    plans.push({
      index: plans.length,
      targets,
      before: segments.slice(Math.max(0, from - context), from),
      after: segments.slice(from + size, from + size + context),
      windowStartMs,
      windowEndMs,
      wordLo: lowerBound(words, windowStartMs),
      wordHi: lowerBound(words, windowEndMs + 1) - 1,
    });
  }
  return plans;
}

function segmentBlock(seg: ReferenceSegment, role: "JUDGE" | "CONTEXT"): string {
  const head = `${role} id=${seg.id} kind=${seg.kind} speaker=${seg.speaker} ${seg.startMs}–${seg.endMs} ms${seg.uncertain ? " (reference uncertain)" : ""}`;
  const lines = [head, `JA: ${seg.text}`];
  if (role === "JUDGE") {
    lines.push(
      seg.facts.length > 0
        ? `facts: ${seg.facts.map((f, i) => `[${i}] ${f.type}: ${f.text}`).join(" | ")}`
        : "facts: (none)",
    );
  }
  return lines.join("\n");
}

/** LLM への入力本文（private）。 */
export function buildBatchInput(plan: BatchPlan, words: ReadonlyArray<OutputWord>, sentences: ReadonlyArray<EnSentence>): string {
  const out: string[] = ["# Reference segments (chronological)"];
  for (const s of plan.before) out.push(segmentBlock(s, "CONTEXT"));
  for (const s of plan.targets) out.push(segmentBlock(s, "JUDGE"));
  for (const s of plan.after) out.push(segmentBlock(s, "CONTEXT"));
  out.push(
    "",
    `# English words from ${plan.windowStartMs} ms to ${plan.windowEndMs} ms`,
    "Format: [word index] start_ms word",
  );
  if (plan.wordLo > plan.wordHi) {
    out.push("(no English words in this time range)");
  } else {
    for (const s of sentences) {
      if (s.wordEnd < plan.wordLo || s.wordStart > plan.wordHi) continue;
      const a = Math.max(s.wordStart, plan.wordLo);
      const b = Math.min(s.wordEnd, plan.wordHi);
      const cut = a > s.wordStart || b < s.wordEnd ? " (cut at the range edge)" : "";
      out.push(`sentence ${s.index}: ${s.startMs}–${s.endMs} ms${cut}`);
      for (let i = a; i <= b; i += 1) {
        const w = words[i];
        if (w) out.push(`[${i}] ${w.startMs} ${w.text}`);
      }
    }
  }
  out.push("", `Judge these ids in order: ${plan.targets.map((s) => s.id).join(", ")}`);
  return out.join("\n");
}

/** Responses API の strict JSON schema。id は対象区間の enum に絞る。 */
export function responseSchema(targetIds: ReadonlyArray<string>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["segments"],
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "aligned", "enStartWordIdx", "enEndWordIdx", "meaning", "facts", "flags", "note"],
          properties: {
            id: { type: "string", enum: [...targetIds] },
            aligned: { type: "boolean" },
            enStartWordIdx: { type: ["integer", "null"] },
            enEndWordIdx: { type: ["integer", "null"] },
            meaning: { type: "integer", enum: [0, 1, 2, 3] },
            facts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["index", "verdict"],
                properties: {
                  index: { type: "integer" },
                  verdict: { type: "string", enum: [...FACT_VERDICTS] },
                },
              },
            },
            flags: { type: "array", items: { type: "string", enum: [...JUDGE_FLAGS] } },
            note: { type: "string" },
          },
        },
      },
    },
  };
}

/**
 * agy 用の schema。Gemini の関数宣言は整数の enum と type の配列（["integer","null"]）を受け付けない
 * （INVALID_ARGUMENT）ので、meaning は整数（0〜3 はコードで丸める）、語 index は整数で「無し」は -1 にする。
 */
export function portableResponseSchema(targetIds: ReadonlyArray<string>): Record<string, unknown> {
  const schema = responseSchema(targetIds) as {
    properties: { segments: { items: { properties: Record<string, unknown> } } };
  };
  const item = schema.properties.segments.items.properties;
  item.meaning = { type: "integer", description: "0, 1, 2 or 3" };
  item.enStartWordIdx = { type: "integer", description: "word index, or -1 when not aligned" };
  item.enEndWordIdx = { type: "integer", description: "word index, or -1 when not aligned" };
  return schema as unknown as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 負の値（agy 用 schema の -1）は「無し」。 */
function indexOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 応答を検証し、使える判定と問題点を返す。範囲外の語 index は null にして問題として記録する
 * （呼び出し側が 1 回だけ再試行する）。
 */
export function validateBatchResponse(
  value: unknown,
  plan: BatchPlan,
): { judgements: Map<string, RawSegmentJudgement>; problems: string[] } {
  const problems: string[] = [];
  const judgements = new Map<string, RawSegmentJudgement>();
  const items = isRecord(value) && Array.isArray(value.segments) ? value.segments : null;
  if (!items) return { judgements, problems: ["response has no segments array"] };
  const targets = new Map(plan.targets.map((s) => [s.id, s]));
  const inRange = (i: number | null): boolean => i === null || (i >= plan.wordLo && i <= plan.wordHi);
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string") {
      problems.push("an item has no id");
      continue;
    }
    const ref = targets.get(item.id);
    if (!ref) {
      problems.push(`id ${item.id} is not a JUDGE segment`);
      continue;
    }
    if (judgements.has(item.id)) {
      problems.push(`id ${item.id} appears twice`);
      continue;
    }
    let start = indexOrNull(item.enStartWordIdx);
    let end = indexOrNull(item.enEndWordIdx);
    const aligned = item.aligned === true;
    if (aligned && (!inRange(start) || !inRange(end) || (start === null && end === null))) {
      problems.push(`id ${item.id}: word indices must be within [${plan.wordLo}, ${plan.wordHi}] when aligned`);
      if (!inRange(start)) start = null;
      if (!inRange(end)) end = null;
    }
    if (aligned && start !== null && end !== null && start > end) {
      problems.push(`id ${item.id}: enStartWordIdx is after enEndWordIdx`);
    }
    const facts: { index: number; verdict: FactVerdict }[] = [];
    if (Array.isArray(item.facts)) {
      for (const f of item.facts) {
        if (!isRecord(f)) continue;
        const index = indexOrNull(f.index);
        const verdict = FACT_VERDICTS.find((v) => v === f.verdict);
        if (index === null || index < 0 || index >= ref.facts.length || !verdict) continue;
        if (!facts.some((x) => x.index === index)) facts.push({ index, verdict });
      }
    }
    if (aligned && facts.length < ref.facts.length) problems.push(`id ${item.id}: verdicts missing for some facts`);
    const flags = Array.isArray(item.flags) ? item.flags.filter((f): f is JudgeFlag => JUDGE_FLAGS.includes(f as JudgeFlag)) : [];
    const meaningRaw = typeof item.meaning === "number" ? Math.round(item.meaning) : 0;
    judgements.set(item.id, {
      id: item.id,
      aligned,
      enStartWordIdx: aligned ? start : null,
      enEndWordIdx: aligned ? end : null,
      meaning: Math.min(3, Math.max(0, meaningRaw)) as 0 | 1 | 2 | 3,
      facts,
      flags,
      note: typeof item.note === "string" ? item.note.slice(0, 300) : "",
    });
  }
  for (const id of targets.keys()) if (!judgements.has(id)) problems.push(`id ${id} is missing`);
  return { judgements, problems };
}
