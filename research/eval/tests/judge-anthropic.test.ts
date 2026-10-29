import { describe, expect, it } from "vitest";
import { ANTHROPIC_DEFAULT_MODEL, buildAnthropicBody, parseAnthropicResponse } from "../src/judge/anthropic.ts";
import { parseJudgeArgs } from "../src/judge/judge.ts";

const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };

describe("buildAnthropicBody", () => {
  it("puts the instructions in system, the input as one user turn, and the schema in output_config.format", () => {
    const body = buildAnthropicBody({ model: ANTHROPIC_DEFAULT_MODEL, instructions: "INSTRUCTIONS", input: "JUDGE id=s1", schema, effort: "high" });
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.system).toBe("INSTRUCTIONS");
    expect(body.messages).toEqual([{ role: "user", content: "JUDGE id=s1" }]);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema }, effort: "high" });
    expect(body.max_tokens).toBe(32_000);
    expect(JSON.stringify(body)).not.toContain("temperature");
  });

  it("leaves effort out when not given", () => {
    const body = buildAnthropicBody({ model: "m", instructions: "i", input: "x", schema }) as { output_config: Record<string, unknown> };
    expect(body.output_config).not.toHaveProperty("effort");
  });
});

describe("parseAnthropicResponse", () => {
  it("joins the text blocks, parses the JSON and counts cached input as input", () => {
    const res = parseAnthropicResponse({
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"ok":' }, { type: "text", text: "true}" }],
      usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 7 },
    });
    expect(res.value).toEqual({ ok: true });
    expect(res.usage).toEqual({ inputTokens: 16, outputTokens: 7, reasoningTokens: 0 });
  });

  it("throws on refusal, max_tokens, empty text and broken JSON without echoing the body", () => {
    expect(() => parseAnthropicResponse({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] })).toThrow(/refused .*cyber/);
    expect(() => parseAnthropicResponse({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] })).toThrow(/max_tokens/);
    expect(() => parseAnthropicResponse({ stop_reason: "end_turn", content: [] })).toThrow(/no text/);
    expect(() => parseAnthropicResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "{oops" }] })).toThrow(/not valid JSON/);
  });
});

describe("parseJudgeArgs with --judge-backend anthropic", () => {
  const base = ["--run", "/tmp/run", "--reference", "/tmp/ref.json", "--judge-backend", "anthropic"];

  it("defaults to claude-opus-5-5 at effort high with 15 segments per call", () => {
    const args = parseJudgeArgs(base);
    expect(args.backend).toBe("anthropic");
    expect(args.model).toBe("claude-opus-5-5");
    expect(args.effort).toBe("high");
    expect(args.batch).toBe(15);
  });

  it("accepts Anthropic effort levels only", () => {
    expect(parseJudgeArgs([...base, "--effort", "max"]).effort).toBe("max");
    expect(() => parseJudgeArgs([...base, "--effort", "minimal"])).toThrow(/--effort/);
  });

  it("is the default backend when --judge-backend is omitted (gpt-5.4 stays available as openai)", () => {
    expect(parseJudgeArgs(["--run", "/tmp/run", "--reference", "/tmp/ref.json"]).backend).toBe("anthropic");
    const openai = parseJudgeArgs(["--run", "/tmp/run", "--reference", "/tmp/ref.json", "--judge-backend", "openai"]);
    expect(openai.model).toBe("gpt-5.4");
    expect(openai.effort).toBe("medium");
  });

  it("rejects an unknown backend", () => {
    expect(() => parseJudgeArgs(["--run", "/tmp/run", "--reference", "/tmp/ref.json", "--judge-backend", "gemini"])).toThrow(/--judge-backend/);
  });
});

describe("Codex subscription judge options", () => {
  const base = ["--run", "/tmp/run", "--reference", "/tmp/ref.json", "--judge-backend", "codex"];

  it("defaults to a ChatGPT-authenticated model and audio timing", () => {
    const args = parseJudgeArgs(base);
    expect(args.model).toBe("gpt-6-astra");
    expect(args.wordSource).toBe("audio");
    expect(args.batch).toBe(8);
  });

  it("accepts an explicitly approximate subtitle timeline", () => {
    expect(parseJudgeArgs([...base, "--word-source", "subtitle"]).wordSource).toBe("subtitle");
    expect(() => parseJudgeArgs([...base, "--word-source", "invalid"])).toThrow(/word-source/);
    expect(() => parseJudgeArgs([...base, "--effort", "high"])).toThrow(/effort/);
  });
});
