import { describe, expect, it, vi } from "vitest";
import type { WireServerEvent } from "../packages/protocol/src/index.ts";
import {
  BoundedDeliveryPeer,
  MAX_UNACKNOWLEDGED_DELIVERY_BYTES,
  type ClientPeer,
} from "../packages/relay-core/src/index.ts";

class WirePeer implements ClientPeer {
  events: WireServerEvent[] = [];
  closed?: [number, string];
  send(event: WireServerEvent): void { this.events.push(event); }
  close(code: number, reason: string): void { this.closed = [code, reason]; }
}

describe("bounded relay delivery", () => {
  it("rejects future acknowledgements and does not let duplicate ACKs free newer events", () => {
    const raw = new WirePeer();
    const overflow = vi.fn();
    const peer = new BoundedDeliveryPeer(raw, overflow);
    expect(peer.send({ v: 1, type: "route", canCapture: false, reason: "blocked" })).toBe(true);
    expect(peer.acknowledge(2)).toBe(false);
    expect(peer.acknowledge(1)).toBe(true);
    for (let index = 0; index < 128; index += 1) {
      expect(peer.send({
        v: 1,
        type: "caption.delta",
        speakerId: "speaker",
        generation: 1,
        language: "en",
        captionOnly: false,
        delta: "x",
        atMs: index,
      })).toBe(true);
    }
    expect(peer.acknowledge(1)).toBe(true);
    expect(peer.send({ v: 1, type: "latency.status", status: "unknown" })).toBe(false);
    expect(raw.closed).toEqual([4009, "delivery-backpressure"]);
    expect(overflow).toHaveBeenCalledTimes(1);
    const bytes = raw.events.slice(1).reduce(
      (total, event) => total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(MAX_UNACKNOWLEDGED_DELIVERY_BYTES);
  });

  it("includes caption wire bytes in the unacknowledged byte cap", () => {
    const raw = new WirePeer();
    const peer = new BoundedDeliveryPeer(raw, vi.fn());
    while (peer.send({
      v: 1,
      type: "caption.delta",
      speakerId: "speaker",
      generation: 1,
      language: "en",
      captionOnly: false,
      delta: "界".repeat(4_096),
      atMs: 1,
    })) {}
    const bytes = raw.events.reduce(
      (total, event) => total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(MAX_UNACKNOWLEDGED_DELIVERY_BYTES);
    expect(raw.closed).toEqual([4009, "delivery-backpressure"]);
  });
});
