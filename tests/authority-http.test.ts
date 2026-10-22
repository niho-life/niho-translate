import { describe, expect, it, vi } from "vitest";
import {
  AUTHORITY_MAX_RESPONSE_BYTES,
  HttpAuthority,
} from "../packages/authority-http/src/index.ts";

describe("HTTP Authority adapter", () => {
  it("uses a fixed HTTPS origin, bearer header, redirect error, and common paths", async () => {
    const fetch = vi.fn(async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: Parameters<typeof globalThis.fetch>[1],
    ) => new Response(JSON.stringify({
      admissionId: "grant",
      role: "host",
      sourceLanguage: "ja",
      targetLanguage: "en",
      roomEpoch: "epoch",
      roomState: "waiting",
    }), { headers: { "content-type": "application/json" } }));
    const authority = new HttpAuthority({
      baseURL: "https://authority.example.invalid/v1/",
      serviceToken: "synthetic-secret",
      fetch,
    });
    await authority.admit({
      roomId: "room",
      roomEpoch: "epoch",
      participantId: "participant",
      jti: "jti",
      expiresAtMs: 10_000,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://authority.example.invalid/v1/admit");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer synthetic-secret");
    expect(() => new HttpAuthority({
      baseURL: "http://authority.example.invalid/",
      serviceToken: "secret",
      fetch,
    })).toThrow("INVALID_AUTHORITY_CONFIG");
  });

  it("rejects a streamed response as soon as it exceeds 16 KiB", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(AUTHORITY_MAX_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const authority = new HttpAuthority({
      baseURL: "https://authority.example.invalid/",
      serviceToken: "synthetic-secret",
      fetch: async () => new Response(stream, { status: 200 }),
    });
    await expect(authority.syncPresence({
      roomId: "room",
      roomEpoch: "epoch",
      participants: [],
    })).rejects.toThrow("AUTHORITY_RESPONSE_TOO_LARGE");
  });
});
