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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
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
  it("blocks on provider loss until explicit resume and drops the old provider tail", async () => {
    const factory = new Factory();
    const testAuthority = authority();
    const acquire = vi.spyOn(testAuthority, "acquireLease");
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, new Clock());
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const guest = connected.get("guest-en")!;
    const send = (type: string, rest = {}) => relay.receive("r", "e", "host-ja", host.generation,
      JSON.stringify({ v: 1, type, ...rest }));
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
    await send("audio.append", { audio, atMs: 0 });
    const old = factory.sessions[0]!;
    old.sink.onFatal("PROVIDER_TRANSPORT");
    await relay.tick();
    expect(host.peer.events.some(event => event.type === "error" && event.code === "PROVIDER_ERROR")).toBe(true);
    expect(old.closed).toBe(true);
    await send("audio.append", { audio, atMs: 0 });
    expect(acquire).toHaveBeenCalledTimes(1);
    await send("capture.resume");
    await send("audio.append", { audio, atMs: 0 });
    expect(acquire).toHaveBeenCalledTimes(2);
    const count = guest.peer.events.filter(event => event.type === "audio").length;
    old.sink.onOutputAudio(audio);
    await relay.tick();
    expect(guest.peer.events.filter(event => event.type === "audio")).toHaveLength(count);
    await relay.dispose();
  });

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
    await flushAsync();
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(host.peer.events.some(event => event.type === "error" && event.code === "LEASE_EXPIRED")).toBe(true);
    await relay.dispose();
  });

  it("keeps audio and provider output flowing while a usage report is deferred", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const reportGate = deferred<void>();
    const usage: UsageEvent[] = [];
    testAuthority.reportUsage = async event => {
      usage.push(event);
      await reportGate.promise;
    };
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const guest = connected.get("guest-en")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");

    for (let index = 0; index < 10; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: 0,
      }));
    }
    expect(usage).toHaveLength(1);
    for (let index = 0; index < 3; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: 0,
      }));
    }
    factory.sessions[0]!.sink.onOutputAudio(audio);
    await relay.tick();

    expect(factory.sessions[0]!.appends).toHaveLength(13);
    expect(guest.peer.events.some(event => event.type === "audio")).toBe(true);
    expect(host.peer.events.some(event => event.type === "error" && event.code === "AUDIO_LIMIT")).toBe(false);
    reportGate.resolve();
    await flushAsync();
    await relay.dispose();
  });

  it("uses relay receive time when initial lease acquisition queues normal audio", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const leaseGate = deferred<BudgetLease>();
    testAuthority.acquireLease = () => leaseGate.promise;
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
    const operations: Promise<void>[] = [];

    for (let index = 0; index < 3; index += 1) {
      clock.time += 100;
      operations.push(relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: 0,
      })));
    }
    await flushAsync();
    leaseGate.resolve({ leaseId: "delayed-initial", expiresAtMs: 15_000, maxInputAudioMs: 15_000 });
    await Promise.all(operations);

    expect(factory.sessions[0]!.appends).toHaveLength(3);
    expect(host.peer.events.some(event => event.type === "error" && event.code === "AUDIO_LIMIT")).toBe(false);
    await relay.dispose();
  });

  it("reports exact per-lease snapshots single-flight and fails closed on report failure", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const gates = [deferred<void>(), deferred<void>()];
    const usage: UsageEvent[] = [];
    testAuthority.reportUsage = async event => {
      const index = usage.push(event) - 1;
      await gates[index]!.promise;
    };
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");

    for (let index = 0; index < 20; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: clock.now(),
      }));
    }
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ leaseId: "lease-1", inputAudioSeconds: 1 });
    gates[0]!.resolve();
    await flushAsync();
    expect(usage).toHaveLength(2);
    expect(usage[1]).toMatchObject({ leaseId: "lease-1", inputAudioSeconds: 1 });

    gates[1]!.reject(new Error("synthetic report failure"));
    await flushAsync();
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(host.peer.events.filter(event => event.type === "route").at(-1)).toMatchObject({
      canCapture: false,
      reason: "blocked",
    });
    const sessionCount = factory.sessions.length;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "audio.append", audio, atMs: clock.now(),
    }));
    expect(factory.sessions).toHaveLength(sessionCount);
    await relay.dispose();
  });

  it("quarantines an indeterminate usage snapshot until Authority grants a new lease id", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    let grantedLeaseId = "uncertain-lease";
    const acquire = vi.fn(async () => ({
      leaseId: grantedLeaseId,
      expiresAtMs: 15_000,
      maxInputAudioMs: 15_000,
    }));
    const usage: UsageEvent[] = [];
    testAuthority.acquireLease = acquire;
    testAuthority.reportUsage = async event => {
      usage.push(event);
      throw new Error("response lost after Authority applied usage");
    };
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");

    for (let index = 0; index < 10; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: clock.now(),
      }));
    }
    await flushAsync();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ leaseId: "uncertain-lease", inputAudioSeconds: 1 });
    expect(factory.sessions[0]!.closed).toBe(true);

    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.resume" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "audio.append", audio, atMs: clock.now(),
    }));
    await flushAsync();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(usage).toHaveLength(1);
    expect(factory.sessions).toHaveLength(1);

    grantedLeaseId = "replacement-lease";
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.resume" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "audio.append", audio, atMs: clock.now(),
    }));
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(factory.sessions).toHaveLength(2);
    expect(factory.sessions[1]!.appends).toHaveLength(1);
    expect(usage).toHaveLength(1);
    await relay.dispose();
  });

  it("final-drains sub-threshold usage after an in-flight snapshot without disturbing a resumed source", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const gates = [deferred<void>(), deferred<void>()];
    const usage: UsageEvent[] = [];
    let activeReports = 0;
    let maximumActiveReports = 0;
    testAuthority.reportUsage = async event => {
      const index = usage.push(event) - 1;
      activeReports += 1;
      maximumActiveReports = Math.max(maximumActiveReports, activeReports);
      await gates[index]!.promise;
      activeReports -= 1;
    };
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");

    for (let index = 0; index < 13; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: clock.now(),
      }));
    }
    expect(usage).toHaveLength(1);
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.pause" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.resume" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "speech.start", atMs: clock.now(),
    }));
    expect(factory.sessions).toHaveLength(2);

    gates[0]!.resolve();
    await flushAsync();
    expect(usage).toHaveLength(2);
    expect(usage.map(event => event.inputAudioSeconds)).toEqual([1, 0.3]);
    expect(factory.sessions[1]!.closed).toBe(false);
    gates[1]!.resolve();
    await flushAsync();
    expect(usage.reduce((sum, event) => sum + event.inputAudioSeconds, 0)).toBeCloseTo(1.3);
    expect(maximumActiveReports).toBe(1);
    expect(factory.sessions[1]!.closed).toBe(false);
    await relay.dispose();
  });

  it("continues during deferred presence and renew, but never revives an expired lease", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const presenceGate = deferred<ReturnType<TestAuthority["syncPresence"]> extends Promise<infer T> ? T : never>();
    const renewGate = deferred<BudgetLease>();
    const originalSync = testAuthority.syncPresence.bind(testAuthority);
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const guest = connected.get("guest-en")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");

    testAuthority.syncPresence = () => presenceGate.promise;
    clock.time = 6_000;
    await relay.tick();
    clock.time += 100;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "audio.append", audio, atMs: 0,
    }));
    factory.sessions[0]!.sink.onOutputAudio(audio);
    await relay.tick();
    expect(guest.peer.events.some(event => event.type === "audio")).toBe(true);
    expect(factory.sessions[0]!.closed).toBe(false);
    presenceGate.resolve(await originalSync({
      roomId: "r",
      roomEpoch: "e",
      participants: [
        { participantId: "host-ja", admissionId: testAuthority.grants.get("host-ja")!, generation: host.generation, ready: true },
        { participantId: "guest-en", admissionId: testAuthority.grants.get("guest-en")!, generation: guest.generation, ready: true },
      ],
    }));
    await flushAsync();

    testAuthority.syncPresence = originalSync;
    testAuthority.renewLease = () => renewGate.promise;
    clock.time = 11_000;
    await relay.tick();
    clock.time = 11_100;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "audio.append", audio, atMs: 0,
    }));
    expect(factory.sessions[0]!.appends).toHaveLength(2);

    clock.time = 15_000;
    await relay.tick();
    expect(factory.sessions[0]!.closed).toBe(true);
    renewGate.resolve({ leaseId: "late-lease", expiresAtMs: 25_000, maxInputAudioMs: 15_000 });
    await flushAsync();
    expect(factory.sessions).toHaveLength(1);
    expect(host.peer.events.filter(event => event.type === "route").at(-1)).toMatchObject({
      canCapture: false,
      reason: "blocked",
    });
    await relay.dispose();
  });

  it("preserves one ledger when renewal returns the same lease id", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const usageGate = deferred<void>();
    const renewGate = deferred<BudgetLease>();
    const usage: UsageEvent[] = [];
    testAuthority.acquireLease = async () => ({
      leaseId: "continuing-lease", expiresAtMs: 15_000, maxInputAudioMs: 800,
    });
    const renew = vi.fn(() => renewGate.promise);
    testAuthority.renewLease = renew;
    testAuthority.reportUsage = async event => {
      usage.push(event);
      if (usage.length === 1) await usageGate.promise;
    };
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");

    for (let index = 0; index < 5; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: 0,
      }));
    }
    clock.time = 11_000;
    await relay.tick();
    await flushAsync();
    for (let index = 0; index < 3; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: 0,
      }));
    }
    usageGate.resolve();
    await flushAsync();
    expect(renew).toHaveBeenCalledTimes(1);
    renewGate.resolve({ leaseId: "continuing-lease", expiresAtMs: 25_000, maxInputAudioMs: 800 });
    await flushAsync();

    clock.time += 100;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "audio.append", audio, atMs: 0,
    }));
    await flushAsync();
    expect(usage.map(event => event.inputAudioSeconds)).toEqual([0.6, 0.2]);
    expect(usage.reduce((sum, event) => sum + event.inputAudioSeconds, 0)).toBeCloseTo(0.8);
    expect(host.peer.events.some(event => event.type === "error" && event.code === "AUDIO_LIMIT")).toBe(true);
    await relay.dispose();
  });

  it("renews during continuous slow usage and drains old and new lease ledgers separately", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const renewGate = deferred<BudgetLease>();
    const reportGates: Array<ReturnType<typeof deferred<void>>> = [];
    const usage: UsageEvent[] = [];
    let activeUsage = 0;
    let maximumActiveUsage = 0;
    let renewCalledAt: number | undefined;
    const renew = vi.fn(() => {
      renewCalledAt = clock.now();
      return renewGate.promise;
    });
    testAuthority.renewLease = renew;
    testAuthority.reportUsage = async event => {
      usage.push(event);
      const gate = deferred<void>();
      reportGates.push(gate);
      activeUsage += 1;
      maximumActiveUsage = Math.max(maximumActiveUsage, activeUsage);
      await gate.promise;
      activeUsage -= 1;
    };
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
    let releasedReports = 0;

    for (let index = 0; index < 90; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: clock.now(),
      }));
      const current = usage.at(-1);
      if (
        current
        && releasedReports < reportGates.length
        && clock.now() - current.atMs >= 300
      ) {
        reportGates[releasedReports]!.resolve();
        releasedReports += 1;
        await flushAsync();
      }
    }
    expect(clock.now()).toBe(10_000);
    expect(reportGates.length).toBeGreaterThan(releasedReports);
    await relay.tick();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renewCalledAt).toBe(10_000);

    for (let index = 0; index < 3; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: clock.now(),
      }));
    }
    renewGate.resolve({ leaseId: "lease-2", expiresAtMs: 25_000, maxInputAudioMs: 15_000 });
    await flushAsync();
    reportGates[releasedReports]!.resolve();
    releasedReports += 1;
    await flushAsync();
    expect(usage.at(-1)).toMatchObject({ leaseId: "lease-1", inputAudioSeconds: 0.3 });
    reportGates[releasedReports]!.resolve();
    releasedReports += 1;
    await flushAsync();

    for (let index = 0; index < 10; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: clock.now(),
      }));
    }
    expect(usage.at(-1)?.leaseId).toBe("lease-2");
    reportGates[releasedReports]!.resolve();
    await flushAsync();

    expect(usage.filter(event => event.leaseId === "lease-1")
      .reduce((sum, event) => sum + event.inputAudioSeconds, 0)).toBeCloseTo(9.3);
    expect(usage.filter(event => event.leaseId === "lease-2")
      .reduce((sum, event) => sum + event.inputAudioSeconds, 0)).toBeCloseTo(1);
    expect(maximumActiveUsage).toBe(1);
    expect(clock.now()).toBeLessThan(15_000);
    await relay.dispose();
  });

  it("fails closed when an old-lease usage result becomes indeterminate after renewal", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const usageGate = deferred<void>();
    const renewGate = deferred<BudgetLease>();
    testAuthority.reportUsage = () => usageGate.promise;
    testAuthority.renewLease = () => renewGate.promise;
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");

    for (let index = 0; index < 10; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: clock.now(),
      }));
    }
    clock.time = 10_000;
    await relay.tick();
    renewGate.resolve({ leaseId: "lease-2", expiresAtMs: 25_000, maxInputAudioMs: 15_000 });
    await flushAsync();
    expect(factory.sessions[0]!.closed).toBe(false);

    usageGate.reject(new Error("old lease usage outcome unknown"));
    await flushAsync();
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(host.peer.events.filter(event => event.type === "route").at(-1)).toMatchObject({
      canCapture: false,
      reason: "blocked",
    });
    await relay.dispose();
  });

  it("drops provider audio and captions at the lease expiry boundary before tick", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const relay = new RelayOrchestrator(verifier, authority(), factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const guest = connected.get("guest-en")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "audio.append", audio, atMs: clock.now(),
    }));
    const guestAudioBefore = guest.peer.events.filter(event => event.type === "audio").length;
    const guestCaptionsBefore = guest.peer.events.filter(event => event.type === "caption.delta").length;
    const hostCaptionsBefore = host.peer.events.filter(event => event.type === "caption.delta").length;

    clock.time = 15_000;
    factory.sessions[0]!.sink.onOutputAudio(audio);
    factory.sessions[0]!.sink.onOutputTranscript("expired translation");
    factory.sessions[0]!.sink.onInputTranscript("expired source");
    await flushAsync();

    expect(guest.peer.events.filter(event => event.type === "audio")).toHaveLength(guestAudioBefore);
    expect(guest.peer.events.filter(event => event.type === "caption.delta")).toHaveLength(guestCaptionsBefore);
    expect(host.peer.events.filter(event => event.type === "caption.delta")).toHaveLength(hostCaptionsBefore);
    expect(factory.sessions[0]!.closed).toBe(false);
    await relay.dispose();
  });

  it("fences late usage and renew completions from a resumed source", async () => {
    const clock = new Clock();
    const factory = new Factory();
    const testAuthority = authority();
    const usageGate = deferred<void>();
    const renewGate = deferred<BudgetLease>();
    let leaseNumber = 0;
    testAuthority.acquireLease = async () => ({
      leaseId: `source-lease-${++leaseNumber}`,
      expiresAtMs: 15_000,
      maxInputAudioMs: 15_000,
    });
    testAuthority.reportUsage = async () => usageGate.promise;
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");

    for (let index = 0; index < 10; index += 1) {
      clock.time += 100;
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
        v: 1, type: "audio.append", audio, atMs: 0,
      }));
    }
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.pause" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.resume" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "audio.append", audio, atMs: 0 }));
    expect(factory.sessions).toHaveLength(2);
    usageGate.reject(new Error("old usage failed"));
    await flushAsync();
    expect(factory.sessions[1]!.closed).toBe(false);

    testAuthority.reportUsage = async () => {};
    testAuthority.renewLease = () => renewGate.promise;
    clock.time = 11_000;
    await relay.tick();
    await flushAsync();
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.pause" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "capture.resume" }));
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type: "audio.append", audio, atMs: 0 }));
    const currentSession = factory.sessions.at(-1)!;
    renewGate.resolve({ leaseId: "stale-renew", expiresAtMs: 25_000, maxInputAudioMs: 15_000 });
    await flushAsync();
    expect(currentSession.closed).toBe(false);
    await relay.dispose();
  });

  it("does not let a late presence result override newer host controls", async () => {
    const clock = new Clock();
    const testAuthority = authority();
    const factory = new Factory();
    const relay = new RelayOrchestrator(verifier, testAuthority, factory, clock);
    const connected = await readyAndStart(relay);
    const host = connected.get("host-ja")!;
    const audio = Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "audio.append", audio, atMs: 0,
    }));
    const presenceGate = deferred<Awaited<ReturnType<Authority["syncPresence"]>>>();
    testAuthority.syncPresence = () => presenceGate.promise;
    clock.time = 6_000;
    await relay.tick();
    for (const type of ["room.pause", "room.resume"]) {
      await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({ v: 1, type }));
    }
    clock.time = 6_100;
    await relay.receive("r", "e", "host-ja", host.generation, JSON.stringify({
      v: 1, type: "audio.append", audio, atMs: 0,
    }));
    const currentSession = factory.sessions.at(-1)!;
    expect(currentSession.closed).toBe(false);
    presenceGate.resolve({
      roomEpoch: "e",
      state: "paused",
      allowedAdmissionIds: [...testAuthority.grants.values()],
    });
    await flushAsync();
    expect(currentSession.closed).toBe(false);
    expect(host.peer.events.filter(event => event.type === "room.state").at(-1)).toMatchObject({ paused: false });
    await relay.dispose();
  });

  it("does not apply a late presence result to a replacement admission", async () => {
    const clock = new Clock();
    const testAuthority = authority();
    const originalSync = testAuthority.syncPresence.bind(testAuthority);
    const presenceGate = deferred<Awaited<ReturnType<Authority["syncPresence"]>>>();
    let presenceCalls = 0;
    testAuthority.syncPresence = input => {
      presenceCalls += 1;
      return presenceCalls === 5 ? presenceGate.promise : originalSync(input);
    };
    const relay = new RelayOrchestrator(verifier, testAuthority, new Factory(), clock);
    const connected = await readyAndStart(relay);
    clock.time = 6_000;
    await relay.tick();
    expect(presenceCalls).toBe(5);
    const replacementPeer = new Peer();
    const replacing = relay.connect("Bearer host-ja#late-presence", replacementPeer);
    await flushAsync();
    presenceGate.resolve({
      roomEpoch: "e",
      state: "paused",
      allowedAdmissionIds: [testAuthority.grants.get("guest-en")!],
    });
    const replacement = await replacing;
    expect(replacement).toBeDefined();
    await flushAsync();
    expect(replacementPeer.closed).toBeUndefined();
    expect(replacement!.generation).toBeGreaterThan(connected.get("host-ja")!.generation);
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
    await flushAsync();
    expect(factory.sessions[0]!.closed).toBe(true);
    expect(guest.peer.events.filter(event => event.type === "room.state").at(-1)).toMatchObject({ paused: true });

    clock.time = 121_000;
    await relay.receive("r", "e", "guest-en", guest.generation, JSON.stringify({ v: 1, type: "client.ping" }));
    await relay.tick();
    await flushAsync();
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
    await flushAsync();
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
