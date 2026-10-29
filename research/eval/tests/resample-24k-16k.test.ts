import { describe, expect, it } from "vitest";
import { Pcm24To16Resampler } from "../src/engines/resample-24k-16k.ts";

function pcm(samples: readonly number[]): Buffer {
  const result = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
  return result;
}

function sine(frequency: number, durationSeconds = 1): Buffer {
  return pcm(Array.from({ length: 24_000 * durationSeconds }, (_, n) =>
    Math.round(10_000 * Math.sin(2 * Math.PI * frequency * n / 24_000))));
}

function rms(buffer: Buffer): number {
  let energy = 0;
  for (let offset = 0; offset < buffer.length; offset += 2) energy += buffer.readInt16LE(offset) ** 2;
  return Math.sqrt(energy / (buffer.length / 2));
}

describe("Pcm24To16Resampler", () => {
  it("preserves the expected duration for 100 ms and 200 ms frames", () => {
    const resampler = new Pcm24To16Resampler();
    expect(resampler.process(Buffer.alloc(4_800)).length).toBe(3_200);
    expect(resampler.process(Buffer.alloc(9_600)).length).toBe(6_400);
  });

  it("produces identical PCM regardless of frame boundaries", () => {
    const input = sine(1_237);
    const oneShot = new Pcm24To16Resampler().process(input);
    const chunked = new Pcm24To16Resampler();
    const pieces: Buffer[] = [];
    for (let offset = 0; offset < input.length; offset += 2_546) {
      pieces.push(chunked.process(input.subarray(offset, offset + 2_546)));
    }
    expect(Buffer.concat(pieces)).toEqual(oneShot);
  });

  it("passes speech-band energy and suppresses a 10 kHz tone that would alias", () => {
    const low = new Pcm24To16Resampler().process(sine(1_000)).subarray(200);
    const high = new Pcm24To16Resampler().process(sine(10_000)).subarray(200);
    expect(rms(low)).toBeGreaterThan(6_000);
    expect(rms(high) / rms(low)).toBeLessThan(0.05);
  });

  it("rejects partial PCM16 samples", () => {
    expect(() => new Pcm24To16Resampler().process(Buffer.alloc(3))).toThrow("PCM16_ODD_BYTE_LENGTH");
  });
});
