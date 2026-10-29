import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";

const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }));
});

function start(host?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, RELAY_MODE: "mock", PORT: "0" };
  delete env.HOST;
  if (host !== undefined) env.HOST = host;
  const child = spawn(process.execPath, ["--experimental-transform-types", "examples/relay-local/src/server.ts"], {
    cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

for (const host of [undefined, "0.0.0.0"]) {
  test(`listener binds ${host ?? "default loopback"} on PORT`, async () => {
    const child = start(host);
    const address = await new Promise<{ host: string; port: number }>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("listener startup timeout")), 5000);
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("unexpected listener exit")); });
      child.stdout!.on("data", data => {
        output += String(data);
        const match = /listening on ([\d.]+):(\d+)/.exec(output);
        if (match) { clearTimeout(timeout); resolve({ host: match[1]!, port: Number(match[2]) }); }
      });
    });
    expect(address.host).toBe(host ?? "127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(await response.json()).toEqual({ ok: true, mode: "mock" });
  });
}

test.each(["localhost", "::", "192.0.2.1", ""])("rejects unsupported HOST %j", async host => {
  const child = start(host);
  let errors = "";
  child.stderr!.on("data", data => { errors += String(data); });
  const [code] = await once(child, "exit");
  expect(code).not.toBe(0);
  expect(errors).toContain("INVALID_HOST");
});
