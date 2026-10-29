/** 24 kHz PCM16 → 16 kHz PCM16。状態を保持し、frame 境界でも位相と FIR 履歴を引き継ぐ。 */
const INPUT_RATE = 24_000;
const CUTOFF_HZ = 7_000; // 16 kHz の Nyquist (8 kHz) より低くして折り返しを抑える。
const TAP_COUNT = 49;

function lowPassTaps(): Float64Array {
  const taps = new Float64Array(TAP_COUNT);
  const half = (TAP_COUNT - 1) / 2;
  let sum = 0;
  for (let k = 0; k < TAP_COUNT; k++) {
    const m = k - half;
    const cutoff = CUTOFF_HZ / INPUT_RATE;
    const sinc = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
    const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * k / (TAP_COUNT - 1))
      + 0.08 * Math.cos(4 * Math.PI * k / (TAP_COUNT - 1));
    taps[k] = sinc * window;
    sum += taps[k]!;
  }
  for (let k = 0; k < TAP_COUNT; k++) taps[k] = taps[k]! / sum;
  return taps;
}

const TAPS = lowPassTaps();

export class Pcm24To16Resampler {
  private readonly history = new Float64Array(TAP_COUNT);
  private historyIndex = 0;
  private inputSamples = 0;
  /** 次の出力位置を 1/2 入力サンプル単位で表す（増分 3 = 1.5 samples）。 */
  private nextOutputHalfSample = 0;
  private previousFiltered = 0;

  process(pcm: Buffer): Buffer {
    if (pcm.length % 2 !== 0) throw new Error("PCM16_ODD_BYTE_LENGTH");
    const output: number[] = [];
    for (let offset = 0; offset < pcm.length; offset += 2) {
      this.history[this.historyIndex] = pcm.readInt16LE(offset);
      let filtered = 0;
      for (let k = 0; k < TAP_COUNT; k++) {
        filtered += TAPS[k]! * this.history[(this.historyIndex - k + TAP_COUNT) % TAP_COUNT]!;
      }
      this.historyIndex = (this.historyIndex + 1) % TAP_COUNT;
      const currentHalfSample = this.inputSamples * 2;
      if (this.nextOutputHalfSample <= currentHalfSample) {
        const fractional = this.nextOutputHalfSample % 2;
        const value = fractional ? (this.previousFiltered + filtered) / 2 : filtered;
        output.push(Math.max(-32768, Math.min(32767, Math.round(value))));
        this.nextOutputHalfSample += 3;
      }
      this.previousFiltered = filtered;
      this.inputSamples++;
    }
    const result = Buffer.allocUnsafe(output.length * 2);
    output.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
    return result;
  }
}
