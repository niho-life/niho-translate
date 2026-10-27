import { describe, expect, it } from "vitest";
import { frameBytesFor, lateStats, planFrames, sendFramesPaced, type PacingClock } from "../src/pacing.ts";

class FakeClock implements PacingClock {
  current = 1_000;
  readonly sleeps: number[] = [];

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }
}

describe("frameBytesFor", () => {
  it("accepts only 100 ms and 200 ms frames aligned to 960 bytes", () => {
    expect(frameBytesFor(100)).toBe(4_800);
    expect(frameBytesFor(200)).toBe(9_600);
    expect(frameBytesFor(200) % 960).toBe(0);
    expect(() => frameBytesFor(50)).toThrow("INVALID_FRAME_MS");
    expect(() => frameBytesFor(300)).toThrow("INVALID_FRAME_MS");
  });
});

describe("planFrames", () => {
  it("zero-pads the last window frame and appends whole tail-silence frames", () => {
    const pcm = Buffer.alloc(10_000, 7);
    const plan = planFrames(pcm, 200, 6_000);
    expect(plan.windowFrameCount).toBe(2);
    expect(plan.tailFrameCount).toBe(30);
    expect(plan.frames).toHaveLength(32);
    expect(plan.frames.every(frame => frame.length === 9_600)).toBe(true);
    expect(plan.frames[1]![399]).toBe(7);
    expect(plan.frames[1]![400]).toBe(0);
    expect(plan.frames[2]!.every(byte => byte === 0)).toBe(true);
    expect(planFrames(pcm, 100, 150).tailFrameCount).toBe(2);
  });
});

describe("sendFramesPaced", () => {
  it("schedules every frame at t0 + i*frameMs without carrying lateness forward", async () => {
    const clock = new FakeClock();
    const frames = Array.from({ length: 6 }, () => Buffer.alloc(9_600));
    const order: string[] = [];
    const result = await sendFramesPaced({
      frames,
      frameMs: 200,
      clock,
      send: (_frame, index) => {
        order.push(`send:${index}`);
        // frame 2 の送信中に event loop が 250 ms 止まった。
        if (index === 2) clock.current += 250;
      },
      shouldStop: () => false,
      onSent: record => order.push(`record:${record.idx}`),
    });
    expect(result.t0).toBe(1_000);
    const offsets = result.sent.map(record => record.sentAt - result.t0!);
    expect(offsets).toEqual([0, 200, 400, 650, 800, 1_000]);
    expect(result.sent.map(record => record.scheduledT)).toEqual([0, 200, 400, 600, 800, 1_000]);
    expect(lateStats(result.sent, result.t0)).toEqual({ count: 6, maxLateMs: 50, meanLateMs: 50 / 6 });
    expect(order.slice(0, 4)).toEqual(["record:0", "send:0", "record:1", "send:1"]);
  });

  it("stops before the next frame when asked", async () => {
    const clock = new FakeClock();
    let sent = 0;
    const result = await sendFramesPaced({
      frames: Array.from({ length: 10 }, () => Buffer.alloc(4_800)),
      frameMs: 100,
      clock,
      send: () => { sent += 1; },
      shouldStop: () => sent >= 3,
    });
    expect(result.sent).toHaveLength(3);
    // 3 本目の送信後は待たずに止まる。
    expect(clock.current - 1_000).toBe(200);
  });

  it("reports no t0 when nothing was sent", async () => {
    const result = await sendFramesPaced({
      frames: [Buffer.alloc(9_600)],
      frameMs: 200,
      clock: new FakeClock(),
      send: () => {},
      shouldStop: () => true,
    });
    expect(result.t0).toBeUndefined();
    expect(lateStats(result.sent, result.t0)).toEqual({ count: 0, maxLateMs: 0, meanLateMs: 0 });
  });
});
