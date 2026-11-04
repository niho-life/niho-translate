import type {
  Authority,
  AuthorityAdmission,
  BudgetLease,
  ControlRoomContext,
  TicketClaims,
} from "../../../packages/relay-core/src/index.ts";
import type { AuthorityRoomState } from "../../../packages/room-core/src/index.ts";

export class MockAuthority implements Authority {
  private roomState: AuthorityRoomState = "waiting";
  private readonly grants = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private readonly consumedJtis = new Set<string>();
  private ownerLeaseId: string | undefined;
  private ownerFence = 0;
  private ownerExpiresAtMs = 0;

  async admit(
    claims: TicketClaims,
    candidate: Parameters<Authority["admit"]>[1],
  ): Promise<AuthorityAdmission> {
    const now = Date.now();
    const currentOwnerIsLive = this.ownerLeaseId !== undefined && this.ownerExpiresAtMs > now;
    if (currentOwnerIsLive && this.ownerLeaseId !== candidate.leaseId) {
      return { status: "busy" as const, retryAfterMs: Math.max(1, this.ownerExpiresAtMs - now) };
    }
    if (!currentOwnerIsLive) {
      if (candidate.fencingToken !== undefined) throw new Error("STALE_ROOM_OWNER");
      this.ownerLeaseId = candidate.leaseId;
      this.ownerFence += 1;
      this.ownerExpiresAtMs = now + 10_000;
    } else if (candidate.fencingToken !== undefined && candidate.fencingToken !== this.ownerFence) {
      throw new Error("STALE_ROOM_OWNER");
    }
    if (this.consumedJtis.has(claims.jti)) throw new Error("TICKET_REPLAY");
    this.consumedJtis.add(claims.jti);
    const ownerLeaseId = this.ownerLeaseId;
    if (!ownerLeaseId) throw new Error("ROOM_OWNER_NOT_ACQUIRED");
    const sourceLanguage = claims.participantId === "guest-en" ? "en" as const : "ja" as const;
    const admissionId = `${claims.participantId}-${claims.jti}`;
    this.grants.set(claims.participantId, admissionId);
    return {
      status: "admitted" as const,
      admissionId,
      role: claims.participantId === "host-ja" ? "host" as const : "guest" as const,
      sourceLanguage,
      targetLanguage: sourceLanguage === "ja" ? "en" as const : "ja" as const,
      roomEpoch: claims.roomEpoch,
      roomState: this.roomState,
      roomOwner: { leaseId: ownerLeaseId, fencingToken: this.ownerFence, expiresAtMs: this.ownerExpiresAtMs },
    };
  }

  async renewRoomOwnership(input: Parameters<Authority["renewRoomOwnership"]>[0]) {
    this.assertOwner(input.roomOwner);
    this.ownerExpiresAtMs = Date.now() + 10_000;
    return { leaseId: this.ownerLeaseId!, fencingToken: this.ownerFence, expiresAtMs: this.ownerExpiresAtMs };
  }

  async syncPresence(value: Parameters<Authority["syncPresence"]>[0]) {
    this.assertOwner(value.roomOwner);
    const allowed = value.participants.filter(
      participant => this.grants.get(participant.participantId) === participant.admissionId,
    );
    for (const participant of allowed) {
      this.generations.set(participant.participantId, participant.generation);
    }
    return {
      roomEpoch: value.roomEpoch,
      state: this.roomState,
      allowedAdmissionIds: allowed.map(participant => participant.admissionId),
    };
  }

  async controlRoom(context: ControlRoomContext) {
    this.assertCurrent(context);
    this.roomState = context.action === "start" || context.action === "resume"
      ? "active"
      : context.action === "pause" ? "paused" : "ended";
    return { roomEpoch: context.roomEpoch, state: this.roomState };
  }

  async acquireLease(input: Parameters<Authority["acquireLease"]>[0]): Promise<BudgetLease> {
    this.assertCurrent(input);
    return this.lease();
  }

  async renewLease(input: Parameters<Authority["renewLease"]>[0]): Promise<BudgetLease> {
    this.assertCurrent(input);
    return this.lease();
  }

  async reportUsage(event: Parameters<Authority["reportUsage"]>[0]): Promise<void> {
    this.assertCurrent(event);
  }

  private assertCurrent(value: { participantId: string; admissionId: string; generation: number; roomOwner?: { leaseId: string; fencingToken: number } }): void {
    if (value.roomOwner) this.assertOwner(value.roomOwner);
    if (
      this.grants.get(value.participantId) !== value.admissionId
      || this.generations.get(value.participantId) !== value.generation
    ) {
      throw new Error("STALE_ADMISSION");
    }
  }

  private assertOwner(value: { leaseId: string; fencingToken: number }): void {
    if (
      value.leaseId !== this.ownerLeaseId
      || value.fencingToken !== this.ownerFence
      || this.ownerExpiresAtMs <= Date.now()
    ) {
      throw new Error("STALE_ROOM_OWNER");
    }
  }

  private lease(): BudgetLease {
    return {
      leaseId: `mock-${Date.now()}`,
      expiresAtMs: Date.now() + 15_000,
      maxInputAudioMs: 15_000,
    };
  }
}
