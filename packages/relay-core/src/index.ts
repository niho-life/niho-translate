import {
  AUDIO_BYTES_PER_SAMPLE,
  AUDIO_SAMPLE_RATE,
  decodeInputPcmBase64,
  decodeOutputPcmBase64,
  isLanguage,
  validateClientEvent,
  type ClientEvent,
  type ErrorCode,
  type Language,
  type ParticipantRole,
  type RoomControlAction,
  type ServerEventPayload,
} from "../../protocol/src/index.ts";
import {
  ROOM_MAX_LIFETIME_MS,
  RoomActor,
  type Admission,
  type AuthorityRoomState,
  type RoomConfig,
} from "../../room-core/src/index.ts";
import type { ProviderSink } from "../../provider-openai/src/index.ts";
import { SerialDispatcher } from "./serial.ts";
import {
  BoundedDeliveryPeer,
  type ClientPeer,
} from "./delivery.ts";
import {
  MAX_TICKET_LIFETIME_MS,
  type TicketClaims,
  type TicketVerifier,
} from "./tickets.ts";
export {
  JoseTicketVerifier,
  type TicketAlgorithm,
  type TicketClaims,
  type TicketVerifier,
  type TicketVerifierConfig,
} from "./tickets.ts";
export {
  BoundedDeliveryPeer,
  MAX_UNACKNOWLEDGED_DELIVERY_BYTES,
  MAX_UNACKNOWLEDGED_DELIVERY_EVENTS,
  type ClientPeer,
} from "./delivery.ts";

const LEASE_MAX_LIFETIME_MS = 15_000;
const AUDIO_BURST_MS = 200;
const USAGE_BATCH_AUDIO_MS = 1_000;
const DEFAULT_AUTHORITY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ROOMS = 256;
const TOMBSTONE_TTL_MS = ROOM_MAX_LIFETIME_MS + MAX_TICKET_LIFETIME_MS;
const PRESENCE_SYNC_MS = 5_000;
const CLIENT_PING_TIMEOUT_MS = 15_000;
export const MAX_PENDING_CLIENT_OPERATIONS = 32;

export interface AuthorityAdmission {
  admissionId: string;
  role: ParticipantRole;
  sourceLanguage: Language;
  targetLanguage: Language;
  roomEpoch: string;
  roomState: AuthorityRoomState;
}

export interface BudgetLease {
  leaseId: string;
  expiresAtMs: number;
  maxInputAudioMs: number;
}

export interface UsageEvent {
  roomId: string;
  roomEpoch: string;
  participantId: string;
  admissionId: string;
  generation: number;
  leaseId: string;
  inputAudioSeconds: number;
  atMs: number;
}

export interface ControlRoomContext {
  roomId: string;
  roomEpoch: string;
  participantId: string;
  admissionId: string;
  generation: number;
  action: RoomControlAction;
  cause: "host" | "lifecycle";
}

export interface PresenceParticipant {
  participantId: string;
  admissionId: string;
  generation: number;
  ready: boolean;
}

export interface PresenceSyncRequest {
  roomId: string;
  roomEpoch: string;
  participants: PresenceParticipant[];
}

export interface PresenceSyncResponse {
  roomEpoch: string;
  state: AuthorityRoomState;
  allowedAdmissionIds: string[];
}

export interface Authority {
  /** admit must atomically consume ticket.jti in durable storage. */
  admit(ticket: Readonly<TicketClaims>): Promise<AuthorityAdmission>;
  controlRoom(context: Readonly<ControlRoomContext>): Promise<{ roomEpoch: string; state: AuthorityRoomState }>;
  syncPresence(input: Readonly<PresenceSyncRequest>): Promise<PresenceSyncResponse>;
  acquireLease(input: { roomId: string; roomEpoch: string; participantId: string; admissionId: string; generation: number }): Promise<BudgetLease>;
  renewLease(input: { leaseId: string; roomId: string; roomEpoch: string; participantId: string; admissionId: string; generation: number }): Promise<BudgetLease>;
  /** Must accept usage reserved under an old lease ID after renewLease grants a new ID. */
  reportUsage(event: UsageEvent): Promise<void>;
}

export interface TranslationSession {
  appendPcm(base64Pcm: string): boolean;
  close(timeoutMs?: number): Promise<void>;
}

export interface TranslationFactory {
  create(outputLanguage: Language, sink: ProviderSink): TranslationSession;
}

export interface RelayClock {
  now(): number;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RelayConfig {
  room: RoomConfig;
  authorityTimeoutMs?: number;
  maximumRooms?: number;
  tombstoneTtlMs?: number;
}

const DEFAULT_RELAY_CONFIG: RelayConfig = {
  room: { focusReleaseSilenceMs: 1_500, maxLifetimeMs: ROOM_MAX_LIFETIME_MS },
  authorityTimeoutMs: DEFAULT_AUTHORITY_TIMEOUT_MS,
  maximumRooms: DEFAULT_MAX_ROOMS,
  tombstoneTtlMs: TOMBSTONE_TTL_MS,
};

interface LeaseState {
  value: BudgetLease;
  inputAudioMs: number;
  availableAudioMs: number;
  lastAudioAtMs: number;
  reportedUsageMs: number;
  pendingUsageMs: number;
  inFlightUsageMs: number;
  usageInFlight?: Promise<boolean>;
  usageFailed: boolean;
  finalDrainThroughMs: number;
  lastUsageReportAtMs: number;
  renewInFlight: boolean;
}

interface Connection {
  peer: BoundedDeliveryPeer;
  room: RoomActor;
  admission: Admission;
  generation: number;
  admissionId: string;
  provider?: TranslationSession;
  providerToken: number;
  lease?: LeaseState;
  readonly leaseLedger: Map<string, LeaseState>;
  blocked: boolean;
  needsExplicitResume: boolean;
  lastPingAtMs: number;
  pendingClientOperations: number;
  dropIncoming: boolean;
}

export class RelayOrchestrator {
  private readonly rooms = new Map<string, RoomActor>();
  private readonly connections = new Map<string, Connection>();
  private readonly tombstones = new Map<string, number>();
  private readonly authorityStateByRoom = new Map<string, AuthorityRoomState>();
  private readonly lastPresenceSyncAtByRoom = new Map<string, number>();
  private readonly presenceInFlightByRoom = new Map<string, Promise<void>>();
  private readonly serial = new SerialDispatcher();
  private readonly timer: unknown;
  private readonly normalizedConfig: Required<Omit<RelayConfig, "room">> & { room: RoomConfig };
  private tickInFlight: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly tickets: TicketVerifier,
    private readonly authority: Authority,
    private readonly providers: TranslationFactory,
    private readonly clock: RelayClock = systemClock,
    config: RelayConfig = DEFAULT_RELAY_CONFIG,
  ) {
    const roomMaxLifetimeMs = config.room.maxLifetimeMs ?? ROOM_MAX_LIFETIME_MS;
    const requiredTombstoneTtlMs = roomMaxLifetimeMs + MAX_TICKET_LIFETIME_MS;
    const tombstoneTtlMs = config.tombstoneTtlMs ?? requiredTombstoneTtlMs;
    if (tombstoneTtlMs < requiredTombstoneTtlMs) throw new Error("TOMBSTONE_TTL_TOO_SHORT");
    this.normalizedConfig = {
      room: {
        focusReleaseSilenceMs: config.room.focusReleaseSilenceMs,
        maxLifetimeMs: roomMaxLifetimeMs,
      },
      authorityTimeoutMs: config.authorityTimeoutMs ?? DEFAULT_AUTHORITY_TIMEOUT_MS,
      maximumRooms: config.maximumRooms ?? DEFAULT_MAX_ROOMS,
      tombstoneTtlMs,
    };
    this.timer = clock.setInterval(() => {
      void this.tick();
    }, 1_000);
  }

  async connect(
    authorizationHeader: string | undefined,
    rawPeer: ClientPeer,
  ): Promise<{ roomId: string; roomEpoch: string; participantId: string; generation: number } | undefined> {
    let connected: Connection | undefined;
    const peer = new BoundedDeliveryPeer(rawPeer, () => {
      if (connected) this.beginDroppingIncoming(connected, "delivery-backpressure", false);
    });
    try {
      if (this.disposed || !authorizationHeader?.startsWith("Bearer ")) throw new Error("UNAUTHORIZED");
      const claims = await this.bounded(
        this.tickets.verify(authorizationHeader.slice(7), this.clock.now()),
        "TICKET_TIMEOUT",
      );
      const roomKey = this.roomKey(claims.roomId, claims.roomEpoch);
      return await this.serial.run(roomKey, async () => {
        this.pruneRooms(this.clock.now());
        if (this.tombstones.has(roomKey)) throw new Error("ROOM_ENDED");
        const authorityAdmission = await this.bounded(this.authority.admit(claims), "AUTHORITY_TIMEOUT");
        this.assertAdmission(authorityAdmission, claims);
        if (authorityAdmission.roomState === "ended") {
          this.markTombstone(roomKey, this.clock.now());
          throw new Error("ROOM_ENDED");
        }
        let room = this.rooms.get(roomKey);
        if (!room) {
          if (this.rooms.size >= this.normalizedConfig.maximumRooms) throw new Error("ROOM_LIMIT");
          room = new RoomActor(
            claims.roomId,
            claims.roomEpoch,
            copyRoomConfig(this.normalizedConfig.room),
            this.clock.now(),
          );
          room.restoreAuthorityState(authorityAdmission.roomState);
          this.rooms.set(roomKey, room);
        } else {
          room.restoreAuthorityState(authorityAdmission.roomState);
        }
        this.authorityStateByRoom.set(roomKey, authorityAdmission.roomState);
        const admission: Admission = {
          roomId: claims.roomId,
          participantId: claims.participantId,
          roomEpoch: claims.roomEpoch,
          role: authorityAdmission.role,
          sourceLanguage: authorityAdmission.sourceLanguage,
          targetLanguage: authorityAdmission.targetLanguage,
          admissionId: authorityAdmission.admissionId,
        };
        const result = room.admit(admission, this.clock.now());
        if (!result.ok) {
          if (result.code === "ROOM_ENDED") {
            this.markTombstone(roomKey, this.clock.now());
            await this.syncLifecycleState(roomKey, room);
          }
          const code: ErrorCode = result.code === "ROOM_FULL"
            ? "ROOM_FULL"
            : result.code === "ROOM_ENDED" ? "ROOM_ENDED" : "UNAUTHORIZED";
          peer.send({ v: 1, type: "error", code, fatal: true });
          peer.close(1008, result.code);
          return undefined;
        }
        const connectionKey = this.connectionKey(roomKey, claims.participantId);
        const old = this.connections.get(connectionKey);
        if (old) {
          await this.stopSource(old, "replaced");
          old.peer.close(4001, "replaced-by-new-generation");
        }
        const connection: Connection = {
          peer,
          room,
          admission,
          generation: result.generation,
          admissionId: authorityAdmission.admissionId,
          providerToken: 0,
          leaseLedger: new Map(),
          blocked: false,
          needsExplicitResume: false,
          lastPingAtMs: this.clock.now(),
          pendingClientOperations: 0,
          dropIncoming: false,
        };
        connected = connection;
        this.connections.set(connectionKey, connection);
        peer.send({
          v: 1,
          type: "session.identity",
          participantId: admission.participantId,
          generation: result.generation,
        });
        this.sendRoomState(connection);
        this.broadcastParticipants(room);
        this.broadcastRoutes(room);
        await this.syncPresence(roomKey, room, true);
        if (this.connections.get(connectionKey) !== connection || !room.isCurrent(
          claims.participantId,
          result.generation,
        )) {
          return undefined;
        }
        return {
          roomId: claims.roomId,
          roomEpoch: claims.roomEpoch,
          participantId: claims.participantId,
          generation: result.generation,
        };
      });
    } catch (error) {
      const ended = error instanceof Error && error.message === "ROOM_ENDED";
      if (!ended && !connected) {
        rawPeer.send({ v: 1, type: "error", code: "UNAUTHORIZED", fatal: true });
      } else {
        peer.send({ v: 1, type: "error", code: ended ? "ROOM_ENDED" : "UNAUTHORIZED", fatal: true });
      }
      peer.close(1008, ended ? "room-ended" : "unauthorized");
      return undefined;
    }
  }

  receive(
    roomId: string,
    roomEpoch: string,
    participantId: string,
    generation: number,
    raw: string | Uint8Array,
  ): Promise<void> {
    const roomKey = this.roomKey(roomId, roomEpoch);
    let parsed: ClientEvent;
    try {
      parsed = validateClientEvent(raw);
    } catch {
      const connection = this.getConnection(roomId, roomEpoch, participantId, generation);
      if (!connection || connection.dropIncoming) return Promise.resolve();
      return this.enqueueClientOperation(connection, roomKey, async () => {
        if (this.getConnection(roomId, roomEpoch, participantId, generation) !== connection) return;
        connection.peer.send({ v: 1, type: "error", code: "INVALID_MESSAGE", fatal: true });
        await this.disconnect(connection, 1008, "invalid-message");
      });
    }
    const connection = this.getConnection(roomId, roomEpoch, participantId, generation);
    if (!connection || connection.dropIncoming) return Promise.resolve();
    if (parsed.type === "client.ack") {
      if (!connection.peer.acknowledge(parsed.deliveryId)) {
        this.beginDroppingIncoming(connection, "invalid-delivery-ack");
      }
      return Promise.resolve();
    }
    if (parsed.type === "client.ping") {
      connection.lastPingAtMs = this.clock.now();
      return Promise.resolve();
    }
    const receivedAtMs = this.clock.now();
    return this.enqueueClientOperation(connection, roomKey, async () => {
      if (this.getConnection(roomId, roomEpoch, participantId, generation) !== connection) return;
      await this.handleClientEvent(connection, parsed, receivedAtMs);
    });
  }

  peerClosed(
    roomId: string,
    roomEpoch: string,
    participantId: string,
    generation: number,
  ): Promise<void> {
    const roomKey = this.roomKey(roomId, roomEpoch);
    const closing = this.getConnection(roomId, roomEpoch, participantId, generation);
    if (closing) closing.dropIncoming = true;
    return this.serial.run(roomKey, async () => {
      const connection = this.getConnection(roomId, roomEpoch, participantId, generation);
      if (connection) await this.disconnect(connection, 1000, "peer-closed", false);
    });
  }

  tick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    const operation = (async () => {
      const keys = [...this.rooms.keys()];
      await Promise.all(keys.map(key => this.serial.run(key, () => this.tickRoom(key))));
      this.pruneRooms(this.clock.now());
    })().finally(() => {
      this.tickInFlight = undefined;
    });
    this.tickInFlight = operation;
    return operation;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clock.clearInterval(this.timer);
    await Promise.all([...this.rooms.keys()].map(key => this.serial.run(key, async () => {
      const room = this.rooms.get(key);
      if (!room) return;
      for (const connection of this.connectionsForRoom(room)) {
        await this.disconnect(connection, 1001, "relay-shutdown");
      }
      room.terminate();
    })));
    this.rooms.clear();
    this.tombstones.clear();
    this.authorityStateByRoom.clear();
    this.lastPresenceSyncAtByRoom.clear();
    this.presenceInFlightByRoom.clear();
  }

  private async handleClientEvent(
    connection: Connection,
    event: ClientEvent,
    receivedAtMs = this.clock.now(),
  ): Promise<void> {
    const nowMs = this.clock.now();
    const { participantId, roomId, roomEpoch } = connection.admission;
    switch (event.type) {
      case "client.ready":
        connection.room.markReady(participantId, connection.generation);
        this.broadcastParticipants(connection.room);
        this.broadcastRoutes(connection.room);
        await this.syncPresence(this.roomKey(roomId, roomEpoch), connection.room, true);
        return;
      case "client.ping":
        return;
      case "capture.pause":
        connection.room.setCapturePaused(participantId, connection.generation, true);
        await this.stopSource(connection, "capture-paused");
        this.broadcastParticipants(connection.room);
        this.sendRoute(connection);
        return;
      case "capture.resume":
        await this.stopSource(connection, "explicit-resume");
        connection.room.setCapturePaused(participantId, connection.generation, false);
        connection.needsExplicitResume = false;
        connection.blocked = false;
        if (!await this.syncPresence(this.roomKey(roomId, roomEpoch), connection.room, true)) {
          return;
        }
        this.broadcastParticipants(connection.room);
        this.sendRoute(connection);
        return;
      case "room.start":
      case "room.pause":
      case "room.resume":
      case "room.end":
        await this.handleRoomControl(connection, event.type.slice(5) as RoomControlAction);
        return;
      case "speech.start":
        if (connection.room.startSpeech(participantId, connection.generation, nowMs)) {
          await this.ensureSource(connection);
        }
        return;
      case "speech.end":
        connection.room.endSpeech(participantId, connection.generation, nowMs);
        return;
      case "audio.append": {
        if (!connection.room.canCapture(participantId, connection.generation) || connection.blocked) {
          this.sendRoute(connection);
          return;
        }
        await this.ensureSource(connection);
        if (connection.dropIncoming) return;
        const currentNow = receivedAtMs;
        const processedAtMs = this.clock.now();
        if (
          !connection.provider
          || !connection.lease
          || connection.lease.value.expiresAtMs <= processedAtMs
        ) {
          await this.blockSource(connection, "lease-unavailable", "LEASE_EXPIRED");
          return;
        }
        const bytes = decodeInputPcmBase64(event.audio);
        const audioMs = bytes.byteLength * 1_000 / (AUDIO_SAMPLE_RATE * AUDIO_BYTES_PER_SAMPLE);
        if (!this.consumeLeaseAudio(connection.lease, audioMs, currentNow)) {
          await this.blockSource(connection, "audio-limit", "AUDIO_LIMIT");
          return;
        }
        if (!connection.provider.appendPcm(event.audio)) {
          await this.blockSource(connection, "provider-rejected", "BACKPRESSURE");
          return;
        }
        connection.lease.pendingUsageMs += audioMs;
        if (
          connection.lease.pendingUsageMs >= USAGE_BATCH_AUDIO_MS
          || currentNow - connection.lease.lastUsageReportAtMs >= 1_000
        ) {
          this.startUsageReport(connection, connection.lease, connection.providerToken);
        }
        return;
      }
    }
  }

  private async handleRoomControl(connection: Connection, action: RoomControlAction): Promise<void> {
    if (connection.admission.role !== "host") {
      connection.peer.send({ v: 1, type: "error", code: "UNAUTHORIZED", fatal: false });
      return;
    }
    if (!connection.room.canControl(
      connection.admission.participantId,
      connection.generation,
      action,
    )) {
      connection.peer.send({ v: 1, type: "error", code: "NOT_READY", fatal: false });
      return;
    }
    // A presence snapshot taken before this control must not overwrite its result.
    this.presenceInFlightByRoom.delete(
      this.roomKey(connection.admission.roomId, connection.admission.roomEpoch),
    );
    let response: { roomEpoch: string; state: AuthorityRoomState };
    try {
      response = await this.bounded(this.authority.controlRoom({
        roomId: connection.admission.roomId,
        roomEpoch: connection.admission.roomEpoch,
        participantId: connection.admission.participantId,
        admissionId: connection.admissionId,
        generation: connection.generation,
        action,
        cause: "host",
      }), "AUTHORITY_TIMEOUT");
      this.assertControlResponse(response, connection.admission.roomEpoch, action);
    } catch {
      await this.failClosedForAuthority(connection.room);
      return;
    }
    if (connection.dropIncoming) return;
    if (!connection.room.applyControl(
      connection.admission.participantId,
      connection.generation,
      action,
      this.clock.now(),
    )) {
      connection.peer.send({ v: 1, type: "error", code: "NOT_READY", fatal: false });
      return;
    }
    if (action === "pause" || action === "end") {
      for (const item of this.connectionsForRoom(connection.room)) {
        await this.stopSource(item, `room-${action}`);
      }
    }
    if (action === "end") {
      const key = this.roomKey(connection.admission.roomId, connection.admission.roomEpoch);
      this.markTombstone(key, this.clock.now());
    }
    this.authorityStateByRoom.set(
      this.roomKey(connection.admission.roomId, connection.admission.roomEpoch),
      response.state,
    );
    this.broadcastRoomState(connection.room);
    this.broadcastParticipants(connection.room);
    this.broadcastRoutes(connection.room);
    if (action === "end") {
      for (const item of this.connectionsForRoom(connection.room)) {
        await this.disconnect(item, 1000, "room-ended");
      }
    }
  }

  private async ensureSource(connection: Connection): Promise<void> {
    if (
      connection.provider
      || connection.blocked
      || connection.dropIncoming
      || !connection.room.canCapture(connection.admission.participantId, connection.generation)
    ) {
      return;
    }
    try {
      const acquiredAt = this.clock.now();
      const lease = await this.bounded(this.authority.acquireLease({
        roomId: connection.admission.roomId,
        roomEpoch: connection.admission.roomEpoch,
        participantId: connection.admission.participantId,
        admissionId: connection.admissionId,
        generation: connection.generation,
      }), "AUTHORITY_TIMEOUT");
      this.assertLease(lease, this.clock.now());
      if (
        !connection.room.isCurrent(connection.admission.participantId, connection.generation)
        || !connection.room.canCapture(connection.admission.participantId, connection.generation)
        || connection.blocked
        || connection.dropIncoming
      ) {
        return;
      }
      const nextLease = this.rememberLease(connection, lease, acquiredAt);
      if (nextLease.usageFailed) throw new Error("LEASE_USAGE_QUARANTINED");
      connection.lease = nextLease;
      const providerToken = connection.providerToken + 1;
      connection.providerToken = providerToken;
      this.openProvider(connection, providerToken);
    } catch {
      await this.failClosedForAuthority(connection.room);
    }
  }

  private openProvider(connection: Connection, providerToken: number): void {
    if (
      connection.provider
      || connection.providerToken !== providerToken
      || !this.connectionIsCurrent(connection)
      || connection.blocked
      || !connection.room.canCapture(connection.admission.participantId, connection.generation)
    ) {
      return;
    }
    connection.provider = this.providers.create(
      connection.admission.targetLanguage,
      this.makeSink(connection, providerToken),
    );
  }

  private makeSink(connection: Connection, providerToken: number): ProviderSink {
    const roomKey = this.roomKey(connection.admission.roomId, connection.admission.roomEpoch);
    return {
      onOutputAudio: audio => {
        void this.serial.run(roomKey, () => this.handleProviderAudio(connection, providerToken, audio));
      },
      onOutputTranscript: delta => {
        void this.serial.run(roomKey, () => {
          if (this.providerOutputIsCurrent(connection, providerToken)) {
            this.fanoutCaption(connection, connection.admission.targetLanguage, delta);
          }
        });
      },
      onInputTranscript: delta => {
        void this.serial.run(roomKey, () => {
          if (this.providerOutputIsCurrent(connection, providerToken)) {
            this.fanoutCaption(connection, connection.admission.sourceLanguage, delta);
          }
        });
      },
      onFatal: () => {
        void this.serial.run(roomKey, async () => {
          if (!this.providerIsCurrent(connection, providerToken)) return;
          connection.peer.send({ v: 1, type: "error", code: "PROVIDER_ERROR", fatal: false });
          await this.blockSource(connection, "provider-fatal", "PROVIDER_ERROR", false);
        });
      },
    };
  }

  private handleProviderAudio(connection: Connection, providerToken: number, audio: string): void {
    if (!this.providerOutputIsCurrent(connection, providerToken)) return;
    try {
      decodeOutputPcmBase64(audio);
    } catch {
      void this.blockSource(connection, "invalid-provider-audio", "PROVIDER_ERROR");
      return;
    }
    const nowMs = this.clock.now();
    if (!connection.room.canCapture(connection.admission.participantId, connection.generation)) return;
    // v1 has one source per target language. Quiet speech may never trigger the
    // device energy detector, so focus is timing metadata, never an audio gate.
    connection.room.mayPlayAudio(connection.admission.participantId, connection.generation, nowMs);
    const speechEndedAtMs = connection.room.estimatedSpeechEndedAt(
      connection.admission.participantId,
      connection.generation,
    );
    for (const id of connection.room.listenerIdsFor(
      connection.admission.participantId,
      connection.generation,
    )) {
      this.connectionForParticipant(connection.room, id)?.peer.send({
        v: 1,
        type: "audio",
        speakerId: connection.admission.participantId,
        generation: connection.generation,
        language: connection.admission.targetLanguage,
        audio,
        ...(speechEndedAtMs === undefined ? {} : { speechEndedAtMs }),
      });
    }
  }

  private fanoutCaption(connection: Connection, language: Language, delta: string): void {
    if (
      delta.length < 1 || delta.length > 4_096
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(delta)
    ) {
      return;
    }
    const atMs = this.clock.now();
    const captionOnly = false; // v1 has no competing source for a target language.
    if (!connection.room.addCaption({
      speakerId: connection.admission.participantId,
      generation: connection.generation,
      language,
      captionOnly,
      delta,
      atMs,
    }, atMs)) {
      return;
    }
    const event: ServerEventPayload = {
      v: 1,
      type: "caption.delta",
      speakerId: connection.admission.participantId,
      generation: connection.generation,
      language,
      captionOnly,
      delta,
      atMs,
    };
    if (language === connection.admission.targetLanguage) {
      for (const id of connection.room.listenerIdsFor(
        connection.admission.participantId,
        connection.generation,
      )) {
        this.connectionForParticipant(connection.room, id)?.peer.send(event);
      }
    } else {
      connection.peer.send(event);
    }
  }

  private async tickRoom(roomKey: string): Promise<void> {
    const room = this.rooms.get(roomKey);
    if (!room) return;
    const nowMs = this.clock.now();
    room.tick(nowMs);
    for (const connection of this.connectionsForRoom(room)) {
      if (nowMs - connection.lastPingAtMs >= CLIENT_PING_TIMEOUT_MS) {
        await this.disconnect(connection, 4008, "client-ping-timeout", true, false);
      }
    }
    if (nowMs - (this.lastPresenceSyncAtByRoom.get(roomKey) ?? -PRESENCE_SYNC_MS) >= PRESENCE_SYNC_MS) {
      this.startPresenceSync(roomKey, room);
    }
    if (room.isEnded()) {
      await this.syncLifecycleState(roomKey, room);
      this.markTombstone(roomKey, nowMs);
      for (const connection of this.connectionsForRoom(room)) {
        await this.disconnect(connection, 1000, "room-ended");
      }
      return;
    }
    for (const connection of this.connectionsForRoom(room)) {
      if (!room.isCurrent(connection.admission.participantId, connection.generation)) {
        await this.disconnect(connection, 4001, "stale-generation");
        continue;
      }
      if (!room.isActive() || !room.canCapture(connection.admission.participantId, connection.generation)) {
        await this.stopSource(connection, "room-inactive");
      } else if (connection.lease) {
        if (connection.lease.value.expiresAtMs <= nowMs) {
          await this.blockSource(connection, "lease-expired", "LEASE_EXPIRED");
        } else if (connection.lease.value.expiresAtMs - nowMs <= 5_000) {
          this.startRenewLease(connection, connection.lease);
        }
      }
      this.sendRoomState(connection);
      this.sendRoute(connection);
    }
  }

  private async syncLifecycleState(roomKey: string, room: RoomActor): Promise<void> {
    const snapshot = room.snapshot(this.clock.now());
    const desired: AuthorityRoomState = snapshot.ended
      ? "ended"
      : snapshot.paused ? "paused"
      : snapshot.started ? "active"
      : "waiting";
    if (
      (desired !== "paused" && desired !== "ended")
      || this.authorityStateByRoom.get(roomKey) === desired
    ) {
      return;
    }
    const host = snapshot.participants.find(participant => participant.role === "host");
    if (!host) return;
    const hostConnection = this.connectionForParticipant(room, host.participantId);
    if (!hostConnection) return;
    try {
      const response = await this.bounded(this.authority.controlRoom({
        roomId: room.roomId,
        roomEpoch: room.roomEpoch,
        participantId: host.participantId,
        admissionId: hostConnection.admissionId,
        generation: host.generation,
        action: desired === "ended" ? "end" : "pause",
        cause: "lifecycle",
      }), "AUTHORITY_TIMEOUT");
      this.assertControlResponse(
        response,
        room.roomEpoch,
        desired === "ended" ? "end" : "pause",
      );
      this.authorityStateByRoom.set(roomKey, response.state);
    } catch {
      // Local safety state remains closed/paused. The next tick retries durable Authority sync.
      for (const connection of this.connectionsForRoom(room)) {
        connection.peer.send({ v: 1, type: "error", code: "INTERNAL", fatal: false });
      }
    }
  }

  private async syncPresence(roomKey: string, room: RoomActor, force: boolean): Promise<boolean> {
    const nowMs = this.clock.now();
    if (!force && nowMs - (this.lastPresenceSyncAtByRoom.get(roomKey) ?? -PRESENCE_SYNC_MS) < PRESENCE_SYNC_MS) {
      return true;
    }
    if (force) this.presenceInFlightByRoom.delete(roomKey);
    const participants = this.connectionsForRoom(room).map(connection => ({
      participantId: connection.admission.participantId,
      admissionId: connection.admissionId,
      generation: connection.generation,
      ready: room.isReady(connection.admission.participantId, connection.generation),
    }));
    let response: PresenceSyncResponse;
    try {
      response = await this.bounded(this.authority.syncPresence({
        roomId: room.roomId,
        roomEpoch: room.roomEpoch,
        participants,
      }), "AUTHORITY_TIMEOUT");
      this.assertPresenceResponse(response, room.roomEpoch);
    } catch {
      await this.failClosedForAuthority(room);
      return false;
    }
    await this.applyPresenceResponse(roomKey, room, response);
    return true;
  }

  private startPresenceSync(roomKey: string, room: RoomActor): void {
    if (this.presenceInFlightByRoom.has(roomKey)) return;
    const participants = this.presenceParticipants(room);
    const operation = this.bounded(this.authority.syncPresence({
      roomId: room.roomId,
      roomEpoch: room.roomEpoch,
      participants,
    }), "AUTHORITY_TIMEOUT");
    this.lastPresenceSyncAtByRoom.set(roomKey, this.clock.now());
    let completion!: Promise<void>;
    completion = operation.then(
      response => this.serial.run(roomKey, async () => {
        if (this.presenceInFlightByRoom.get(roomKey) !== completion) return;
        this.presenceInFlightByRoom.delete(roomKey);
        if (
          this.disposed
          || this.rooms.get(roomKey) !== room
          || !this.samePresenceParticipants(participants, this.presenceParticipants(room))
        ) {
          return;
        }
        try {
          this.assertPresenceResponse(response, room.roomEpoch);
        } catch {
          await this.failClosedForAuthority(room);
          return;
        }
        const completedAt = this.clock.now();
        for (const connection of this.connectionsForRoom(room)) {
          if (completedAt - connection.lastPingAtMs >= CLIENT_PING_TIMEOUT_MS) {
            await this.disconnect(connection, 4008, "client-ping-timeout", true, false);
          }
        }
        await this.applyPresenceResponse(roomKey, room, response);
      }),
      () => this.serial.run(roomKey, async () => {
        if (this.presenceInFlightByRoom.get(roomKey) !== completion) return;
        this.presenceInFlightByRoom.delete(roomKey);
        if (
          !this.disposed
          && this.rooms.get(roomKey) === room
          && this.samePresenceParticipants(participants, this.presenceParticipants(room))
        ) {
          await this.failClosedForAuthority(room);
        }
      }),
    );
    this.presenceInFlightByRoom.set(roomKey, completion);
  }

  private presenceParticipants(room: RoomActor): PresenceParticipant[] {
    return this.connectionsForRoom(room).map(connection => ({
      participantId: connection.admission.participantId,
      admissionId: connection.admissionId,
      generation: connection.generation,
      ready: room.isReady(connection.admission.participantId, connection.generation),
    }));
  }

  private samePresenceParticipants(
    left: PresenceParticipant[],
    right: PresenceParticipant[],
  ): boolean {
    return left.length === right.length && left.every((participant, index) => {
      const candidate = right[index];
      return candidate !== undefined
        && participant.participantId === candidate.participantId
        && participant.admissionId === candidate.admissionId
        && participant.generation === candidate.generation
        && participant.ready === candidate.ready;
    });
  }

  private async applyPresenceResponse(
    roomKey: string,
    room: RoomActor,
    response: PresenceSyncResponse,
  ): Promise<void> {
    this.lastPresenceSyncAtByRoom.set(roomKey, this.clock.now());
    this.authorityStateByRoom.set(roomKey, response.state);
    room.restoreAuthorityState(response.state);
    const allowed = new Set(response.allowedAdmissionIds);
    for (const connection of this.connectionsForRoom(room)) {
      if (!allowed.has(connection.admissionId)) {
        await this.disconnect(connection, 4003, "admission-revoked", true, false);
      }
    }
    if (response.state === "paused" || response.state === "ended") {
      for (const connection of this.connectionsForRoom(room)) {
        await this.stopSource(connection, `authority-${response.state}`);
      }
    }
    this.broadcastRoomState(room);
    this.broadcastRoutes(room);
    if (response.state === "ended") {
      this.markTombstone(roomKey, this.clock.now());
      for (const connection of this.connectionsForRoom(room)) {
        await this.disconnect(connection, 1000, "room-ended", true, false);
      }
    }
  }

  private async failClosedForAuthority(room: RoomActor): Promise<void> {
    for (const connection of this.connectionsForRoom(room)) {
      connection.blocked = true;
      connection.needsExplicitResume = true;
      room.setCapturePaused(connection.admission.participantId, connection.generation, true);
      await this.stopSource(connection, "authority-sync-failed");
      connection.peer.send({ v: 1, type: "error", code: "INTERNAL", fatal: false });
    }
    this.broadcastParticipants(room);
    this.broadcastRoutes(room);
  }

  private assertPresenceResponse(response: PresenceSyncResponse, roomEpoch: string): void {
    if (
      !response
      || response.roomEpoch !== roomEpoch
      || !["waiting", "active", "paused", "ended"].includes(response.state)
      || !Array.isArray(response.allowedAdmissionIds)
      || response.allowedAdmissionIds.length > 2
      || response.allowedAdmissionIds.some(value => (
        typeof value !== "string"
        || value.length < 1
        || value.length > 128
        || /[\u0000-\u001f]/u.test(value)
      ))
      || new Set(response.allowedAdmissionIds).size !== response.allowedAdmissionIds.length
    ) {
      throw new Error("INVALID_PRESENCE_RESPONSE");
    }
  }

  private startRenewLease(connection: Connection, current: LeaseState): void {
    if (current.renewInFlight || current.usageFailed) return;
    const token = connection.providerToken;
    this.launchRenewLease(connection, current, token);
  }

  private launchRenewLease(
    connection: Connection,
    current: LeaseState,
    token: number,
  ): void {
    if (
      current.renewInFlight
      || current.usageFailed
      || this.clock.now() >= current.value.expiresAtMs
      || !this.providerIsCurrent(connection, token)
      || connection.lease !== current
    ) {
      return;
    }
    current.renewInFlight = true;
    const oldLeaseId = current.value.leaseId;
    const oldExpiresAtMs = current.value.expiresAtMs;
    const roomKey = this.roomKey(connection.admission.roomId, connection.admission.roomEpoch);
    const operation = this.bounded(this.authority.renewLease({
      leaseId: oldLeaseId,
      roomId: connection.admission.roomId,
      roomEpoch: connection.admission.roomEpoch,
      participantId: connection.admission.participantId,
      admissionId: connection.admissionId,
      generation: connection.generation,
    }), "AUTHORITY_TIMEOUT");
    void operation.then(
      next => this.serial.run(roomKey, async () => {
        current.renewInFlight = false;
        const completedAt = this.clock.now();
        if (
          this.disposed
          || !this.providerIsCurrent(connection, token)
          || connection.lease !== current
          || current.value.leaseId !== oldLeaseId
        ) {
          return;
        }
        if (completedAt >= oldExpiresAtMs) {
          await this.blockSource(connection, "lease-expired-during-renewal", "LEASE_EXPIRED");
          return;
        }
        try {
          this.assertLease(next, completedAt);
          const nextLease = this.rememberLease(
            connection,
            next,
            completedAt,
            current.availableAudioMs,
          );
          if (nextLease.usageFailed) throw new Error("LEASE_USAGE_QUARANTINED");
          connection.lease = nextLease;
          if (nextLease !== current) {
            current.finalDrainThroughMs = Math.max(
              current.finalDrainThroughMs,
              current.inputAudioMs,
            );
            this.startUsageReport(connection, current, token);
          }
        } catch {
          await this.failClosedForAuthority(connection.room);
        }
      }),
      () => this.serial.run(roomKey, async () => {
        current.renewInFlight = false;
        if (
          !this.disposed
          && this.providerIsCurrent(connection, token)
          && connection.lease === current
          && current.value.leaseId === oldLeaseId
        ) {
          await this.failClosedForAuthority(connection.room);
        }
      }),
    );
  }

  private rememberLease(connection: Connection, value: BudgetLease, nowMs: number, availableAudioMs = AUDIO_BURST_MS): LeaseState {
    for (const [id, state] of connection.leaseLedger) {
      const finalDrainPending = state.finalDrainThroughMs > state.reportedUsageMs;
      if (
        state.value.expiresAtMs <= nowMs
        && !state.usageFailed
        && !state.usageInFlight
        && !state.renewInFlight
        && state.pendingUsageMs <= 0
        && !finalDrainPending
      ) {
        connection.leaseLedger.delete(id);
      }
    }
    const existing = connection.leaseLedger.get(value.leaseId);
    if (existing) {
      if (existing.inputAudioMs > value.maxInputAudioMs) throw new Error("LEASE_LIMIT_BELOW_USAGE");
      existing.value = value;
      existing.availableAudioMs = Math.min(existing.availableAudioMs, AUDIO_BURST_MS);
      return existing;
    }
    if (connection.leaseLedger.size >= 4) throw new Error("LEASE_LEDGER_FULL");
    const state: LeaseState = {
      value,
      inputAudioMs: 0,
      availableAudioMs: Math.min(availableAudioMs, AUDIO_BURST_MS),
      lastAudioAtMs: nowMs,
      reportedUsageMs: 0,
      pendingUsageMs: 0,
      inFlightUsageMs: 0,
      usageFailed: false,
      finalDrainThroughMs: 0,
      lastUsageReportAtMs: nowMs,
      renewInFlight: false,
    };
    connection.leaseLedger.set(value.leaseId, state);
    return state;
  }

  private consumeLeaseAudio(lease: LeaseState, audioMs: number, nowMs: number): boolean {
    if (!Number.isFinite(audioMs) || audioMs <= 0 || audioMs > AUDIO_BURST_MS) return false;
    const elapsed = Math.max(0, nowMs - lease.lastAudioAtMs);
    lease.availableAudioMs = Math.min(AUDIO_BURST_MS, lease.availableAudioMs + elapsed);
    lease.lastAudioAtMs = nowMs;
    if (audioMs > lease.availableAudioMs) return false;
    if (lease.inputAudioMs + audioMs > lease.value.maxInputAudioMs) return false;
    lease.availableAudioMs -= audioMs;
    lease.inputAudioMs += audioMs;
    return true;
  }

  private startUsageReport(
    connection: Connection,
    lease: LeaseState,
    providerToken: number,
  ): void {
    if (lease.usageFailed) return;
    if (lease.usageInFlight) return;
    if (lease.pendingUsageMs <= 0) return;
    const finalRemainingMs = Math.max(
      0,
      lease.finalDrainThroughMs - lease.reportedUsageMs,
    );
    const snapshotMs = finalRemainingMs > 0
      ? Math.min(lease.pendingUsageMs, finalRemainingMs)
      : lease.pendingUsageMs;
    lease.pendingUsageMs -= snapshotMs;
    lease.inFlightUsageMs = snapshotMs;
    const atMs = this.clock.now();
    const roomKey = this.roomKey(connection.admission.roomId, connection.admission.roomEpoch);
    const operation = this.bounded(this.authority.reportUsage({
        roomId: connection.admission.roomId,
        roomEpoch: connection.admission.roomEpoch,
        participantId: connection.admission.participantId,
        admissionId: connection.admissionId,
        generation: connection.generation,
        leaseId: lease.value.leaseId,
        inputAudioSeconds: snapshotMs / 1_000,
        atMs,
      }), "AUTHORITY_TIMEOUT").then(() => true, () => false);
    lease.usageInFlight = operation;
    void operation.then(success => this.serial.run(roomKey, async () => {
      if (lease.usageInFlight !== operation) return;
      delete lease.usageInFlight;
      lease.inFlightUsageMs = 0;
      if (success) {
        lease.reportedUsageMs += snapshotMs;
        lease.lastUsageReportAtMs = atMs;
        if (lease.reportedUsageMs >= lease.finalDrainThroughMs) {
          lease.finalDrainThroughMs = 0;
        }
        if (
          lease.finalDrainThroughMs > lease.reportedUsageMs
          || lease.pendingUsageMs >= USAGE_BATCH_AUDIO_MS
        ) {
          this.startUsageReport(connection, lease, providerToken);
        }
        return;
      }
      lease.usageFailed = true;
      if (
        !this.disposed
        && this.connectionIsCurrent(connection)
        && connection.providerToken === providerToken
      ) {
        await this.failClosedForAuthority(connection.room);
      }
    }));
  }

  private assertAdmission(admission: AuthorityAdmission, claims: TicketClaims): void {
    if (
      !admission
      || typeof admission !== "object"
      || typeof admission.admissionId !== "string"
      || admission.admissionId.length < 1
      || admission.admissionId.length > 128
      || /[\u0000-\u001f]/u.test(admission.admissionId)
      || admission.roomEpoch !== claims.roomEpoch
      || !["host", "guest"].includes(admission.role)
      || !isLanguage(admission.sourceLanguage)
      || !isLanguage(admission.targetLanguage)
      || admission.sourceLanguage === admission.targetLanguage
      || !["waiting", "active", "paused", "ended"].includes(admission.roomState)
    ) {
      throw new Error("INVALID_ADMISSION");
    }
  }

  private assertControlResponse(
    response: { roomEpoch: string; state: AuthorityRoomState },
    roomEpoch: string,
    action: RoomControlAction,
  ): void {
    const expected: Record<RoomControlAction, AuthorityRoomState> = {
      start: "active",
      pause: "paused",
      resume: "active",
      end: "ended",
    };
    if (
      !response
      || response.roomEpoch !== roomEpoch
      || response.state !== expected[action]
    ) {
      throw new Error("INVALID_CONTROL_RESPONSE");
    }
  }

  private assertLease(lease: BudgetLease, nowMs: number): void {
    if (
      !lease
      || typeof lease.leaseId !== "string"
      || lease.leaseId.length < 1
      || lease.leaseId.length > 128
      || /[\u0000-\u001f]/u.test(lease.leaseId)
      || typeof lease.expiresAtMs !== "number"
      || !Number.isSafeInteger(lease.expiresAtMs)
      || lease.expiresAtMs <= nowMs
      || lease.expiresAtMs > nowMs + LEASE_MAX_LIFETIME_MS
      || typeof lease.maxInputAudioMs !== "number"
      || !Number.isSafeInteger(lease.maxInputAudioMs)
      || lease.maxInputAudioMs < 20
      || lease.maxInputAudioMs > LEASE_MAX_LIFETIME_MS
    ) {
      throw new Error("INVALID_LEASE");
    }
  }

  private async blockSource(
    connection: Connection,
    reason: string,
    code: ErrorCode,
    sendError = true,
  ): Promise<void> {
    connection.blocked = true;
    connection.room.setCapturePaused(
      connection.admission.participantId,
      connection.generation,
      true,
    );
    await this.stopSource(connection, reason);
    if (sendError) connection.peer.send({ v: 1, type: "error", code, fatal: false });
    this.broadcastParticipants(connection.room);
    this.sendRoute(connection);
  }

  private async stopSource(connection: Connection, _reason: string): Promise<void> {
    // Invalidate callbacks before usage drain and provider close can re-enter.
    const providerToken = connection.providerToken;
    connection.providerToken += 1;
    const provider = connection.provider;
    const lease = connection.lease;
    delete connection.provider;
    delete connection.lease;
    connection.room.releaseFocus(connection.admission.participantId, connection.generation);
    if (lease) {
      lease.finalDrainThroughMs = Math.max(lease.finalDrainThroughMs, lease.inputAudioMs);
      this.startUsageReport(connection, lease, providerToken);
    }
    if (provider) await provider.close(1_000).catch(() => undefined);
  }

  private async disconnect(
    connection: Connection,
    code: number,
    reason: string,
    closePeer = true,
    syncPresence = true,
  ): Promise<void> {
    await this.stopSource(connection, reason);
    connection.room.disconnect(
      connection.admission.participantId,
      connection.generation,
      this.clock.now(),
    );
    const key = this.connectionKey(
      this.roomKey(connection.admission.roomId, connection.admission.roomEpoch),
      connection.admission.participantId,
    );
    if (this.connections.get(key) === connection) this.connections.delete(key);
    if (closePeer) connection.peer.close(code, reason);
    for (const item of this.connectionsForRoom(connection.room)) {
      if (!connection.room.canCapture(item.admission.participantId, item.generation)) {
        await this.stopSource(item, "listener-disconnected");
      }
    }
    this.broadcastParticipants(connection.room);
    this.broadcastRoutes(connection.room);
    if (syncPresence && !this.disposed && !connection.room.isEnded()) {
      await this.syncPresence(
        this.roomKey(connection.admission.roomId, connection.admission.roomEpoch),
        connection.room,
        true,
      );
    }
  }

  private providerIsCurrent(connection: Connection, token: number): boolean {
    return !!connection.provider
      && !connection.dropIncoming
      && connection.providerToken === token
      && this.connectionIsCurrent(connection);
  }

  private providerOutputIsCurrent(connection: Connection, token: number): boolean {
    return this.providerIsCurrent(connection, token)
      && !!connection.lease
      && connection.lease.value.expiresAtMs > this.clock.now();
  }

  private connectionIsCurrent(connection: Connection): boolean {
    return !connection.dropIncoming
      && connection.room.isCurrent(connection.admission.participantId, connection.generation)
      && this.connections.get(this.connectionKey(
        this.roomKey(connection.admission.roomId, connection.admission.roomEpoch),
        connection.admission.participantId,
      )) === connection;
  }

  private sendRoomState(connection: Connection): void {
    const snapshot = connection.room.snapshot(this.clock.now());
    connection.peer.send({
      v: 1,
      type: "room.state",
      roomId: snapshot.roomId,
      roomEpoch: snapshot.roomEpoch,
      active: snapshot.started && !snapshot.paused && !snapshot.ended,
      paused: snapshot.paused,
      ended: snapshot.ended,
    });
  }

  private broadcastRoomState(room: RoomActor): void {
    for (const connection of this.connectionsForRoom(room)) this.sendRoomState(connection);
  }

  private sendRoute(connection: Connection): void {
    const snapshot = connection.room.snapshot(this.clock.now());
    const canCapture = !connection.blocked && connection.room.canCapture(
      connection.admission.participantId,
      connection.generation,
    );
    const participant = connection.room.getParticipant(connection.admission.participantId);
    const reason: Extract<ServerEventPayload, { type: "route" }>["reason"] = canCapture
      ? "active"
      : connection.blocked ? "blocked"
      : snapshot.ended ? "ended"
      : snapshot.paused || participant?.state === "paused" ? "paused"
      : !snapshot.started ? "host-not-ready"
      : "no-listener";
    connection.peer.send({ v: 1, type: "route", canCapture, reason });
  }

  private broadcastRoutes(room: RoomActor): void {
    for (const connection of this.connectionsForRoom(room)) this.sendRoute(connection);
  }

  private broadcastParticipants(room: RoomActor): void {
    const snapshot = room.snapshot(this.clock.now());
    for (const target of this.connectionsForRoom(room)) {
      for (const participantWithReservation of snapshot.participants) {
        const { connected, reservedUntilMs: _reserved, ...participant } = participantWithReservation;
        target.peer.send({ v: 1, type: "participant.state", participant, connected });
      }
    }
  }

  private enqueueClientOperation(
    connection: Connection,
    roomKey: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (connection.dropIncoming) return Promise.resolve();
    if (connection.pendingClientOperations >= MAX_PENDING_CLIENT_OPERATIONS) {
      this.beginDroppingIncoming(connection, "client-operation-backpressure");
      return Promise.resolve();
    }
    connection.pendingClientOperations += 1;
    return this.serial.run(roomKey, async () => {
      if (!connection.dropIncoming) await operation();
    }).finally(() => {
      connection.pendingClientOperations = Math.max(0, connection.pendingClientOperations - 1);
    });
  }

  private beginDroppingIncoming(
    connection: Connection,
    reason: string,
    closePeer = true,
  ): void {
    if (connection.dropIncoming) return;
    connection.dropIncoming = true;
    if (closePeer) connection.peer.close(4009, reason);
    const roomKey = this.roomKey(connection.admission.roomId, connection.admission.roomEpoch);
    void this.serial.run(roomKey, async () => {
      if (this.getConnection(
        connection.admission.roomId,
        connection.admission.roomEpoch,
        connection.admission.participantId,
        connection.generation,
      ) === connection) {
        await this.disconnect(connection, 4009, reason, false);
      }
    });
  }

  private getConnection(
    roomId: string,
    epoch: string,
    participantId: string,
    generation: number,
  ): Connection | undefined {
    const connection = this.connections.get(this.connectionKey(
      this.roomKey(roomId, epoch),
      participantId,
    ));
    return connection?.generation === generation ? connection : undefined;
  }

  private connectionForParticipant(room: RoomActor, participantId: string): Connection | undefined {
    return this.connectionsForRoom(room).find(connection => (
      connection.admission.participantId === participantId
      && room.isCurrent(participantId, connection.generation)
    ));
  }

  private connectionsForRoom(room: RoomActor): Connection[] {
    return [...this.connections.values()].filter(connection => connection.room === room);
  }

  private markTombstone(roomKey: string, nowMs: number): void {
    this.tombstones.set(roomKey, nowMs + this.normalizedConfig.tombstoneTtlMs);
  }

  private pruneRooms(nowMs: number): void {
    for (const [key, expiry] of this.tombstones) {
      if (expiry > nowMs) continue;
      this.tombstones.delete(key);
      const room = this.rooms.get(key);
      if (room?.isEnded() && this.connectionsForRoom(room).length === 0) this.rooms.delete(key);
      this.authorityStateByRoom.delete(key);
      this.lastPresenceSyncAtByRoom.delete(key);
    }
  }

  private bounded<T>(promise: Promise<T>, code: string): Promise<T> {
    let timeout: unknown;
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = this.clock.setTimeout(() => reject(new Error(code)), this.normalizedConfig.authorityTimeoutMs);
      }),
    ]).finally(() => {
      if (timeout !== undefined) this.clock.clearTimeout(timeout);
    });
  }

  private roomKey(roomId: string, epoch: string): string {
    return `${roomId}\u0000${epoch}`;
  }

  private connectionKey(roomKey: string, participantId: string): string {
    return `${roomKey}\u0000${participantId}`;
  }
}

const systemClock: RelayClock = {
  now: () => Date.now(),
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: handle => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function copyRoomConfig(config: RoomConfig): RoomConfig {
  return {
    focusReleaseSilenceMs: config.focusReleaseSilenceMs,
    ...(config.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: config.maxLifetimeMs }),
  };
}
