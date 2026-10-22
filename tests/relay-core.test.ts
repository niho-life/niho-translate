import { describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { AUDIO_BATCH_BYTES, type ServerEvent } from "../packages/protocol/src/index.ts";
import {
  JoseTicketVerifier,
  RelayOrchestrator,
  MAX_PENDING_CLIENT_OPERATIONS,
  type Authority,
  type BudgetLease,
  type ClientPeer,
  type RelayClock,
  type TicketClaims,
  type TicketVerifier,
  type TranslationFactory,
  type TranslationSession,
  type UsageEvent,
} from "../packages/relay-core/src/index.ts";
import type { ProviderSink } from "../packages/provider-openai/src/index.ts";
import type { AuthorityRoomState } from "../packages/room-core/src/index.ts";

class Clock implements RelayClock {
  time = 1_000;
  interval = () => {};
  timers = new Map<number, () => void>();
  nextTimer = 1;
  now(): number { return this.time; }
  setInterval(handler: () => void): number { this.interval = handler; return 1; }
  clearInterval(): void {}
  setTimeout(handler: () => void): number {
    const id = this.nextTimer++;
    this.timers.set(id, handler);
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
}

class Peer implements ClientPeer {
  events: ServerEvent[] = [];
  closed?: [number, string];
  send(event: ServerEvent): void { this.events.push(event); }
  close(code: number, reason: string): void { this.closed = [code, reason]; }
}

async function acknowledgeLatest(
  relay: RelayOrchestrator,
  participantId: string,
  generation: number,
  peer: Peer,
): Promise<void> {
  const deliveryId = peer.events.at(-1)?.deliveryId;
  if (deliveryId === undefined) return;
  await relay.receive("r", "e", participantId, generation, JSON.stringify({
    v: 1,
    type: "client.ack",
    deliveryId,
  }));
}

class Session implements TranslationSession {
  appends: string[] = [];
  closed = false;
  emitDuringClose = false;
  constructor(readonly sink: ProviderSink) {}
  appendPcm(audio: string): boolean {
    if (this.closed) return false;
    this.appends.push(audio);
    return true;
  }
  async close(): Promise<void> {
    if (this.emitDuringClose) this.sink.onOutputAudio(Buffer.alloc(2).toString("base64"));
    this.closed = true;
  }
}

class Factory implements TranslationFactory {
  sessions: Session[] = [];
  create(_language: "ja" | "en", sink: ProviderSink): Session {
    const session = new Session(sink);
    this.sessions.push(session);
    return session;
  }
}

const ticket = (token: string): TicketClaims => ({
  roomId: "r",
  participantId: token.split("#", 1)[0]!,
  roomEpoch: "e",
  jti: token,
  expiresAtMs: 20_000,
});
const verifier: TicketVerifier = { verify: async token => ticket(token) };

interface TestAuthority extends Authority {
  roomState: AuthorityRoomState;
  usage: UsageEvent[];
  grants: Map<string, string>;
  generations: Map<string, number>;
  revoked: Set<string>;
  failSync: boolean;
}

function authority(): TestAuthority {
  let nextAdmission = 0;
  const consumedJtis = new Set<string>();
  return {
    roomState: "waiting",
    usage: [],
    grants: new Map(),
    generations: new Map(),
    revoked: new Set(),
    failSync: false,
    async admit(claims) {
      if (consumedJtis.has(claims.jti)) throw new Error("TICKET_REPLAY");
      consumedJtis.add(claims.jti);
      const isHost = claims.participantId === "host-ja";
      const admissionId = `${claims.participantId}-grant-${++nextAdmission}`;
      this.grants.set(claims.participantId, admissionId);
      return {
        admissionId,
        role: isHost ? "host" : "guest",
        sourceLanguage: isHost ? "ja" : "en",
        targetLanguage: isHost ? "en" : "ja",
        roomEpoch: "e",
        roomState: this.roomState,
      };
    },
    async syncPresence(input) {
      if (this.failSync) throw new Error("SYNC_FAILED");
      const allowed = input.participants.filter(participant => (
        this.grants.get(participant.participantId) === participant.admissionId
        && !this.revoked.has(participant.admissionId)
      ));
      for (const participant of allowed) {
        this.generations.set(participant.participantId, participant.generation);
      }
      return {
        roomEpoch: input.roomEpoch,
        state: this.roomState,
        allowedAdmissionIds: allowed.map(participant => participant.admissionId),
      };
    },
    async controlRoom(context) {
      if (
        this.grants.get(context.participantId) !== context.admissionId
        || this.generations.get(context.participantId) !== context.generation
      ) {
        throw new Error("STALE_ADMISSION");
      }
      this.roomState = context.action === "start" || context.action === "resume"
        ? "active"
        : context.action === "pause" ? "paused" : "ended";
      return { roomEpoch: "e", state: this.roomState };
    },
    async acquireLease(input) {
      if (
        this.grants.get(input.participantId) !== input.admissionId
        || this.generations.get(input.participantId) !== input.generation
      ) throw new Error("STALE_ADMISSION");
      return { leaseId: "lease-1", expiresAtMs: 15_000, maxInputAudioMs: 15_000 };
    },
    async renewLease(input) {
      if (
        this.grants.get(input.participantId) !== input.admissionId
        || this.generations.get(input.participantId) !== input.generation
      ) throw new Error("STALE_ADMISSION");
      return { leaseId: "lease-2", expiresAtMs: 25_000, maxInputAudioMs: 15_000 };
    },
    async reportUsage(event) {
      if (
        this.grants.get(event.participantId) !== event.admissionId
        || this.generations.get(event.participantId) !== event.generation
      ) throw new Error("STALE_ADMISSION");
      this.usage.push(event);
    },
  };
}

async function readyAndStart(
  relay: RelayOrchestrator,
  participants = ["host-ja", "guest-en"],
): Promise<Map<string, { peer: Peer; generation: number }>> {
  const result = new Map<string, { peer: Peer; generation: number }>();
  for (const participant of participants) {
    const peer = new Peer();
    const identity = await relay.connect(`Bearer ${participant}`, peer);
    result.set(participant, { peer, generation: identity!.generation });
  }
  for (const [participant, value] of result) {
    await relay.receive("r", "e", participant, value.generation, JSON.stringify({ v: 1, type: "client.ready" }));
    await acknowledgeLatest(relay, participant, value.generation, value.peer);
  }
  const host = result.get("host-ja")!;
  await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "room.start" }));
  for (const [participant, value] of result) {
    await acknowledgeLatest(relay, participant, value.generation, value.peer);
  }
  return result;
}

describe("ticket boundary", () => {
  it("allows only configured algorithms, rejects long-lived tickets and bounds replay", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const getKey: JWTVerifyGetKey = async () => publicKey;
    const verifierUnderTest = new JoseTicketVerifier({
      issuer: "issuer",
      audience: "aud",
      jwksUrl: "https://keys.invalid/jwks",
      algorithms: ["RS256"],
      getKey,
    });
    const sign = (jti: string, exp: number) => new SignJWT({
      roomId: "r",
      participantId: "p",
      roomEpoch: "e",
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("issuer")
      .setAudience("aud")
      .setJti(jti)
      .setNotBefore(0)
      .setExpirationTime(exp)
      .sign(privateKey);

    const good = await sign("once", 20);
    expect((await verifierUnderTest.verify(good, 1_000)).participantId).toBe("p");
    await expect(verifierUnderTest.verify(good, 1_001)).rejects.toThrow("TICKET_REPLAY");
    await expect(verifierUnderTest.verify(await sign("too-long", 100), 1_000)).rejects.toThrow("UNAUTHORIZED");
  });
});

describe("relay orchestration", () => {
  it("requires explicit host start and fans one source out to the opposite-language peer", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const relay = new RelayOrchestrator(verifier, authority(), factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const guest = connected.get("guest-en")!;
    await relay.receive("r", "e", "guest-en", guest.generation, JSON.stringify({ v: 1, type: "capture.pause" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1,
      type: "speech.start",
      atMs: 999_999_999,
    }));
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1,
      type: "audio.append",
      audio,
      atMs: 1,
    }));
    expect(factory.sessions).toHaveLength(1);
    expect(factory.sessions[0]!.appends).toEqual([audio]);
    factory.sessions[0]!.sink.onOutputAudio(audio);
    await relay.tick();
    expect(guest.peer.events.some(event => event.type === "audio")).toBe(true);
    expect(host.peer.events.some(event => event.type === "audio")).toBe(false);
    await relay.dispose();
  });

  it("delivers quiet speech output without a local energy speech-start event", async () => {
    const factory = new Factory();
    const relay = new RelayOrchestrator(verifier, authority(), factory, new Clock());
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const guest = connected.get("guest-en")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "audio.append", audio, atMs: 1,
    }));
    factory.sessions[0]!.sink.onOutputAudio(audio);
    factory.sessions[0]!.sink.onOutputTranscript("Quiet speech");
    await relay.tick();
    expect(guest.peer.events.some(event => event.type === "audio")).toBe(true);
    expect(guest.peer.events.find(event => event.type === "caption.delta"))
      .toMatchObject({ captionOnly: false, delta: "Quiet speech" });
    expect(host.peer.events.some(event => event.type === "audio")).toBe(false);
    await relay.dispose();
  });

  it("rejects guest room control and does not treat ready as start", async () => {
    const testAuthority = authority();
    const control = vi.spyOn(testAuthority, "controlRoom");
    const relay = new RelayOrchestrator(verifier, testAuthority, new Factory(), new Clock());
    const hostPeer = new Peer();
    const guestPeer = new Peer();
    const host = await relay.connect("Bearer host-ja", hostPeer);
    const guest = await relay.connect("Bearer guest-en", guestPeer);
    await relay.receive("r", "e", "host-ja", host!.generation, JSON.stringify({ v: 1, type: "room.start" }));
    expect(hostPeer.events.some(event => event.type === "error" && event.code === "NOT_READY")).toBe(true);
    expect(control).not.toHaveBeenCalled();
    await relay.receive("r", "e", "host-ja", host!.generation, JSON.stringify({ v: 1, type: "client.ready" }));
    await relay.receive("r", "e", "guest-en", guest!.generation, JSON.stringify({ v: 1, type: "client.ready" }));
    expect(hostPeer.events.filter(event => event.type === "route").at(-1)).toMatchObject({ canCapture: false, reason: "host-not-ready" });
    await relay.receive("r", "e", "guest-en", guest!.generation, JSON.stringify({ v: 1, type: "room.start" }));
    expect(guestPeer.events.some(event => event.type === "error" && event.code === "UNAUTHORIZED")).toBe(true);
    await relay.dispose();
  });

  it("invalidates provider callbacks before close and ignores stale same-generation output", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const relay = new RelayOrchestrator(verifier, authority(), factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "speech.start", atMs: 1 }));
    const old = factory.sessions[0]!;
    old.emitDuringClose = true;
    const guestPeer = connected.get("guest-en")!.peer;
    const before = guestPeer.events.filter(event => event.type === "audio").length;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.pause" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.resume" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "speech.start", atMs: 2 }));
    old.sink.onOutputAudio(Buffer.alloc(2).toString("base64"));
    await relay.tick();
    expect(guestPeer.events.filter(event => event.type === "audio")).toHaveLength(before);
    await relay.dispose();
  });

  it("keeps a replacement connection when the old peer closes concurrently", async () => {
    const relay = new RelayOrchestrator(verifier, authority(), new Factory(), new Clock());
    const firstPeer = new Peer();
    const first = await relay.connect("Bearer host-ja", firstPeer);
    const secondPeer = new Peer();
    const reconnect = relay.connect("Bearer host-ja#reconnect", secondPeer);
    const oldClose = relay.peerClosed("r", "e", "host-ja", first!.generation);
    const [second] = await Promise.all([reconnect, oldClose]);
    expect(second!.generation).toBe(2);
    await relay.receive("r", "e", "host-ja", second!.generation, JSON.stringify({ v: 1, type: "client.ready" }));
    expect(secondPeer.closed).toBeUndefined();
    expect(secondPeer.events.some(event => event.type === "participant.state")).toBe(true);
    await relay.dispose();
  });

  it("fences old-connection ACKs and closes the current connection on a future ACK", async () => {
    const relay = new RelayOrchestrator(verifier, authority(), new Factory(), new Clock());
    const oldPeer = new Peer();
    const oldConnection = await relay.connect("Bearer host-ja#ack-old", oldPeer);
    const currentPeer = new Peer();
    const current = await relay.connect("Bearer host-ja#ack-current", currentPeer);
    await relay.receive("r", "e", "host-ja", oldConnection!.generation, JSON.stringify({
      v: 1,
      type: "client.ack",
      deliveryId: oldPeer.events.at(-1)!.deliveryId,
    }));
    expect(currentPeer.closed).toBeUndefined();
    await relay.receive("r", "e", "host-ja", current!.generation, JSON.stringify({
      v: 1,
      type: "client.ack",
      deliveryId: currentPeer.events.at(-1)!.deliveryId + 1,
    }));
    expect(currentPeer.closed).toEqual([4009, "invalid-delivery-ack"]);
    await relay.dispose();
  });

  it("enforces burst pacing and max input audio, then requires explicit resume before reacquire", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    testAuthority.acquireLease = async () => ({
      leaseId: "small",
      expiresAtMs: 15_000,
      maxInputAudioMs: 300,
    });
    const acquire = vi.spyOn(testAuthority, "acquireLease");
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "speech.start", atMs: 1 }));
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
    for (let index = 0; index < 3; index += 1) {
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "audio.append", audio, atMs: index }));
    }
    expect(host.peer.events.some(event => event.type === "error" && event.code === "AUDIO_LIMIT")).toBe(true);
    const acquisitionsAfterBlock = acquire.mock.calls.length;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "audio.append", audio, atMs: 4 }));
    expect(acquire).toHaveBeenCalledTimes(acquisitionsAfterBlock);
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.resume" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "speech.start", atMs: 5 }));
    expect(acquire.mock.calls.length).toBeGreaterThan(acquisitionsAfterBlock);
    await relay.dispose();
  });

  it("aggregates usage by lease and stops if renewal finishes after expiry", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    let resolveRenew: ((lease: BudgetLease) => void) | undefined;
    testAuthority.renewLease = () => new Promise(resolve => { resolveRenew = resolve; });
    const report = vi.spyOn(testAuthority, "reportUsage");
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "speech.start", atMs: 1 }));
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
    for (let index = 0; index < 10; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "audio.append", audio, atMs: index }));
    }
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatchObject({ leaseId: "lease-1", inputAudioSeconds: 1 });

    clock.time = 11_000;
    const ticking = relay.tick();
    for (let index = 0; index < 10 && !resolveRenew; index += 1) await Promise.resolve();
    clock.time = 15_000;
    expect(resolveRenew).toBeDefined();
    resolveRenew!({ leaseId: "lease-2", expiresAtMs: 25_000, maxInputAudioMs: 10_000 });
    await ticking;
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(host.peer.events.some(event => event.type === "error" && event.code === "INTERNAL")).toBe(true);
    await relay.dispose();
  });

  it("applies durable Authority host-absence pause/end and stops sources", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const baseSync = testAuthority.syncPresence.bind(testAuthority);
    let hostLastSeen = clock.now();
    testAuthority.syncPresence = async input => {
      if (input.participants.some(participant => participant.participantId === "host-ja")) {
        hostLastSeen = clock.now();
      } else if (clock.now() - hostLastSeen >= 120_000) {
        testAuthority.roomState = "ended";
      } else if (clock.now() - hostLastSeen >= 30_000) {
        testAuthority.roomState = "paused";
      }
      return baseSync(input);
    };
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const guest = connected.get("guest-en")!;
    await relay.receive("r", "e", "guest-en", guest.generation, JSON.stringify({
      v: 1,
      type: "speech.start",
      atMs: 1,
    }));
    expect(factory.sessions).toHaveLength(1);
    const host = connected.get("host-ja")!;
    await relay.peerClosed("r", "e", "host-ja", host.generation);

    clock.time = 31_000;
    await relay.receive("r", "e", "guest-en", guest.generation, JSON.stringify({ v: 1, type: "client.ping" }));
    await relay.tick();
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(guest.peer.events.filter(event => event.type === "room.state").at(-1)).toMatchObject({ paused: true });

    clock.time = 121_000;
    await relay.receive("r", "e", "guest-en", guest.generation, JSON.stringify({ v: 1, type: "client.ping" }));
    await relay.tick();
    expect(guest.peer.closed).toEqual([1000, "room-ended"]);
    await relay.dispose();
  });

  it("rejects a third participant at the relay boundary", async () => {
    const relay = new RelayOrchestrator(verifier, authority(), new Factory(), new Clock());
    expect(await relay.connect("Bearer host-ja", new Peer())).toBeDefined();
    expect(await relay.connect("Bearer guest-en", new Peer())).toBeDefined();
    const thirdPeer = new Peer();
    expect(await relay.connect("Bearer third-en", thirdPeer)).toBeUndefined();
    expect(thirdPeer.events).toContainEqual(expect.objectContaining({ v: 1, type: "error", code: "ROOM_FULL", fatal: true }));
    expect(thirdPeer.closed).toEqual([1008, "ROOM_FULL"]);
    await relay.dispose();
  });

  it("closes revoked admissions on presence sync", async () => {
    const clock = new Clock();
    const testAuthority = authority();
    const relay = new RelayOrchestrator(verifier, testAuthority, new Factory(), clock);
    const connected = await readyAndStart(relay);
    const guest = connected.get("guest-en")!;
    testAuthority.revoked.add(testAuthority.grants.get("guest-en")!);
    clock.time += 5_000;
    await relay.tick();
    expect(guest.peer.closed).toEqual([4003, "admission-revoked"]);
    await relay.dispose();
  });

  it("fails capture closed on sync error until explicit resume succeeds", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "speech.start", atMs: 1 }));
    expect(factory.sessions).toHaveLength(1);

    testAuthority.failSync = true;
    clock.time += 5_000;
    await relay.tick();
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(host.peer.events.filter(event => event.type === "route").at(-1)).toMatchObject({ canCapture: false, reason: "blocked" });

    testAuthority.failSync = false;
    clock.time += 5_000;
    await relay.tick();
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "speech.start", atMs: 2 }));
    expect(factory.sessions).toHaveLength(1);
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.resume" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "speech.start", atMs: 3 }));
    expect(factory.sessions).toHaveLength(2);
    await relay.dispose();
  });

  it("disconnects at the 15-second ping deadline even when presence sync consumes five seconds", async () => {
    const clock = new Clock();
    const testAuthority = authority();
    const originalSync = testAuthority.syncPresence.bind(testAuthority);
    const relay = new RelayOrchestrator(verifier, testAuthority, new Factory(), clock);
    const hostPeer = new Peer();
    const host = await relay.connect("Bearer host-ja", hostPeer);
    testAuthority.syncPresence = async input => {
      clock.time += 5_000;
      return originalSync(input);
    };
    clock.time = 11_000;
    await relay.tick();
    expect(hostPeer.closed).toEqual([4008, "client-ping-timeout"]);
    expect(host).toBeDefined();
    await relay.dispose();
  });

  it("keeps a one-hour silent connection alive with five-second application pings", async () => {
    const clock = new Clock();
    const relay = new RelayOrchestrator(verifier, authority(), new Factory(), clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const guest = connected.get("guest-en")!;
    for (let step = 0; step < 60 * 60 / 5; step += 1) {
      clock.time += 5_000;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "client.ping" }));
      await relay.receive("r", "e", "guest-en", guest.generation, JSON.stringify({ v: 1, type: "client.ping" }));
      await relay.tick();
      await acknowledgeLatest(relay, "host-ja", host.generation, host.peer);
      await acknowledgeLatest(relay, "guest-en", guest.generation, guest.peer);
    }
    expect(host.peer.closed).toBeUndefined();
    expect(guest.peer.closed).toBeUndefined();
    await relay.dispose();
  });

  it("rejects an old admission grant even when a restarted relay reuses generation one", async () => {
    const clock = new Clock();
    const testAuthority = authority();
    const firstRelay = new RelayOrchestrator(verifier, testAuthority, new Factory(), clock);
    const firstPeer = new Peer();
    const first = await firstRelay.connect("Bearer host-ja", firstPeer);
    await firstRelay.receive("r", "e", "host-ja", first!.generation, JSON.stringify({ v: 1, type: "client.ready" }));

    const restartedRelay = new RelayOrchestrator(verifier, testAuthority, new Factory(), clock);
    const restartedPeer = new Peer();
    const restarted = await restartedRelay.connect("Bearer host-ja#after-restart", restartedPeer);
    expect(restarted!.generation).toBe(1);
    await restartedRelay.receive("r", "e", "host-ja", restarted!.generation, JSON.stringify({ v: 1, type: "client.ready" }));

    await firstRelay.receive("r", "e", "host-ja", first!.generation, JSON.stringify({ v: 1, type: "room.start" }));
    expect(firstPeer.events.some(event => event.type === "error" && event.code === "INTERNAL")).toBe(true);
    expect(firstPeer.events.filter(event => event.type === "route").at(-1)).toMatchObject({
      canCapture: false,
      reason: "blocked",
    });
    await firstRelay.dispose();
    await restartedRelay.dispose();
  });

  it("bounds validated receiver operations while Authority control is stalled", async () => {
    const testAuthority = authority();
    let releaseControl: (() => void) | undefined;
    testAuthority.controlRoom = async context => {
      await new Promise<void>(resolve => { releaseControl = resolve; });
      testAuthority.roomState = context.action === "start" ? "active" : testAuthority.roomState;
      return { roomEpoch: context.roomEpoch, state: testAuthority.roomState };
    };
    const relay = new RelayOrchestrator(verifier, testAuthority, new Factory(), new Clock());
    const connected = await readyAndStartWithoutStart(relay);
    const host = connected.get("host-ja")!;
    const operations = [relay.receive(
      "r", "e", "host-ja", host.generation,
      JSON.stringify({ v: 1, type: "room.start" }),
    )];
    await vi.waitFor(() => expect(releaseControl).toBeDefined());
    for (let index = 0; index < MAX_PENDING_CLIENT_OPERATIONS; index += 1) {
      operations.push(relay.receive(
        "r", "e", "host-ja", host.generation,
        JSON.stringify({ v: 1, type: index % 2 === 0 ? "capture.pause" : "capture.resume" }),
      ));
    }
    expect(host.peer.closed).toEqual([4009, "client-operation-backpressure"]);
    releaseControl!();
    await Promise.all(operations);
    expect(host.peer.events.some(event => event.type === "room.state" && event.active)).toBe(false);
    await relay.dispose();
  });

  it("never opens a provider when the peer exits during lease acquisition", async () => {
    const testAuthority = authority();
    let releaseLease: ((lease: BudgetLease) => void) | undefined;
    testAuthority.acquireLease = async () => new Promise<BudgetLease>(resolve => { releaseLease = resolve; });
    const factory = new Factory();
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, new Clock());
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const input = relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "speech.start", atMs: 1,
    }));
    await vi.waitFor(() => expect(releaseLease).toBeDefined());
    const closing = relay.peerClosed("r", "e", "host-ja", host.generation);
    releaseLease!({ leaseId: "closing-lease", expiresAtMs: 15_000, maxInputAudioMs: 15_000 });
    await Promise.all([input, closing]);
    expect(factory.sessions).toHaveLength(0);
    await relay.dispose();
  });

  it.each([
    { maximumMs: 200, advanceMs: 100 },
    { maximumMs: 15_000, advanceMs: 0 },
  ])("keeps the same lease quota and pacing through capture pauses: $maximumMs/$advanceMs", async ({ maximumMs, advanceMs }) => {
    const testAuthority = authority();
    testAuthority.acquireLease = async () => ({
      leaseId: "idempotent-active-lease", expiresAtMs: 16_000, maxInputAudioMs: maximumMs,
    });
    const clock = new Clock();
    const factory = new Factory();
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    for (let index = 0; index < 3; index += 1) {
      if (index > 0) {
        await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.pause" }));
        clock.time += advanceMs;
        await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.resume" }));
      }
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", atMs: clock.now(), audio: Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64"),
      }));
    }
    expect(factory.sessions.reduce((sum, value) => sum + value.appends.length, 0)).toBe(2);
    expect(host.peer.events.some(event => event.type === "error" && event.code === "AUDIO_LIMIT")).toBe(true);
    await relay.dispose();
  });

  it("closes an unacknowledging listener and stops its source provider", async () => {
    const factory = new Factory();
    const relay = new RelayOrchestrator(verifier, authority(), factory, new Clock());
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const guest = connected.get("guest-en")!;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "speech.start", atMs: 1,
    }));
    expect(factory.sessions).toHaveLength(1);
    for (let index = 0; index < 140; index += 1) {
      factory.sessions[0]!.sink.onOutputTranscript(`delta-${index}`);
    }
    await relay.tick();
    expect(guest.peer.closed).toEqual([4009, "delivery-backpressure"]);
    expect(factory.sessions[0]!.closed).toBe(true);
    await relay.dispose();
  });
});

async function readyAndStartWithoutStart(
  relay: RelayOrchestrator,
): Promise<Map<string, { peer: Peer; generation: number }>> {
  const result = new Map<string, { peer: Peer; generation: number }>();
  for (const participant of ["host-ja", "guest-en"]) {
    const peer = new Peer();
    const identity = await relay.connect(`Bearer ${participant}#bounded`, peer);
    result.set(participant, { peer, generation: identity!.generation });
  }
  for (const [participant, value] of result) {
    await relay.receive("r", "e", participant, value.generation, JSON.stringify({ v: 1, type: "client.ready" }));
    await acknowledgeLatest(relay, participant, value.generation, value.peer);
  }
  return result;
}
