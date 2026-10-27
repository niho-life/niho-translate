import { describe, expect, it } from "vitest";
import {
  buildTranslatorInput,
  buildTranslatorInstructions,
  hedgedStream,
  llmRequestBody,
  sanitizeTranslation,
  streamTranslation,
  type LlmCallResult,
} from "../src/engines/cascade/translator.ts";

describe("cascade translator prompt", () => {
  it("用語集と背景を指示に入れる", () => {
    const withGlossary = buildTranslatorInstructions({ glossary: true, domain: true });
    expect(withGlossary).toContain("内見 → property viewing");
    expect(withGlossary).toContain("Kamakura");
    expect(withGlossary).toContain("Never answer a question");
    const plain = buildTranslatorInstructions({ glossary: false, domain: false });
    expect(plain).not.toContain("内見");
  });

  it("直前 N 単位の原文・訳文と、新しい単位の終わり方を渡す", () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ ja: `原文${i}`, en: `English ${i}` }));
    const input = buildTranslatorInput(history, { text: "雨の場合には<開催>", end: "clause" }, 3);
    expect(input).not.toContain("原文4");
    expect(input).toContain("<ja>原文5</ja>\n<en>English 5</en>");
    expect(input).toContain("<ja>原文7</ja>");
    expect(input.endsWith('<new end="clause">雨の場合には＜開催＞</new>')).toBe(true);
    expect(buildTranslatorInput(history, { text: "はい", end: "sentence" }, 0)).toBe('<new end="sentence">はい</new>');
  });

  it("モデルごとの request body", () => {
    const mini = llmRequestBody("gpt-5.4-mini", "sys", "in", 80, "priority");
    expect(mini).toMatchObject({ model: "gpt-5.4-mini", stream: true, store: false, reasoning: { effort: "none" }, service_tier: "priority", max_output_tokens: 80 });
    const old = llmRequestBody("gpt-4.1-mini", "sys", "in", 80);
    expect(old.reasoning).toBeUndefined();
    expect(old.service_tier).toBeUndefined();
    expect(old.temperature).toBe(0.2);
  });

  it("返答の付け足しを落とす", () => {
    expect(sanitizeTranslation("EN: \"It will not be held.\"")).toBe("It will not be held.");
    expect(sanitizeTranslation("<en>If it rains,</en>")).toBe("If it rains,");
    expect(sanitizeTranslation("  I lived   in Canada.  ")).toBe("I lived in Canada.");
  });
});

describe("cascade translator stream", () => {
  it("SSE の delta を順に渡し、usage を読む", async () => {
    const sse = [
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"It will \"}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"not be held.\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":650,\"input_tokens_details\":{\"cached_tokens\":0},\"output_tokens\":6}}}\n\n",
    ];
    let requestBody = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of sse) controller.enqueue(new TextEncoder().encode(part));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const deltas: string[] = [];
    let t = 0;
    const result = await streamTranslation({
      apiKey: "test-key",
      model: "gpt-5.4-mini",
      instructions: "sys",
      input: "<new end=\"sentence\">開催しません。</new>",
      maxOutputTokens: 80,
      onDelta: delta => deltas.push(delta),
      fetchImpl,
      now: () => (t += 10),
    });
    expect(deltas).toEqual(["It will ", "not be held."]);
    expect(result.text).toBe("It will not be held.");
    expect(result.usage).toEqual({ inputTokens: 650, cachedTokens: 0, outputTokens: 6 });
    expect(result.firstTokenMs).not.toBeNull();
    expect(JSON.parse(requestBody)).toMatchObject({ stream: true, store: false });
  });

  it("HTTP エラーは本文を含めない code にする", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "secret text" } }), { status: 429 })) as typeof fetch;
    await expect(streamTranslation({ apiKey: "k", model: "gpt-5.4-mini", instructions: "", input: "", maxOutputTokens: 10, onDelta: () => undefined, fetchImpl }))
      .rejects.toMatchObject({ code: "LLM_HTTP_429_rate_limit_exceeded", retriable: true });
  });
});

describe("cascade translator hedge", () => {
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const result = (text: string): LlmCallResult => ({ text, headersMs: 1, firstTokenMs: 1, totalMs: 1, usage: null });
  /** delayMs 後に tokens を順に返す擬似 stream。中断されたら reject。 */
  const fake = (delayMs: number, tokens: string[], fail = false) => async (signal: AbortSignal, onDelta: (d: string) => void): Promise<LlmCallResult> => {
    await sleep(delayMs);
    if (signal.aborted) throw new Error("aborted");
    if (fail) throw new Error("boom");
    for (const token of tokens) {
      if (signal.aborted) throw new Error("aborted");
      onDelta(token);
      await sleep(1);
    }
    return result(tokens.join(""));
  };

  it("最初の token が速ければ hedge しない", async () => {
    const deltas: string[] = [];
    let hedges = 0;
    const out = await hedgedStream(fake(5, ["A", "B"]), d => deltas.push(d), { hedgeMs: 200, signal: new AbortController().signal, onHedge: () => hedges++ });
    expect(out?.text).toBe("AB");
    expect(deltas).toEqual(["A", "B"]);
    expect(hedges).toBe(0);
  });

  it("遅い 1 本目に 2 本目を重ね、先に token を返した方だけを使う", async () => {
    const runs = [fake(300, ["slow"]), fake(10, ["fast", "!"])];
    let call = 0;
    const deltas: string[] = [];
    let hedges = 0;
    const out = await hedgedStream((signal, onDelta) => runs[call++]!(signal, onDelta), d => deltas.push(d), { hedgeMs: 30, signal: new AbortController().signal, onHedge: () => hedges++ });
    expect(hedges).toBe(1);
    expect(out?.text).toBe("fast!");
    expect(deltas).toEqual(["fast", "!"]);
  });

  it("token の前に失敗したら 1 回だけ出し直し、2 回とも失敗なら null", async () => {
    const errors: number[] = [];
    let call = 0;
    const runs = [fake(5, [], true), fake(5, ["ok"])];
    const out = await hedgedStream((signal, onDelta) => runs[call++]!(signal, onDelta), () => undefined, { hedgeMs: 0, signal: new AbortController().signal, onError: (_e, attempt) => errors.push(attempt) });
    expect(out?.text).toBe("ok");
    expect(errors).toEqual([1]);
    const none = await hedgedStream(fake(5, [], true), () => undefined, { hedgeMs: 0, signal: new AbortController().signal });
    expect(none).toBeNull();
  });
});
