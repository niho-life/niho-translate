/**
 * クライアント側のエネルギー VAD（純粋・音声時刻ベース）。
 * gpt-live-transcribe は turn_detection を持たないので、無音で input_audio_buffer.commit する時点を決める。
 * 雑音床は直近 3 秒の最小レベルで追い、閾値 = max(absoluteFloorDb, 雑音床 + marginDb)。
 */

export interface VadConfig {
  /** 発話の後にこの長さの無音が続いたら speech_end（= commit）。 */
  readonly commitSilenceMs: number;
  /** 発話開始とみなす連続有声の長さ。 */
  readonly minSpeechMs: number;
  readonly absoluteFloorDb: number;
  readonly marginDb: number;
  /** 1 item がこの長さを超えたら、次の無声の小区間で commit する。 */
  readonly maxItemMs: number;
  /** 1 item がこの長さを超えたら、有声でも commit する。 */
  readonly forceItemMs: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  commitSilenceMs: 500,
  minSpeechMs: 60,
  absoluteFloorDb: -50,
  marginDb: 12,
  maxItemMs: 15_000,
  forceItemMs: 20_000,
};

export type VadEvent =
  | { readonly type: "speech_start"; readonly atMs: number }
  | { readonly type: "speech_end"; readonly atMs: number; readonly silenceMs: number }
  | { readonly type: "max_length"; readonly atMs: number };

const SUBFRAME_SAMPLES = 240; // 10 ms at 24 kHz
const SUBFRAME_MS = 10;
const FLOOR_WINDOW = 300; // 3 s
const MAX_NOISE_FLOOR_DB = -40;

export class EnergyVad {
  private carry: Buffer = Buffer.alloc(0);
  private processedMs = 0;
  private readonly history: number[] = [];
  private speech = false;
  private voicedRunMs = 0;
  private silenceMs = 0;
  private sinceVoiceMs = Number.POSITIVE_INFINITY;
  private itemMs = 0;
  private itemHasSpeech = false;

  constructor(private readonly config: VadConfig = DEFAULT_VAD_CONFIG) {}

  get audioMs(): number {
    return this.processedMs;
  }

  get inSpeech(): boolean {
    return this.speech;
  }

  /** 最後の有声小区間からの無音の長さ（発話がまだ無ければ Infinity）。 */
  get silenceSinceVoiceMs(): number {
    return this.sinceVoiceMs;
  }

  /** 前回の commit 以降に発話があったか。 */
  get hasSpeechSinceCommit(): boolean {
    return this.itemHasSpeech;
  }

  /** VAD の event 以外で commit を送ったら呼ぶ（finish など）。item の長さを数え直す。 */
  markCommitted(): void {
    this.itemMs = 0;
    this.itemHasSpeech = this.speech;
  }

  process(pcm: Buffer): VadEvent[] {
    const events: VadEvent[] = [];
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, pcm]) : pcm;
    const bytesPerSubframe = SUBFRAME_SAMPLES * 2;
    let offset = 0;
    for (; offset + bytesPerSubframe <= data.length; offset += bytesPerSubframe) {
      this.subframe(data, offset, events);
    }
    this.carry = Buffer.from(data.subarray(offset));
    return events;
  }

  private subframe(data: Buffer, offset: number, events: VadEvent[]): void {
    let sum = 0;
    for (let i = 0; i < SUBFRAME_SAMPLES; i++) {
      const v = data.readInt16LE(offset + i * 2);
      sum += v * v;
    }
    const rms = Math.sqrt(sum / SUBFRAME_SAMPLES);
    const db = rms > 0 ? 20 * Math.log10(rms / 32_768) : -120;
    this.history.push(db);
    if (this.history.length > FLOOR_WINDOW) this.history.shift();
    let floor = 0;
    for (const value of this.history) floor = Math.min(floor, value);
    // 雑音床は -90〜-40 dBFS に収める（冒頭から話し始めても、発話を雑音と取り違えないため）。
    const noiseFloor = Math.min(Math.max(floor, -90), MAX_NOISE_FLOOR_DB);
    const threshold = Math.max(this.config.absoluteFloorDb, noiseFloor + this.config.marginDb);
    const voiced = db > threshold;
    this.processedMs += SUBFRAME_MS;
    this.itemMs += SUBFRAME_MS;
    const atMs = this.processedMs;

    if (voiced) {
      this.sinceVoiceMs = 0;
    } else if (Number.isFinite(this.sinceVoiceMs)) {
      this.sinceVoiceMs += SUBFRAME_MS;
    }

    if (!this.speech) {
      this.voicedRunMs = voiced ? this.voicedRunMs + SUBFRAME_MS : 0;
      if (this.voicedRunMs >= this.config.minSpeechMs) {
        this.speech = true;
        this.itemHasSpeech = true;
        this.silenceMs = 0;
        events.push({ type: "speech_start", atMs });
      }
    } else {
      this.silenceMs = voiced ? 0 : this.silenceMs + SUBFRAME_MS;
      if (this.silenceMs >= this.config.commitSilenceMs) {
        this.speech = false;
        this.voicedRunMs = 0;
        // 呼び出し側はこの event で commit する。item の長さはここで数え直す。
        this.itemMs = 0;
        this.itemHasSpeech = false;
        events.push({ type: "speech_end", atMs, silenceMs: this.silenceMs });
        return;
      }
    }

    if (this.itemHasSpeech && ((this.itemMs >= this.config.maxItemMs && !voiced) || this.itemMs >= this.config.forceItemMs)) {
      this.itemMs = 0;
      this.itemHasSpeech = this.speech;
      events.push({ type: "max_length", atMs });
    }
  }
}
