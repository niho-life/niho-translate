/**
 * LLM（Responses API、JSON schema の構造化出力）で区間の本文・種別・facts の下書きを作る。
 * 時刻は LLM に決めさせない（出力 schema に時刻が無い）。時刻は build.ts がコードで決める。
 */
import type { FactType, ReferenceSegment } from "../engine.ts";
import type { TimedUnit } from "./align.ts";
import type { TranscriptExcerpt } from "./transcript.ts";
import { FACT_TYPES, SEGMENT_KINDS } from "./validate.ts";

export const PROMPT_VERSION = "reference-draft-v3";

export type SourceKey = "A" | "B" | "C" | "D";
export const SOURCE_KEYS: readonly SourceKey[] = ["A", "B", "C", "D"];
export type DiscrepancyCategory = "proper_noun" | "number" | "content_word" | "omission" | "negation" | "speaker" | "other";
export const DISCREPANCY_CATEGORIES: readonly DiscrepancyCategory[] = ["proper_noun", "number", "content_word", "omission", "negation", "speaker", "other"];

export interface DraftFact {
  readonly type: FactType;
  readonly text: string;
  readonly note: string | null;
}

export interface Discrepancy {
  readonly category: DiscrepancyCategory;
  /** 本文に採った読みと同じ読みの系統（推定で直したなら空）。 */
  readonly support: readonly SourceKey[];
  /** 採らなかった読みのうち、最も多くの系統がそろった読みの系統数（0〜4）。 */
  readonly rivalSupport: number;
  readonly detail: string;
}

/**
 * 系統間で割れた箇所を、採った読みの支持で機械的に判定する。
 * 採った読みの系統が 1 つ以下、または対立する読みの系統数以上なら確定できない。
 */
export function isUnresolved(d: Discrepancy): boolean {
  return d.support.length < 2 || d.rivalSupport >= d.support.length;
}

/** 下書きを人（または担当 agent）が見直した判断。LLM・食い違いによる uncertain をこれで置き換える。 */
export interface DraftReview {
  readonly decision: "resolved" | "uncertain";
  readonly note: string;
}

export interface DraftSegment {
  readonly speaker: string;
  readonly text: string;
  readonly kind: ReferenceSegment["kind"];
  readonly facts: readonly DraftFact[];
  readonly uncertain: boolean;
  readonly uncertainReason: string | null;
  readonly discrepancies: readonly Discrepancy[];
  readonly review?: DraftReview;
}

export interface Draft {
  readonly version: 1;
  readonly sourceId: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly segments: readonly DraftSegment[];
  readonly notes: string | null;
  /** 人（または担当 agent）が下書きを直したときの記録。provenance に載る。 */
  readonly editedBy?: string;
}

export interface DraftInput {
  readonly durationMs: number;
  readonly whisperWords: readonly TimedUnit[];
  readonly diarized: readonly TimedUnit[] | null;
  readonly whisperCpp: readonly TimedUnit[] | null;
  readonly transcript: TranscriptExcerpt | null;
  readonly speakerLabels: readonly string[];
}

const sec = (ms: number): string => (ms / 1000).toFixed(1);

/**
 * whisper-1 の語を、0.6 秒以上の無音か 8 秒ごとに改行した行にする。
 * 行頭に [開始–終了]（秒）、行内の 0.3 秒以上の無音に「｜」。
 */
export function formatWhisperWords(words: readonly TimedUnit[]): string {
  const lines: string[] = [];
  let line = "";
  let lineStart = 0;
  let lineEnd = 0;
  let prevEnd: number | null = null;
  const flush = (): void => {
    if (line.trim().length > 0) lines.push(`[${sec(lineStart)}–${sec(lineEnd)}] ${line.trim()}`);
    line = "";
  };
  for (const w of words) {
    const gap = prevEnd === null ? 0 : w.startMs - prevEnd;
    if (prevEnd === null || gap >= 600 || w.startMs - lineStart >= 8000) {
      flush();
      lineStart = w.startMs;
    } else if (gap >= 300) {
      line += "｜";
    }
    line += w.text;
    lineEnd = w.endMs;
    prevEnd = w.endMs;
  }
  flush();
  return lines.join("\n");
}

export function formatTimedSegments(units: readonly TimedUnit[]): string {
  return units
    .map(u => `[${sec(u.startMs)}–${sec(u.endMs)}${u.speaker !== undefined ? ` ${u.speaker}` : ""}] ${u.text.trim()}`)
    .join("\n");
}

export function formatTranscriptExcerpt(excerpt: TranscriptExcerpt): string {
  return excerpt.utterances
    .map(u => `${u.speaker}: ${u.clippedHead ? "…" : ""}${u.text.replace(/\s*\n\s*/g, " ")}${u.clippedTail ? "…" : ""}`)
    .join("\n");
}

export function buildInstructions(durationMs: number, speakerLabels: readonly string[], hasTranscript: boolean, hasWhisperCpp: boolean): string {
  const sources = [
    "- A: whisper-1。行頭の [開始–終了] は window 先頭からの秒。行内の「｜」は 0.3 秒以上の無音。",
    "- B: gpt-4o-transcribe-diarize。[開始–終了 話者] ごとの区間。話者ラベル（A/B…）は B の中だけで一貫。",
    hasWhisperCpp ? "- C: whisper.cpp large-v3-turbo。[開始–終了] ごとの区間。" : "- C: なし。",
    hasTranscript
      ? "- D: 録音に付属する発話転記（人手未校正。聞き違い・区切り・話者・固有名詞の誤りがあり得る。時刻は無く、window の前後に少しはみ出している。…は途中で切ったしるし）。"
      : "- D: なし。",
  ].join("\n");
  return `あなたは日本語音声の書き起こしを校正する担当です。同時通訳の評価に使う「正解原稿」を作ります。
入力は同じ音声区間（window、長さ ${sec(durationMs)} 秒）に対する複数の文字起こしです。
${sources}

## 作るもの
window の中で話されたすべての発話を、話された順の区間（segments）の列にする。window の外（D のはみ出し）は含めない。

## 本文（text）
- 系統を照合して、実際に話された日本語を復元する。多数決を基本に、文脈・日本語としての自然さ・固有名詞の一貫性で決める。
- D は無条件の正解にしない。A/B/C がそろって D と違えば A/B/C を採る。A/B/C のうち 2 系統以上にある語句は、D に無くても本文に入れる（D は語句や言いかけを省いていることがある）。D にしか無い読みは、A/B/C の音と矛盾しないときだけ採る。
- 言いよどみ・つなぎ語（えー、えーと、あのー、まあ、なんか、うーん など意味を持たないもの）は除く。それ以外は話された語順・語尾・敬語のまま書く。要約・言い換え・補完をしない。
- 言い直しは言い直した後の形を本文にする。言い直す前の断片や言いかけでも、内容語を含むものは kind=fragment の区間として残す（つなぎ語だけのものは除く）。
- 聞き手の相づち（はい、うん、へえ など）も、いずれかの系統にあれば kind=backchannel の区間にする。
- 数は算用数字で書く（3年、2000万円、10分）。慣用的な語（一番、一人暮らし、一緒 など）は漢字のまま。
- 句読点（、。？）を付ける。
- window の先頭・末尾で切れた発話も、聞こえている部分だけを書く。
- どの系統にも無い語を作らない。

## 区間の切り方
- 区間 = 意味の確定する節または文。目安は 2〜12 秒（日本語でおよそ 12〜80 文字）。
- 長い文は述語（〜です。〜ました。）または接続助詞（〜て、〜けど、〜が、〜ので、〜から、〜し、〜たら、〜ば）の直後で切る。語の途中や、修飾語と被修飾語の間では切らない。
- 1 つの区間に 2 人の話者を混ぜない。話者が替わったら必ず区間を分ける。
- 区間は話し始めの順に並べる。聞き手の相づちが話し手の節の途中に入ったときは、その節の区間の直後に置く。

## kind
- statement: 内容のある陳述。
- question: 相手に答えを求める発話（〜ですか、〜でしょうか、語尾を上げた確認も含む）。
- backchannel: 内容を持たない短い応答・相づち（はい、うん、ええ、へえ、なるほど、そうですね、そうなんですね）。
- fragment: 言い直し前の断片・中断・window の端で切れて意味が確定しない断片。

## facts（訳で落としてはならない要素。区間の本文の部分文字列として、本文と同じ表記で書く）
- number: 数・回数・人数・順番・割合
- time: 日時・時刻・期間・年代・頻度（去年、10年前、毎週、30分）
- amount: 金額・価格・面積・距離など単位付きの量
- negation: 否定・不可能・禁止の述語（ありません、できない）
- place: 地名。国・都市・市町村・地域・駅・海岸・施設のある場所の名前（アメリカ、横浜、湘南 など）。同じ語は window の中で必ず同じ型にする。
- proper_noun: 地名以外の固有名詞（人名・会社名・組織名・サービス名・作品名）
- condition: 条件・仮定の節（〜だったら、〜の場合は、〜すれば）
- subject: 動作や判断の主体が明示されているときのその語（私、オーナーさんが、外国の方が）
- tense: 意味を左右する時制・相（〜ていました、これから〜する予定、もう〜した）
- note は必要なときだけ短く（何の数か など）。不要なら null。無ければ facts は空配列。

## speaker
${speakerLabels.join(" / ")} のどれか。${hasTranscript ? "D の話者ラベルの体系に合わせ、" : ""}B の話者の切り替わりと内容（質問か答えか）で決める。

## discrepancies
系統間の内容上の食い違いを区間ごとにすべて列挙する（表記ゆれ・かな漢字・句読点・つなぎ語の有無だけの違いは含めない）。無ければ空配列。
- category: proper_noun（地名を含む固有名詞）/ number（数・時刻・期間・金額）/ content_word / omission（ある系統だけ語句が欠ける・余る）/ negation / speaker / other
- support: 本文に採った読みと同じ読みをしている系統（A/B/C/D）。どの系統とも違う読みにしたなら空配列。
- rivalSupport: 採らなかった読みのうち、最も多くの系統がそろった読みの系統数（0〜4）。
- detail: 「A:… / B:… / C:… / D:…」の形で短く。

## uncertain
次のどちらかなら true にし、uncertainReason に「どの語が・どの系統で・何と何に割れたか」を短く書く。それ以外は false と null。
- その区間の discrepancies に、support が 1 系統以下、または rivalSupport が support の数以上のものがある。
- 音が聞き取れない・系統がそろって崩れているなど、本文を確定できない。`;
}

export function buildUserContent(input: DraftInput): string {
  const parts = [
    `# A. whisper-1\n${formatWhisperWords(input.whisperWords)}`,
    `# B. gpt-4o-transcribe-diarize\n${input.diarized !== null ? formatTimedSegments(input.diarized) : "（なし）"}`,
    `# C. whisper.cpp\n${input.whisperCpp !== null ? formatTimedSegments(input.whisperCpp) : "（なし）"}`,
    `# D. 発話転記\n${input.transcript !== null && input.transcript.utterances.length > 0 ? formatTranscriptExcerpt(input.transcript) : "（なし）"}`,
  ];
  return parts.join("\n\n");
}

const nullableString = { type: ["string", "null"] } as const;

export function draftSchema(speakerLabels: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["segments", "notes"],
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["speaker", "text", "kind", "facts", "uncertain", "uncertainReason", "discrepancies"],
          properties: {
            speaker: speakerLabels.length > 0 ? { type: "string", enum: [...speakerLabels] } : { type: "string" },
            text: { type: "string" },
            kind: { type: "string", enum: [...SEGMENT_KINDS] },
            facts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["type", "text", "note"],
                properties: { type: { type: "string", enum: [...FACT_TYPES] }, text: { type: "string" }, note: nullableString },
              },
            },
            uncertain: { type: "boolean" },
            uncertainReason: nullableString,
            discrepancies: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["category", "support", "rivalSupport", "detail"],
                properties: {
                  category: { type: "string", enum: [...DISCREPANCY_CATEGORIES] },
                  support: { type: "array", items: { type: "string", enum: [...SOURCE_KEYS] } },
                  rivalSupport: { type: "integer" },
                  detail: { type: "string" },
                },
              },
            },
          },
        },
      },
      notes: nullableString,
    },
  };
}

export function buildDraftRequest(input: DraftInput, model: string, reasoningEffort: string): Record<string, unknown> {
  return {
    model,
    store: false,
    reasoning: { effort: reasoningEffort },
    max_output_tokens: 48_000,
    instructions: buildInstructions(input.durationMs, input.speakerLabels, input.transcript !== null && input.transcript.utterances.length > 0, input.whisperCpp !== null),
    input: [{ role: "user", content: [{ type: "input_text", text: buildUserContent(input) }] }],
    text: { format: { type: "json_schema", name: "reference_segments", strict: true, schema: draftSchema(input.speakerLabels) } },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`draft: invalid ${what}`);
}

function nullable(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new Error(`draft: invalid ${what}`);
}

/** LLM の JSON（または保存した下書きの segments）を検証して DraftSegment[] にする。 */
export function parseDraftSegments(value: unknown): DraftSegment[] {
  const root = isRecord(value) ? value["segments"] : value;
  if (!Array.isArray(root)) throw new Error("draft: segments array expected");
  return root.map((raw, i) => {
    if (!isRecord(raw)) throw new Error(`draft: segment ${i} must be an object`);
    if (typeof raw["text"] !== "string") throw new Error(`draft: segment ${i} text`);
    if (typeof raw["speaker"] !== "string") throw new Error(`draft: segment ${i} speaker`);
    const speaker = raw["speaker"].trim();
    const facts = (Array.isArray(raw["facts"]) ? raw["facts"] : []).map((f, j): DraftFact => {
      if (!isRecord(f) || typeof f["text"] !== "string") throw new Error(`draft: segment ${i} fact ${j}`);
      return { type: oneOf(f["type"], FACT_TYPES, "fact type"), text: f["text"], note: nullable(f["note"], "fact note") };
    });
    const discrepancies = (Array.isArray(raw["discrepancies"]) ? raw["discrepancies"] : []).map((d, j): Discrepancy => {
      if (!isRecord(d) || typeof d["detail"] !== "string" || !Array.isArray(d["support"])) throw new Error(`draft: segment ${i} discrepancy ${j}`);
      const rival = d["rivalSupport"];
      if (typeof rival !== "number" || !Number.isInteger(rival) || rival < 0 || rival > 4) throw new Error(`draft: segment ${i} discrepancy ${j} rivalSupport`);
      return {
        category: oneOf(d["category"], DISCREPANCY_CATEGORIES, "discrepancy category"),
        support: [...new Set(d["support"].map(x => oneOf(x, SOURCE_KEYS, "discrepancy support")))],
        rivalSupport: rival,
        detail: d["detail"],
      };
    });
    const segment: DraftSegment = {
      speaker,
      text: raw["text"].trim(),
      kind: oneOf(raw["kind"], SEGMENT_KINDS, "kind"),
      facts,
      uncertain: raw["uncertain"] === true,
      uncertainReason: nullable(raw["uncertainReason"], "uncertainReason"),
      discrepancies,
    };
    const review = raw["review"];
    if (review === undefined || review === null) return segment;
    if (!isRecord(review) || typeof review["note"] !== "string" || review["note"].trim().length === 0) throw new Error(`draft: segment ${i} review`);
    return { ...segment, review: { decision: oneOf(review["decision"], ["resolved", "uncertain"] as const, "review decision"), note: review["note"].trim() } };
  });
}
