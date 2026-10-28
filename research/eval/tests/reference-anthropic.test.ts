import { describe, expect, it } from "vitest";
import { applyStreamEvent, finishStream, isAnthropicModel, mapEffort, newStreamState, toMessagesBody } from "../src/reference/anthropic.ts";
import { OpenAIRequestError } from "../src/reference/openai.ts";

const schema = { type: "object", additionalProperties: false, required: ["segments"], properties: { segments: { type: "array", items: { type: "string" } } } };
const request = {
  model: "anthropic:claude-opus-5-5",
  store: false,
  reasoning: { effort: "medium" },
  max_output_tokens: 48_000,
  instructions: "INSTRUCTIONS",
  input: [{ role: "user", content: [{ type: "input_text", text: "PART 1" }, { type: "input_text", text: "PART 2" }] }],
  text: { format: { type: "json_schema", name: "reference_segments", strict: true, schema } },
};

describe("toMessagesBody", () => {
  it("maps a Responses request to a streaming Messages request with the same schema", () => {
    const body = toMessagesBody(request) as Record<string, unknown>;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(48_000);
    expect(body.system).toBe("INSTRUCTIONS");
    expect(body.messages).toEqual([{ role: "user", content: "PART 1\nPART 2" }]);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "medium", format: { type: "json_schema", schema } });
    expect(JSON.stringify(body)).not.toContain("store");
    expect(JSON.stringify(body)).not.toContain("temperature");
  });

  it("maps OpenAI reasoning efforts onto Anthropic levels", () => {
    expect(mapEffort("none")).toBe("low");
    expect(mapEffort("minimal")).toBe("low");
    expect(mapEffort("low")).toBe("low");
    expect(mapEffort("medium")).toBe("medium");
    expect(mapEffort("high")).toBe("high");
    expect(mapEffort("xhigh")).toBe("xhigh");
    expect(mapEffort(undefined)).toBe("medium");
  });

  it("only accepts anthropic: models", () => {
    expect(isAnthropicModel("anthropic:claude-sonnet-5-5")).toBe(true);
    expect(isAnthropicModel("gpt-5.4")).toBe(false);
    expect(() => toMessagesBody({ ...request, model: "gpt-5.4" })).toThrow(/not an anthropic model/);
  });
});

describe("stream events", () => {
  it("collects text deltas and usage, and maps end_turn to completed", () => {
    const state = newStreamState();
    applyStreamEvent(state, { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 } } });
    applyStreamEvent(state, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    applyStreamEvent(state, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: '{"segments":' } });
    applyStreamEvent(state, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "[]}" } });
    applyStreamEvent(state, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } });
    expect(finishStream(state)).toEqual({ status: "completed", text: '{"segments":[]}', usage: { inputTokens: 125, cachedInputTokens: 20, outputTokens: 50, reasoningTokens: 0 } });
  });

  it("maps max_tokens to incomplete and keeps other stop reasons as the status", () => {
    const a = newStreamState();
    applyStreamEvent(a, { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 10 } });
    expect(finishStream(a).status).toBe("incomplete");
    const b = newStreamState();
    applyStreamEvent(b, { type: "message_delta", delta: { stop_reason: "refusal" }, usage: {} });
    expect(finishStream(b).status).toBe("refusal");
  });

  it("throws on an error event without leaking a key", () => {
    const state = newStreamState();
    expect(() => applyStreamEvent(state, { type: "error", error: { type: "overloaded_error", message: "Overloaded sk-test-abcdefgh" } })).toThrow(OpenAIRequestError);
    try {
      applyStreamEvent(state, { type: "error", error: { type: "overloaded_error", message: "Overloaded sk-test-abcdefgh" } });
    } catch (e) {
      expect((e as Error).message).toContain("overloaded_error");
      expect((e as Error).message).not.toContain("abcdefgh");
    }
  });
});
