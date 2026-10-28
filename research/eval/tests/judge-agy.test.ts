import { describe, expect, it } from "vitest";
import { AGY_DEFAULT_MODEL, agyPrompt, buildAgyArgs, isAgyQuotaError, parseAgyOutput } from "../src/judge/agy.ts";
import { outputNames } from "../src/judge/files.ts";

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

describe("buildAgyArgs", () => {
  it("runs non-interactively with JSON output, the schema, a time limit and no tool permissions", () => {
    const args = buildAgyArgs({ model: AGY_DEFAULT_MODEL, prompt: "合成の入力", schema, effort: "medium" });
    expect(args.slice(0, 2)).toEqual(["-p", "合成の入力"]);
    expect(args).toContain("--sandbox");
    expect(args).toContain("--disable-slash-commands");
    expect(args).not.toContain("--dangerously-skip-permissions");
    const at = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(at("--model")).toBe("claude-opus-4-6-thinking");
    expect(at("--output-format")).toBe("json");
    expect(JSON.parse(at("--json-schema") ?? "")).toEqual(schema);
    expect(at("--print-timeout")).toBe("480s");
    expect(at("--effort")).toBe("medium");
  });

  it("leaves out --json-schema in prompt mode (one turn instead of two)", () => {
    const args = buildAgyArgs({ model: "m", prompt: "p", schema, schemaMode: "prompt" });
    expect(args).not.toContain("--json-schema");
    expect(args).toContain("--output-format");
  });

  it("drops an effort value agy does not know", () => {
    expect(buildAgyArgs({ model: "m", prompt: "p", schema, effort: "minimal" })).not.toContain("--effort");
  });
});

describe("agyPrompt", () => {
  it("starts with the no-tools line, then the instructions, and marks the input as data", () => {
    const prompt = agyPrompt("INSTRUCTIONS", "JUDGE id=s1");
    expect(prompt.startsWith("Do not use tools. Answer only with the JSON object.\n")).toBe(true);
    expect(prompt.indexOf("INSTRUCTIONS")).toBeLessThan(prompt.indexOf("----- INPUT -----"));
    expect(prompt).toContain("----- INPUT -----\nJUDGE id=s1\n----- END OF INPUT -----");
    expect(prompt).not.toContain("JSON Schema");
  });

  it("writes the schema into the prompt in prompt mode", () => {
    const prompt = agyPrompt("INSTRUCTIONS", "JUDGE id=s1", schema);
    expect(prompt).toContain("validates against this JSON Schema");
    expect(prompt).toContain(JSON.stringify(schema));
  });
});

describe("parseAgyOutput", () => {
  const ok = {
    conversation_id: "x",
    status: "SUCCESS",
    response: '{"ok":true}\n',
    duration_seconds: 12.5,
    structured_output: { ok: true },
    usage: { input_tokens: 9000, output_tokens: 100, thinking_tokens: 400 },
  };

  it("reads structured_output, usage and duration", () => {
    expect(parseAgyOutput(JSON.stringify(ok))).toEqual({
      value: { ok: true },
      usage: { inputTokens: 9000, outputTokens: 500, reasoningTokens: 400 },
      durationSec: 12.5,
    });
  });

  it("falls back to the last JSON object in the response text", () => {
    const out = parseAgyOutput(JSON.stringify({ ...ok, structured_output: null, response: 'Here: {"segments":[{"id":"s1"}]} done' }));
    expect(out.value).toEqual({ segments: [{ id: "s1" }] });
  });

  it("reads a fenced JSON answer when no schema was enforced", () => {
    const response = 'Here is the result:\n```json\n{"segments":[{"id":"s1","facts":[{"index":0,"verdict":"ok"}]}]}\n```\n';
    const out = parseAgyOutput(JSON.stringify({ ...ok, structured_output: undefined, response }));
    expect(out.value).toEqual({ segments: [{ id: "s1", facts: [{ index: 0, verdict: "ok" }] }] });
  });

  it("gives up (without hanging) on malformed JSON that starts with a brace", () => {
    const response = '{"segments":[{"id":"s1","note":"bad "quote" here"}]}';
    const started = Date.now();
    expect(() => parseAgyOutput(JSON.stringify({ ...ok, structured_output: undefined, response }))).toThrow(/no structured output/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("explains the empty answer agy returns at --print-timeout", () => {
    const timedOut = { conversation_id: "x", status: "SUCCESS", response: "", duration_seconds: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 } };
    expect(() => parseAgyOutput(JSON.stringify(timedOut))).toThrow(/print-timeout/);
  });

  it("tolerates log lines around the JSON", () => {
    expect(parseAgyOutput(`starting\n${JSON.stringify(ok)}\n`).value).toEqual({ ok: true });
  });

  it("rejects failures and denied tool requests", () => {
    expect(() => parseAgyOutput(JSON.stringify({ ...ok, status: "ERROR" }))).toThrow(/status ERROR/);
    expect(() =>
      parseAgyOutput(JSON.stringify({ ...ok, structured_output: null, response: "a tool required the command permission ... auto-denied" })),
    ).toThrow(/requested a tool/);
    expect(() => parseAgyOutput("not json")).toThrow(/not a JSON object/);
  });
});

describe("isAgyQuotaError", () => {
  it("recognizes the quota message so the judge does not retry", () => {
    expect(isAgyQuotaError("error: Individual quota reached. Please upgrade your subscription to increase your limits.")).toBe(true);
    expect(isAgyQuotaError("agy failed (1): invalid model selection")).toBe(false);
  });
});

describe("outputNames", () => {
  it("keeps the default names and derives the report name from --out-name", () => {
    expect(outputNames("judgement.json")).toEqual({ judgement: "judgement.json", report: "report.md" });
    expect(outputNames("judgement-agy.json")).toEqual({ judgement: "judgement-agy.json", report: "report-agy.md" });
    expect(outputNames("opus.json")).toEqual({ judgement: "opus.json", report: "opus-report.md" });
  });

  it("refuses paths and run artifacts", () => {
    for (const bad of ["../judgement.json", "a/b.json", "summary.json", "output-words.json", "judgement.md", ""]) {
      expect(() => outputNames(bad)).toThrow();
    }
  });
});
