/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it, vi } from "vitest";
import {
  isTranslateUpgrade,
  roomObjectName,
  routeUpgrade,
  verifyRoomObjectClaims,
} from "../examples/relay-cloudflare/src/index.ts";
import { CloudflareProviderTransportFactory } from "../examples/relay-cloudflare/src/transport.ts";

class StubWebSocket {
  accepted = false;
  sent: string[] = [];
  closed?: [number | undefined, string | undefined];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  accept(): void { this.accepted = true; }
  send(value: string): void { this.sent.push(value); }
  close(code?: number, reason?: string): void { this.closed = [code, reason]; }
  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("Cloudflare relay routing", () => {
  it("accepts only the fixed header-authenticated upgrade route", () => {
    const valid = new Request("https://relay.example.invalid/translate", {
      headers: { authorization: "Bearer ticket", upgrade: "websocket" },
    });
    expect(isTranslateUpgrade(valid)).toBe(true);
    expect(isTranslateUpgrade(new Request("https://relay.example.invalid/translate?ticket=x", {
      headers: { authorization: "Bearer ticket", upgrade: "websocket" },
    }))).toBe(false);
    expect(isTranslateUpgrade(new Request("https://relay.example.invalid/translate", {
      headers: { upgrade: "websocket" },
    }))).toBe(false);
    expect(isTranslateUpgrade(new Request("https://relay.example.invalid/other", {
      headers: { authorization: "Bearer ticket", upgrade: "websocket" },
    }))).toBe(false);
  });

  it("derives the namespace ID only from verified room and epoch claims", async () => {
    const fetch = vi.fn(async () => new Response("upstream", { status: 200 }));
    const idFromName = vi.fn(name => ({ name }));
    const get = vi.fn(() => ({ fetch }));
    const rooms = { idFromName, get } as unknown as Pick<DurableObjectNamespace, "idFromName" | "get">;
    const request = new Request("https://relay.example.invalid/translate", {
      headers: { authorization: "Bearer opaque", upgrade: "websocket" },
    });
    const claims = {
      roomId: "room",
      roomEpoch: "epoch",
      participantId: "participant",
      jti: "jti",
      expiresAtMs: 10_000,
    };
    const response = await routeUpgrade(request, rooms, async token => {
      expect(token).toBe("opaque");
      return claims;
    }, 1_000);
    expect(response.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith(roomObjectName(claims));
    expect(get).toHaveBeenCalledWith({ name: roomObjectName(claims) });
    expect(fetch).toHaveBeenCalledWith(request);
  });

  it("does not reach the namespace when bearer verification fails", async () => {
    const get = vi.fn();
    const rooms = {
      idFromName: vi.fn(),
      get,
    } as unknown as Pick<DurableObjectNamespace, "idFromName" | "get">;
    const request = new Request("https://relay.example.invalid/translate", {
      headers: { authorization: "Bearer rejected", upgrade: "websocket" },
    });
    const response = await routeUpgrade(request, rooms, async () => {
      throw new Error("UNAUTHORIZED");
    });
    expect(response.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it("re-verifies inside the Durable Object and matches the derived namespace ID", async () => {
    const claims = {
      roomId: "room",
      roomEpoch: "epoch",
      participantId: "participant",
      jti: "inner-jti",
      expiresAtMs: 10_000,
    };
    const expectedName = roomObjectName(claims);
    const idFromName = (name: string) => ({ name }) as unknown as DurableObjectId;
    const matchingId = {
      equals: (other: DurableObjectId) => (other as unknown as { name: string }).name === expectedName,
    };
    await expect(verifyRoomObjectClaims(
      "opaque",
      async token => {
        expect(token).toBe("opaque");
        return claims;
      },
      idFromName,
      matchingId,
      1_000,
    )).resolves.toEqual(claims);
    await expect(verifyRoomObjectClaims(
      "opaque",
      async () => claims,
      idFromName,
      { equals: () => false },
      1_000,
    )).rejects.toThrow("ROOM_OBJECT_MISMATCH");
  });

  it("upgrades provider WSS through native fetch without losing async open", async () => {
    const socket = new StubWebSocket();
    const fetch = vi.fn(async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: Parameters<typeof globalThis.fetch>[1],
    ) => ({ status: 101, redirected: false, webSocket: socket }) as unknown as Response);
    const transport = new CloudflareProviderTransportFactory(fetch).connect(
      "wss://api.openai.com/v1/realtime/translations?model=synthetic",
      { Authorization: "Bearer synthetic" },
    );
    const opened = vi.fn();
    const failed = vi.fn();
    transport.onOpen(opened);
    transport.onError(failed);
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/realtime/translations?model=synthetic");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer synthetic");
    expect(new Headers(init!.headers).get("upgrade")).toBe("websocket");
    expect(socket.accepted).toBe(true);
    expect(transport.bufferedAmount).toBeUndefined();
    expect(failed).not.toHaveBeenCalled();

    socket.emit("message", { data: new Uint8Array([1]) });
    expect(socket.closed).toEqual([1009, "invalid-provider-message"]);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
