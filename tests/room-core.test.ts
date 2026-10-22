import { describe, expect, it } from "vitest";
import {
  AUDIO_START_DEADLINE_MS,
  ROOM_MAX_LIFETIME_MS,
  RoomActor,
  SEAT_RESERVATION_MS,
} from "../packages/room-core/src/index.ts";

const guest = (id: string, sourceLanguage: "ja" | "en" = "ja") => ({
  roomId: "r",
  roomEpoch: "e",
  participantId: id,
  role: "guest" as const,
  sourceLanguage,
  targetLanguage: sourceLanguage === "ja" ? "en" as const : "ja" as const,
  admissionId: `${id}-admission`,
});
const host = { ...guest("h", "ja"), role: "host" as const };

function activeRoom(config = { focusReleaseSilenceMs: 1_500 }): RoomActor {
  const room = new RoomActor("r", "e", config, 0);
  room.admit(host, 0);
  room.admit(guest("en-1", "en"), 0);
  room.markReady("h", 1);
  room.markReady("en-1", 1);
  expect(room.applyControl("h", 1, "start", 0)).toBe(true);
  return room;
}

describe("RoomActor security and lifecycle", () => {
  it("allows only host plus one guest, reserves the guest seat, and permits only same-participant reconnect", () => {
    const room = new RoomActor("r", "e");
    expect(room.admit(host, 0).ok).toBe(true);
    expect(room.admit(guest("a", "en"), 0).ok).toBe(true);
    expect(room.admit(guest("third", "en"), 0)).toEqual({ ok: false, code: "ROOM_FULL" });
    expect(room.disconnect("a", 1, 1)).toBe(true);
    expect(room.admit(guest("new"), SEAT_RESERVATION_MS - 1)).toEqual({ ok: false, code: "ROOM_FULL" });
    expect(room.admit(guest("a", "en"), SEAT_RESERVATION_MS - 1)).toEqual({ ok: true, generation: 2 });
  });

  it("does not start on ready and permits room control only to the ready host", () => {
    const room = new RoomActor("r", "e");
    room.admit(host, 0);
    room.admit(guest("en-1", "en"), 0);
    room.markReady("h", 1);
    room.markReady("en-1", 1);
    expect(room.canCapture("h", 1)).toBe(false);
    expect(room.applyControl("en-1", 1, "start", 0)).toBe(false);
    expect(room.applyControl("h", 1, "start", 0)).toBe(true);
    expect(room.canCapture("h", 1)).toBe(true);
    expect(room.applyControl("h", 1, "pause", 1)).toBe(true);
    expect(room.canCapture("h", 1)).toBe(false);
    expect(room.applyControl("h", 1, "resume", 2)).toBe(true);
    expect(room.canCapture("h", 1)).toBe(true);
  });

  it("keeps listening while a participant's own capture is paused", () => {
    const room = activeRoom();
    room.setCapturePaused("en-1", 1, true);
    expect(room.canCapture("en-1", 1)).toBe(false);
    expect(room.listenerIdsFor("h", 1)).toEqual(["en-1"]);
  });

  it("invalidates old generation and suppresses old callbacks", () => {
    const room = activeRoom();
    expect(room.admit(host, 1)).toEqual({ ok: true, generation: 2, replacedGeneration: 1 });
    expect(room.isCurrent("h", 1)).toBe(false);
    expect(room.addCaption({
      speakerId: "h",
      generation: 1,
      language: "en",
      captionOnly: false,
      delta: "late",
      atMs: 1,
    }, 1)).toBe(false);
  });

  it("irreversibly ends at the room lifetime limit", () => {
    const lifetimeRoom = activeRoom();
    lifetimeRoom.tick(ROOM_MAX_LIFETIME_MS);
    expect(lifetimeRoom.isEnded()).toBe(true);
    expect(lifetimeRoom.admit(host, ROOM_MAX_LIFETIME_MS + 1)).toEqual({ ok: false, code: "ROOM_ENDED" });
  });

  it("waits up to ten seconds for first output, then releases by output idle", () => {
    const room = activeRoom({ focusReleaseSilenceMs: 1_500 });
    expect(room.startSpeech("h", 1, 100)).toBe(true);
    expect(room.endSpeech("h", 1, 200)).toBe(true);
    expect(room.mayPlayAudio("h", 1, 200 + AUDIO_START_DEADLINE_MS - 1)).toBe(true);
    expect(room.mayPlayAudio("h", 1, 200 + AUDIO_START_DEADLINE_MS)).toBe(true);
    room.tick(200 + AUDIO_START_DEADLINE_MS + 1_500);
    expect(room.mayPlayAudio("h", 1, 200 + AUDIO_START_DEADLINE_MS + 1_500)).toBe(false);

    const stale = activeRoom();
    stale.startSpeech("h", 1, 100);
    stale.endSpeech("h", 1, 200);
    expect(stale.mayPlayAudio("h", 1, 200 + AUDIO_START_DEADLINE_MS)).toBe(false);
  });

  it("keeps JA-to-EN and EN-to-JA focus independent and never lets late audio acquire focus", () => {
    const room = activeRoom({ focusReleaseSilenceMs: 100 });
    room.startSpeech("h", 1, 10);
    room.startSpeech("en-1", 1, 20);
    expect(room.mayPlayAudio("h", 1, 30)).toBe(true);
    expect(room.mayPlayAudio("en-1", 1, 30)).toBe(true);
    room.endSpeech("h", 1, 40);
    expect(room.mayPlayAudio("h", 1, 50)).toBe(true);
    room.tick(150);
    expect(room.mayPlayAudio("h", 1, 151)).toBe(false);
    expect(room.mayPlayAudio("en-1", 1, 151)).toBe(true);
    room.endSpeech("en-1", 1, 160);
    room.startSpeech("en-1", 1, 170);
    expect(room.estimatedSpeechEndedAt("en-1", 1)).toBeUndefined();
    expect(room.mayPlayAudio("en-1", 1, 171)).toBe(true);

    const late = activeRoom();
    late.startSpeech("h", 1, 100);
    late.endSpeech("h", 1, 200);
    late.tick(200 + AUDIO_START_DEADLINE_MS);
    expect(late.mayPlayAudio("h", 1, 200 + AUDIO_START_DEADLINE_MS)).toBe(false);
  });
});
