import {
  oppositeLanguage,
  type Language,
  type ParticipantRole,
  type ParticipantView,
  type RoomControlAction,
} from "../../protocol/src/index.ts";

export const MAX_PARTICIPANTS = 2;
export const SEAT_RESERVATION_MS = 120_000;
export const ROOM_MAX_LIFETIME_MS = 90 * 60_000;
export const CAPTION_RETENTION_MS = 120_000;
export const MAX_CAPTION_DELTAS = 4_096;
export const AUDIO_START_DEADLINE_MS = 10_000;

export interface Admission {
  roomId: string;
  participantId: string;
  roomEpoch: string;
  role: ParticipantRole;
  sourceLanguage: Language;
  targetLanguage: Language;
  admissionId: string;
}

export interface CaptionDelta {
  speakerId: string;
  generation: number;
  language: Language;
  captionOnly: boolean;
  delta: string;
  atMs: number;
}

interface Participant extends ParticipantView {
  connected: boolean;
  reservedUntilMs?: number;
}

interface Focus {
  speakerId: string;
  generation: number;
  startedAtServerMs: number;
  speechEndedAtServerMs?: number;
  outputStartedAtServerMs?: number;
  lastOutputAtServerMs?: number;
}

export interface RoomConfig {
  focusReleaseSilenceMs: number;
  maxLifetimeMs?: number;
}

const DEFAULT_ROOM_CONFIG: RoomConfig = {
  focusReleaseSilenceMs: 1_500,
  maxLifetimeMs: ROOM_MAX_LIFETIME_MS,
};

export interface RoomSnapshot {
  roomId: string;
  roomEpoch: string;
  started: boolean;
  paused: boolean;
  ended: boolean;
  participants: ReadonlyArray<Readonly<Participant>>;
  captions: ReadonlyArray<Readonly<CaptionDelta>>;
}

export type AuthorityRoomState = "waiting" | "active" | "paused" | "ended";

export type AdmitResult =
  | { ok: true; generation: number; replacedGeneration?: number }
  | { ok: false; code: "ROOM_FULL" | "ROOM_ENDED" | "EPOCH_MISMATCH" | "HOST_EXISTS" | "LANGUAGE_MISMATCH" };

export class RoomActor {
  private readonly participants = new Map<string, Participant>();
  private readonly captions: CaptionDelta[] = [];
  private readonly focusByOutputLanguage = new Map<Language, Focus>();
  private readonly maxLifetimeMs: number;
  private started = false;
  private paused = false;
  private ended = false;

  constructor(
    readonly roomId: string,
    readonly roomEpoch: string,
    private readonly config: RoomConfig = DEFAULT_ROOM_CONFIG,
    private readonly createdAtMs = 0,
  ) {
    if (!Number.isSafeInteger(config.focusReleaseSilenceMs) || config.focusReleaseSilenceMs < 0) {
      throw new Error("INVALID_FOCUS_CONFIG");
    }
    this.maxLifetimeMs = config.maxLifetimeMs ?? ROOM_MAX_LIFETIME_MS;
    if (!Number.isSafeInteger(this.maxLifetimeMs) || this.maxLifetimeMs < 1) {
      throw new Error("INVALID_LIFETIME_CONFIG");
    }
  }

  admit(admission: Admission, nowMs: number): AdmitResult {
    this.tick(nowMs);
    if (this.ended) return { ok: false, code: "ROOM_ENDED" };
    if (admission.roomId !== this.roomId || admission.roomEpoch !== this.roomEpoch) {
      return { ok: false, code: "EPOCH_MISMATCH" };
    }
    if (admission.targetLanguage !== oppositeLanguage(admission.sourceLanguage)) {
      return { ok: false, code: "LANGUAGE_MISMATCH" };
    }
    const existing = this.participants.get(admission.participantId);
    if (existing) {
      if (
        existing.role !== admission.role
        || existing.sourceLanguage !== admission.sourceLanguage
        || existing.targetLanguage !== admission.targetLanguage
      ) {
        return { ok: false, code: "LANGUAGE_MISMATCH" };
      }
      const replacedGeneration = existing.connected ? existing.generation : undefined;
      this.releaseSpeaker(existing.participantId, existing.generation);
      existing.generation += 1;
      existing.connected = true;
      existing.state = "connecting";
      delete existing.reservedUntilMs;
      return {
        ok: true,
        generation: existing.generation,
        ...(replacedGeneration === undefined ? {} : { replacedGeneration }),
      };
    }
    if (admission.role === "host" && [...this.participants.values()].some(item => item.role === "host")) {
      return { ok: false, code: "HOST_EXISTS" };
    }
    if (
      admission.role === "guest"
      && ![...this.participants.values()].some(item => item.role === "host")
      && this.participants.size >= MAX_PARTICIPANTS - 1
    ) {
      return { ok: false, code: "ROOM_FULL" };
    }
    if (this.participants.size >= MAX_PARTICIPANTS) return { ok: false, code: "ROOM_FULL" };
    this.participants.set(admission.participantId, {
      participantId: admission.participantId,
      role: admission.role,
      sourceLanguage: admission.sourceLanguage,
      targetLanguage: admission.targetLanguage,
      generation: 1,
      state: "connecting",
      connected: true,
    });
    return { ok: true, generation: 1 };
  }

  markReady(participantId: string, generation: number): boolean {
    const participant = this.current(participantId, generation);
    if (!participant || this.ended) return false;
    participant.state = "ready";
    return true;
  }

  restoreAuthorityState(state: AuthorityRoomState): void {
    if (this.ended) return;
    switch (state) {
      case "waiting":
        return;
      case "active":
        if (!this.started) {
          this.started = true;
          this.paused = false;
        }
        return;
      case "paused":
        this.started = true;
        this.paused = true;
        this.focusByOutputLanguage.clear();
        return;
      case "ended":
        this.end();
    }
  }

  applyControl(
    participantId: string,
    generation: number,
    action: RoomControlAction,
    nowMs: number,
  ): boolean {
    this.tick(nowMs);
    if (!this.canControl(participantId, generation, action)) return false;
    switch (action) {
      case "start":
        this.started = true;
        this.paused = false;
        return true;
      case "pause":
        this.paused = true;
        this.focusByOutputLanguage.clear();
        return true;
      case "resume":
        this.paused = false;
        return true;
      case "end":
        this.end();
        return true;
    }
  }

  canControl(participantId: string, generation: number, action: RoomControlAction): boolean {
    const participant = this.current(participantId, generation);
    if (!participant || participant.role !== "host" || participant.state === "connecting" || this.ended) {
      return false;
    }
    switch (action) {
      case "start":
        return !this.started;
      case "pause":
        return this.started && !this.paused;
      case "resume":
        return this.started && this.paused;
      case "end":
        return true;
    }
  }

  setCapturePaused(participantId: string, generation: number, paused: boolean): boolean {
    const participant = this.current(participantId, generation);
    if (!participant || this.ended || participant.state === "connecting") return false;
    participant.state = paused ? "paused" : "ready";
    if (paused) this.releaseSpeaker(participantId, generation);
    return true;
  }

  disconnect(participantId: string, generation: number, nowMs: number): boolean {
    const participant = this.current(participantId, generation);
    if (!participant) return false;
    participant.connected = false;
    participant.state = "closed";
    participant.reservedUntilMs = nowMs + SEAT_RESERVATION_MS;
    this.releaseSpeaker(participantId, generation);
    return true;
  }

  tick(nowMs: number): void {
    this.pruneCaptions(nowMs);
    if (this.ended) return;
    if (nowMs - this.createdAtMs >= this.maxLifetimeMs) {
      this.end();
      return;
    }
    for (const [language, focus] of this.focusByOutputLanguage) {
      if (this.focusExpired(focus, nowMs)) this.focusByOutputLanguage.delete(language);
    }
    for (const [id, participant] of this.participants) {
      if (!participant.connected && participant.reservedUntilMs !== undefined && participant.reservedUntilMs <= nowMs) {
        this.participants.delete(id);
      }
    }
  }

  canCapture(participantId: string, generation: number): boolean {
    const participant = this.current(participantId, generation);
    return !!participant
      && participant.state === "ready"
      && this.started
      && !this.paused
      && !this.ended
      && this.hasListenerFor(participantId, generation);
  }

  listenerIdsFor(speakerId: string, generation: number): string[] {
    const speaker = this.current(speakerId, generation);
    if (!speaker || !this.started || this.paused || this.ended) return [];
    return [...this.participants.values()]
      .filter(participant => (
        participant.connected
        && participant.state !== "connecting"
        && participant.participantId !== speakerId
        && participant.sourceLanguage === speaker.targetLanguage
      ))
      .map(participant => participant.participantId);
  }

  startSpeech(speakerId: string, generation: number, receivedAtMs: number): boolean {
    this.tick(receivedAtMs);
    if (!this.canCapture(speakerId, generation)) return false;
    const speaker = this.current(speakerId, generation);
    if (!speaker) return false;
    const focus = this.focusByOutputLanguage.get(speaker.targetLanguage);
    if (!focus) {
      this.focusByOutputLanguage.set(speaker.targetLanguage, {
        speakerId,
        generation,
        startedAtServerMs: receivedAtMs,
      });
    } else if (focus.speakerId === speakerId && focus.generation === generation) {
      focus.startedAtServerMs = receivedAtMs;
      delete focus.speechEndedAtServerMs;
      delete focus.outputStartedAtServerMs;
      delete focus.lastOutputAtServerMs;
    }
    // Overlapping speakers still get transcript translation; only the focus owner may emit audio.
    return true;
  }

  endSpeech(speakerId: string, generation: number, receivedAtMs: number): boolean {
    if (!this.current(speakerId, generation)) return false;
    const speaker = this.current(speakerId, generation);
    if (!speaker) return false;
    const focus = this.focusByOutputLanguage.get(speaker.targetLanguage);
    if (!focus || focus.speakerId !== speakerId || focus.generation !== generation) return false;
    focus.speechEndedAtServerMs = receivedAtMs;
    return true;
  }

  mayPlayAudio(speakerId: string, generation: number, nowMs: number): boolean {
    if (!this.current(speakerId, generation) || !this.started || this.paused || this.ended) return false;
    const speaker = this.current(speakerId, generation);
    if (!speaker) return false;
    const focus = this.focusByOutputLanguage.get(speaker.targetLanguage);
    if (!focus || focus.speakerId !== speakerId || focus.generation !== generation) return false;
    if (this.focusExpired(focus, nowMs)) {
      this.focusByOutputLanguage.delete(speaker.targetLanguage);
      return false;
    }
    if (focus.outputStartedAtServerMs === undefined) focus.outputStartedAtServerMs = nowMs;
    focus.lastOutputAtServerMs = nowMs;
    return true;
  }

  estimatedSpeechEndedAt(speakerId: string, generation: number): number | undefined {
    if (!this.current(speakerId, generation)) return undefined;
    const speaker = this.current(speakerId, generation);
    if (!speaker) return undefined;
    const focus = this.focusByOutputLanguage.get(speaker.targetLanguage);
    return focus?.speakerId === speakerId && focus.generation === generation
      ? focus.speechEndedAtServerMs
      : undefined;
  }

  releaseFocus(speakerId: string, generation: number): void {
    this.releaseSpeaker(speakerId, generation);
  }

  captionOnlyFor(speakerId: string, generation: number): boolean {
    const speaker = this.current(speakerId, generation);
    if (!speaker) return true;
    const focus = this.focusByOutputLanguage.get(speaker.targetLanguage);
    return !!focus && (focus.speakerId !== speakerId || focus.generation !== generation);
  }

  isReady(participantId: string, generation: number): boolean {
    const participant = this.current(participantId, generation);
    return participant?.state === "ready";
  }

  addCaption(caption: CaptionDelta, nowMs: number): boolean {
    if (!this.current(caption.speakerId, caption.generation) || this.ended) return false;
    this.captions.push({ ...caption });
    this.pruneCaptions(nowMs);
    while (this.captions.length > MAX_CAPTION_DELTAS) this.captions.shift();
    return true;
  }

  isCurrent(participantId: string, generation: number): boolean {
    return !!this.current(participantId, generation);
  }

  isEnded(): boolean {
    return this.ended;
  }

  terminate(): void {
    this.end();
  }

  isActive(): boolean {
    return this.started && !this.paused && !this.ended;
  }

  getParticipant(participantId: string): Readonly<Participant> | undefined {
    const participant = this.participants.get(participantId);
    return participant ? { ...participant } : undefined;
  }

  snapshot(nowMs: number): RoomSnapshot {
    this.tick(nowMs);
    return {
      roomId: this.roomId,
      roomEpoch: this.roomEpoch,
      started: this.started,
      paused: this.paused,
      ended: this.ended,
      participants: [...this.participants.values()].map(participant => ({ ...participant })),
      captions: this.captions.map(caption => ({ ...caption })),
    };
  }

  private current(id: string, generation: number): Participant | undefined {
    const participant = this.participants.get(id);
    return participant?.connected && participant.generation === generation ? participant : undefined;
  }

  private hasListenerFor(id: string, generation: number): boolean {
    return this.listenerIdsFor(id, generation).length > 0;
  }

  private focusExpired(focus: Focus, nowMs: number): boolean {
    if (focus.speechEndedAtServerMs === undefined) return false;
    if (focus.outputStartedAtServerMs === undefined) {
      return nowMs - focus.speechEndedAtServerMs >= AUDIO_START_DEADLINE_MS;
    }
    return focus.lastOutputAtServerMs !== undefined
      && nowMs - focus.lastOutputAtServerMs >= this.config.focusReleaseSilenceMs;
  }

  private releaseSpeaker(id: string, generation: number): void {
    for (const [language, focus] of this.focusByOutputLanguage) {
      if (focus.speakerId === id && focus.generation === generation) {
        this.focusByOutputLanguage.delete(language);
      }
    }
  }

  private pruneCaptions(nowMs: number): void {
    while (this.captions[0] && nowMs - this.captions[0].atMs > CAPTION_RETENTION_MS) {
      this.captions.shift();
    }
  }

  private end(): void {
    this.ended = true;
    this.paused = true;
    this.focusByOutputLanguage.clear();
    this.captions.length = 0;
    for (const participant of this.participants.values()) {
      participant.connected = false;
      participant.state = "closed";
    }
  }
}
