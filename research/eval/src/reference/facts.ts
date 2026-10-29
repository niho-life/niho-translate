/**
 * facts の専用パス。下書き（または見直した下書き）の最終本文と、下書きの facts（候補）を LLM に渡し、
 * 誤りを直し漏れを足した facts を区間ごとに返させる。結果は候補との和集合にする（パスが同じ語を
 * 別の型にしたときだけ候補を捨てる）。LLM の出力が回によって少なくても、候補の facts は失われない。
 * 本文・時刻は変えない。facts は本文の表記に合わせ、同じ型で一方が他方を含むなら長い方を残す。
 */
import type { FactType } from "../engine.ts";
import type { DraftFact, DraftSegment } from "./draft.ts";
import { locateInOriginal } from "./normalize.ts";
import { FACT_TYPES } from "./validate.ts";

export const FACTS_PROMPT_VERSION = "reference-facts-v4";

export function buildFactsInstructions(): string {
  return `あなたは同時通訳の評価に使う「fact」（訳で落としてはならない要素）を、日本語の区間の本文から抜き出す担当です。
各区間の本文から、次の型の要素を、本文の連続した部分文字列として本文と同じ表記で、漏れなく列挙してください。
- number: 数・回数・人数・順番・割合（3人、2回目、半分）
- time: 日時・時刻・期間・年代・頻度・時を表す語句（去年、10年前、毎週、30分、1週間以内、学生時代、今後）
- amount: 金額・価格・面積・距離など単位付きの量（2000万円、50平米）
- negation: 否定・不可能・禁止の述語（ありません、できない、わからない、なかった、だめ、無理）。「〜じゃないですか」の念押しや「〜ないですけど」の前置きのように否定の意味を持たないものは含めない。
- place: 地名（国・都市・市町村・地域・駅・海岸など。アメリカ、横浜、湘南）
- legal_right: 不動産の権利形態（所有権、賃借権、借地権など）。売買・賃貸という取引の説明とは区別する
- proper_noun: 地名以外の固有名詞（人名・会社名・組織名・制度やサービスの名前・作品名）
- condition: 条件・仮定の節（〜だったら、〜の場合は、〜すれば、〜としても）
- subject: 動作や判断の主体が明示されているときのその語句（私、オーナーさんが、外国籍の方が）
- tense: 意味を左右する時制・相（〜ていました、〜する予定、もう〜した、〜てきた）
規則:
- text は句読点を含めない最小の範囲。述語は活用語尾まで含める（わからない、できなかった）。
- 同じ区間で同じ語が何度出ても 1 回でよい。
- 該当が無ければ空配列。相づち（backchannel）は通常は空。
- note は何の数か・誰の動作かなど、必要なときだけ短く。不要なら null。
- 各区間の「候補」は下書きの facts。型の誤り（地名でない「海外」を place、一般名詞の「不動産会社」を proper_noun にした など）や本文に無いものは直すか捨て、漏れは足して、最終の facts を返す。
- 入力と同じ順・同じ id で、全区間を返す。`;
}

export function buildFactsUserContent(segments: ReadonlyArray<Pick<DraftSegment, "speaker" | "kind" | "text" | "facts">>): string {
  return segments
    .map((s, i) => `d${i} [${s.speaker} ${s.kind}] ${s.text}\n  候補: ${s.facts.length > 0 ? s.facts.map(f => `${f.type}:${f.text}`).join(" / ") : "なし"}`)
    .join("\n");
}

export function factsSchema(): Record<string, unknown> {
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
          required: ["id", "facts"],
          properties: {
            id: { type: "string" },
            facts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["type", "text", "note"],
                properties: { type: { type: "string", enum: [...FACT_TYPES] }, text: { type: "string" }, note: { type: ["string", "null"] } },
              },
            },
          },
        },
      },
    },
  };
}

export function buildFactsRequest(segments: ReadonlyArray<Pick<DraftSegment, "speaker" | "kind" | "text" | "facts">>, model: string, reasoningEffort: string): Record<string, unknown> {
  return {
    model,
    store: false,
    reasoning: { effort: reasoningEffort },
    max_output_tokens: 24_000,
    instructions: buildFactsInstructions(),
    input: [{ role: "user", content: [{ type: "input_text", text: buildFactsUserContent(segments) }] }],
    text: { format: { type: "json_schema", name: "reference_facts", strict: true, schema: factsSchema() } },
  };
}

/** facts パスの出力を区間ごとの配列にする。返ってこなかった区間は null（下書きの facts を使う）。 */
export function parseFactsOutput(value: unknown, count: number): Array<DraftFact[] | null> {
  const root = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["segments"] : undefined;
  if (!Array.isArray(root)) throw new Error("facts: segments array expected");
  const out: Array<DraftFact[] | null> = Array.from({ length: count }, () => null);
  for (const raw of root) {
    if (typeof raw !== "object" || raw === null) throw new Error("facts: segment object expected");
    const rec = raw as Record<string, unknown>;
    const m = typeof rec["id"] === "string" ? /^d(\d+)$/.exec(rec["id"]) : null;
    if (m === null) throw new Error("facts: invalid id");
    const index = Number(m[1]);
    if (index >= count) throw new Error("facts: id out of range");
    const facts = Array.isArray(rec["facts"]) ? rec["facts"] : [];
    out[index] = facts.map((f): DraftFact => {
      const fr = f as Record<string, unknown>;
      if (typeof fr["text"] !== "string" || typeof fr["type"] !== "string" || !(FACT_TYPES as readonly string[]).includes(fr["type"])) throw new Error("facts: invalid fact");
      return { type: fr["type"] as FactType, text: fr["text"], note: typeof fr["note"] === "string" ? fr["note"] : null };
    });
  }
  return out;
}

/**
 * 下書きの facts と facts パスの facts の和集合。本文に無いものは捨て、原文の表記に合わせ、
 * 同じ型で一方が他方を含むなら長い方を残す。note は先に来た方を残す。
 */
export function mergeFacts(text: string, ...lists: ReadonlyArray<readonly DraftFact[]>): DraftFact[] {
  const located: DraftFact[] = [];
  for (const list of lists) {
    for (const f of list) {
      const at = locateInOriginal(text, f.text.trim());
      if (at === null || at.trim().length === 0) continue;
      located.push({ ...f, text: at });
    }
  }
  const kept: DraftFact[] = [];
  for (const f of located) {
    const same = kept.findIndex(k => k.type === f.type && (k.text.includes(f.text) || f.text.includes(k.text)));
    if (same < 0) {
      kept.push(f);
      continue;
    }
    const existing = kept[same]!;
    if (f.text.length > existing.text.length) kept[same] = { ...f, note: existing.note ?? f.note };
  }
  return kept;
}

/** 下書きの各区間の facts に facts パスの結果を足す。パスが同じ語を別の型にした候補は、パスの型に置き換わる。 */
export function applyFactsPass(segments: readonly DraftSegment[], passFacts: ReadonlyArray<readonly DraftFact[] | null>): DraftSegment[] {
  return segments.map((s, i) => {
    const pass = passFacts[i] ?? [];
    const candidates = s.facts.filter(c => !pass.some(p => p.text.trim() === c.text.trim() && p.type !== c.type));
    return { ...s, facts: mergeFacts(s.text, pass, candidates) };
  });
}
