import { describe, expect, it, vi } from "vitest";
import { MockAuthority } from "../examples/relay-local/src/mock-authority.ts";
import type { TicketClaims } from "../packages/relay-core/src/index.ts";

describe("relay-local MockAuthority room ownership", () => {
  it("starts leases on acquisition and allows takeover only after expiry", async () => {
    vi.useFakeTimers();
    try {
      const baseTime = new Date("2026-11-04T00:00:00.000Z");
      vi.setSystemTime(baseTime);
      const authority = new MockAuthority();

      // Delay the first admission beyond the old constructor-based lease deadline.
      vi.setSystemTime(new Date(baseTime.getTime() + 20_000));
      const makeClaims = (jti: string): TicketClaims => ({
        roomId: "room",
        participantId: "host-ja",
        roomEpoch: "epoch",
        jti,
        expiresAtMs: Date.now() + 10_000,
      });
      const first = await authority.admit(makeClaims("first"), { leaseId: "owner-a" });
      if (first.status !== "admitted") throw new Error("FIRST_OWNER_NOT_ADMITTED");
      expect(first.roomOwner.expiresAtMs).toBe(Date.now() + 10_000);

      const oldOwner = { leaseId: "owner-a", fencingToken: first.roomOwner.fencingToken };
      vi.setSystemTime(new Date(first.roomOwner.expiresAtMs + 1));
      await expect(authority.renewRoomOwnership({
        roomId: "room",
        roomEpoch: "epoch",
        roomOwner: oldOwner,
      })).rejects.toThrow("STALE_ROOM_OWNER");
      await expect(authority.admit(makeClaims("stale"), oldOwner)).rejects.toThrow("STALE_ROOM_OWNER");

      const replacement = await authority.admit(makeClaims("replacement"), { leaseId: "owner-b" });
      expect(replacement.status).toBe("admitted");
      if (replacement.status !== "admitted") throw new Error("REPLACEMENT_OWNER_NOT_ADMITTED");
      expect(replacement.roomOwner.fencingToken).toBeGreaterThan(oldOwner.fencingToken);
      await expect(authority.syncPresence({
        roomId: "room",
        roomEpoch: "epoch",
        participants: [],
        roomOwner: oldOwner,
      })).rejects.toThrow("STALE_ROOM_OWNER");
    } finally {
      vi.useRealTimers();
    }
  });
});
