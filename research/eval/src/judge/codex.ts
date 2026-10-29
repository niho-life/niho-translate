/** ChatGPT ログイン済みのローカル Codex app-server で、テキストだけを判定する。 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { Usage } from "./openai.ts";

// Large, audio-grounded batches can exceed three minutes on the subscription route.
// Keep the timeout per batch bounded while allowing the stronger judge to finish.
const TIMEOUT_MS = 360_000;

export async function runCodexJudge(args: {
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly schema: Record<string, unknown>;
}): Promise<{ value: unknown; usage: Usage }> {
  // API key が呼び出し元に存在しても、Codex の ChatGPT ログインを使う。
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    cwd: tmpdir(), env, stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  let text = "";
  let settled = false;
  let threadId = "";
  const send = (message: unknown): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        child.kill();
        if (error) { reject(error); return; }
        try {
          resolve({
            value: JSON.parse(text),
            // Codex app-server の turn 通知では API の token usage は報告されない。
            usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          });
        } catch { reject(new Error("Codex app-server returned invalid JSON")); }
      };
      const timer = setTimeout(() => finish(new Error("Codex app-server timed out")), TIMEOUT_MS);
      child.on("error", () => finish(new Error("Codex app-server could not start")));
      child.on("exit", () => { if (!settled) finish(new Error("Codex app-server exited before turn completion")); });
      lines.on("line", (line) => {
        let message: Record<string, any>;
        try { message = JSON.parse(line) as Record<string, any>; } catch { return; }
        if (message.error && typeof message.id === "number") {
          finish(new Error(`Codex app-server RPC ${message.id} failed: ${String(message.error.message ?? "unknown")}`));
          return;
        }
        if (message.id === 0 && message.result) {
          send({ method: "initialized", params: {} });
          send({ method: "thread/start", id: 1, params: {
            model: args.model, cwd: tmpdir(), ephemeral: true,
            approvalPolicy: "never", sandbox: "read-only", baseInstructions: args.instructions,
          } });
        } else if (message.id === 1 && message.result?.thread?.id) {
          threadId = String(message.result.thread.id);
          send({ method: "turn/start", id: 2, params: {
            threadId, input: [{ type: "text", text: args.input }], outputSchema: args.schema,
          } });
        } else if (message.method === "item/agentMessage/delta") {
          text += String(message.params?.delta ?? "");
        } else if (message.method === "item/completed" && message.params?.item?.type === "agentMessage" && !text) {
          text = String(message.params.item.text ?? "");
        } else if (message.method === "turn/completed") {
          if (message.params?.turn?.status !== "completed") {
            finish(new Error(`Codex app-server turn ${String(message.params?.turn?.status ?? "failed")}`));
          } else finish();
        }
      });
      send({ method: "initialize", id: 0, params: {
        clientInfo: { name: "niho_translate_research", title: "NIHO Translate Research", version: "0.1.0" },
      } });
    });
  } finally {
    child.kill();
  }
}
