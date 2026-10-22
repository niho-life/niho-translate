export const PROTOCOL_VERSION = 1 as const;
export const AUDIO_SAMPLE_RATE = 24_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_BYTES_PER_SAMPLE = 2;
export const AUDIO_FRAME_MS = 20;
export const AUDIO_BATCH_MS = 100;
export const AUDIO_FRAME_BYTES = 960;
export const AUDIO_BATCH_BYTES = 4_800;
export const MAX_AUDIO_BATCH_BYTES = 9_600;
export const MAX_JSON_BYTES = 32_768;
export const MAX_ID_LENGTH = 128;
export const MAX_CAPTION_DELTA_LENGTH = 4_096;
export const MAX_DELIVERY_ID = Number.MAX_SAFE_INTEGER;

export type Language = "ja" | "en";
export type ParticipantRole = "host" | "guest";
export type ConnectionState = "connecting" | "ready" | "paused" | "closed";
export type RoomControlAction = "start" | "pause" | "resume" | "end";
export type ErrorCode =
  | "INVALID_MESSAGE" | "UNAUTHORIZED" | "ROOM_FULL" | "ROOM_ENDED"
  | "STALE_GENERATION" | "NOT_READY" | "LEASE_DENIED" | "LEASE_EXPIRED"
  | "AUDIO_LIMIT" | "PROVIDER_ERROR" | "BACKPRESSURE" | "INTERNAL";

const ERROR_CODES: ReadonlySet<string> = new Set([
  "INVALID_MESSAGE", "UNAUTHORIZED", "ROOM_FULL", "ROOM_ENDED",
  "STALE_GENERATION", "NOT_READY", "LEASE_DENIED", "LEASE_EXPIRED",
  "AUDIO_LIMIT", "PROVIDER_ERROR", "BACKPRESSURE", "INTERNAL",
]);

export interface ParticipantView {
  participantId: string;
  sourceLanguage: Language;
  targetLanguage: Language;
  role: ParticipantRole;
  generation: number;
  state: ConnectionState;
}

export type ServerEventPayload =
  | { v: 1; type: "session.identity"; participantId: string; generation: number }
  | { v: 1; type: "room.state"; roomId: string; roomEpoch: string; active: boolean; paused: boolean; ended: boolean }
  | { v: 1; type: "participant.state"; participant: ParticipantView; connected: boolean }
  | { v: 1; type: "caption.delta"; speakerId: string; generation: number; language: Language; captionOnly: boolean; delta: string; atMs: number }
  | { v: 1; type: "audio"; speakerId: string; generation: number; language: Language; audio: string; speechEndedAtMs?: number }
  | { v: 1; type: "route"; canCapture: boolean; reason: "active" | "host-not-ready" | "paused" | "ended" | "no-listener" | "blocked" }
  | { v: 1; type: "latency.status"; status: "unknown" | "estimated"; milliseconds?: number }
  | { v: 1; type: "error"; code: ErrorCode; fatal: boolean };

export type ServerEvent = ServerEventPayload & { deliveryId: number };
export type InitialUnauthorizedServerEvent = {
  v: 1;
  type: "error";
  code: "UNAUTHORIZED";
  fatal: true;
};
export type WireServerEvent = ServerEvent | InitialUnauthorizedServerEvent;

export type ClientEvent =
  | { v: 1; type: "client.ready" }
  | { v: 1; type: "client.ping" }
  | { v: 1; type: "client.ack"; deliveryId: number }
  | { v: 1; type: "capture.pause" }
  | { v: 1; type: "capture.resume" }
  | { v: 1; type: `room.${RoomControlAction}` }
  | { v: 1; type: "speech.start"; atMs: number }
  | { v: 1; type: "speech.end"; atMs: number }
  | { v: 1; type: "audio.append"; audio: string; atMs: number };

export class ProtocolValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProtocolValidationError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError("not_object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(object: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const key of required) {
    if (!(key in object)) throw new ProtocolValidationError(`missing_${key}`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new ProtocolValidationError(`unknown_${key}`);
  }
}

function idValue(value: unknown, name: string, max = MAX_ID_LENGTH): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f]/u.test(value)) {
    throw new ProtocolValidationError(`invalid_${name}`);
  }
  return value;
}

function captionValue(value: unknown): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > MAX_CAPTION_DELTA_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  ) {
    throw new ProtocolValidationError("invalid_delta");
  }
  return value;
}

function timeValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolValidationError("invalid_atMs");
  }
  return value;
}

function generationValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ProtocolValidationError("invalid_generation");
  }
  return value;
}

function deliveryIdValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_DELIVERY_ID) {
    throw new ProtocolValidationError("invalid_deliveryId");
  }
  return value;
}

export function isLanguage(value: unknown): value is Language {
  return value === "ja" || value === "en";
}

export function oppositeLanguage(value: Language): Language {
  return value === "ja" ? "en" : "ja";
}

export function validateLanguagePair(source: unknown, target: unknown): asserts source is Language {
  if (!isLanguage(source) || !isLanguage(target) || source === target) {
    throw new ProtocolValidationError("invalid_language_pair");
  }
}

function decodeCanonicalBase64(value: unknown, maximumBytes: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maximumBytes / 3) * 4) {
    throw new ProtocolValidationError("invalid_audio_length");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ProtocolValidationError("invalid_audio_base64");
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value || bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new ProtocolValidationError("invalid_audio_base64");
  }
  return bytes;
}

export function decodeInputPcmBase64(value: unknown): Uint8Array {
  const bytes = decodeCanonicalBase64(value, MAX_AUDIO_BATCH_BYTES);
  if (bytes.byteLength % AUDIO_FRAME_BYTES !== 0) {
    throw new ProtocolValidationError("invalid_pcm_alignment");
  }
  return bytes;
}

export function decodeOutputPcmBase64(value: unknown): Uint8Array {
  const bytes = decodeCanonicalBase64(value, MAX_AUDIO_BATCH_BYTES);
  if (bytes.byteLength % AUDIO_BYTES_PER_SAMPLE !== 0) {
    throw new ProtocolValidationError("invalid_pcm_alignment");
  }
  return bytes;
}

/** @deprecated Use decodeInputPcmBase64 for client input. */
export const decodePcmBase64 = decodeInputPcmBase64;

export function validateClientEvent(raw: string | Uint8Array): ClientEvent {
  const byteLength = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (byteLength > MAX_JSON_BYTES) throw new ProtocolValidationError("json_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new ProtocolValidationError("invalid_json");
  }
  const object = record(parsed);
  if (object.v !== PROTOCOL_VERSION || typeof object.type !== "string") {
    throw new ProtocolValidationError("invalid_envelope");
  }
  switch (object.type) {
    case "client.ready":
    case "client.ping":
    case "capture.pause":
    case "capture.resume":
    case "room.start":
    case "room.pause":
    case "room.resume":
    case "room.end":
      exactKeys(object, ["v", "type"]);
      return object as unknown as ClientEvent;
    case "client.ack":
      exactKeys(object, ["v", "type", "deliveryId"]);
      deliveryIdValue(object.deliveryId);
      return object as unknown as ClientEvent;
    case "speech.start":
    case "speech.end":
      exactKeys(object, ["v", "type", "atMs"]);
      timeValue(object.atMs);
      return object as unknown as ClientEvent;
    case "audio.append":
      exactKeys(object, ["v", "type", "audio", "atMs"]);
      decodeInputPcmBase64(object.audio);
      timeValue(object.atMs);
      return object as unknown as ClientEvent;
    default:
      throw new ProtocolValidationError("unknown_type");
  }
}

export function validateServerEvent(value: unknown): WireServerEvent {
  const object = record(value);
  if (object.v !== PROTOCOL_VERSION || typeof object.type !== "string") {
    throw new ProtocolValidationError("invalid_envelope");
  }
  const initialUnauthorized = object.type === "error"
    && object.code === "UNAUTHORIZED"
    && object.fatal === true
    && object.deliveryId === undefined;
  const common = initialUnauthorized ? ["v", "type"] : ["v", "type", "deliveryId"];
  if (!initialUnauthorized) deliveryIdValue(object.deliveryId);
  switch (object.type) {
    case "session.identity":
      exactKeys(object, [...common, "participantId", "generation"]);
      idValue(object.participantId, "participantId");
      generationValue(object.generation);
      break;
    case "room.state":
      exactKeys(object, [...common, "roomId", "roomEpoch", "active", "paused", "ended"]);
      idValue(object.roomId, "roomId");
      idValue(object.roomEpoch, "roomEpoch");
      if ([object.active, object.paused, object.ended].some(item => typeof item !== "boolean")) {
        throw new ProtocolValidationError("invalid_state");
      }
      break;
    case "participant.state":
      exactKeys(object, [...common, "participant", "connected"]);
      if (typeof object.connected !== "boolean") throw new ProtocolValidationError("invalid_connected");
      validateParticipant(object.participant);
      break;
    case "caption.delta":
      exactKeys(object, [...common, "speakerId", "generation", "language", "captionOnly", "delta", "atMs"]);
      idValue(object.speakerId, "speakerId");
      generationValue(object.generation);
      if (!isLanguage(object.language)) throw new ProtocolValidationError("invalid_language");
      if (typeof object.captionOnly !== "boolean") throw new ProtocolValidationError("invalid_captionOnly");
      captionValue(object.delta);
      timeValue(object.atMs);
      break;
    case "audio":
      exactKeys(object, [...common, "speakerId", "generation", "language", "audio"], ["speechEndedAtMs"]);
      idValue(object.speakerId, "speakerId");
      generationValue(object.generation);
      if (!isLanguage(object.language)) throw new ProtocolValidationError("invalid_language");
      decodeOutputPcmBase64(object.audio);
      if (object.speechEndedAtMs !== undefined) timeValue(object.speechEndedAtMs);
      break;
    case "route":
      exactKeys(object, [...common, "canCapture", "reason"]);
      if (
        typeof object.canCapture !== "boolean"
        || !["active", "host-not-ready", "paused", "ended", "no-listener", "blocked"].includes(String(object.reason))
      ) {
        throw new ProtocolValidationError("invalid_route");
      }
      break;
    case "latency.status":
      exactKeys(object, [...common, "status"], ["milliseconds"]);
      if (!["unknown", "estimated"].includes(String(object.status))) throw new ProtocolValidationError("invalid_latency");
      if (object.milliseconds !== undefined) timeValue(object.milliseconds);
      break;
    case "error":
      exactKeys(object, [...common, "code", "fatal"]);
      if (typeof object.code !== "string" || !ERROR_CODES.has(object.code) || typeof object.fatal !== "boolean") {
        throw new ProtocolValidationError("invalid_error");
      }
      break;
    default:
      throw new ProtocolValidationError("unknown_type");
  }
  return object as unknown as WireServerEvent;
}

function validateParticipant(value: unknown): void {
  const object = record(value);
  exactKeys(object, ["participantId", "sourceLanguage", "targetLanguage", "role", "generation", "state"]);
  idValue(object.participantId, "participantId");
  validateLanguagePair(object.sourceLanguage, object.targetLanguage);
  if (!["host", "guest"].includes(String(object.role))) throw new ProtocolValidationError("invalid_role");
  generationValue(object.generation);
  if (!["connecting", "ready", "paused", "closed"].includes(String(object.state))) {
    throw new ProtocolValidationError("invalid_connection_state");
  }
}
