/**
 * ASR: OpenAI Realtime の transcription session（wss://api.openai.com/v1/realtime?intent=transcription）。
 * - gpt-live-transcribe: turn_detection は null のみ。音声の到着中に delta が来て、commit で最終文字列が来る。
 * - gpt-transcribe: 比較用。server の semantic_vad（または client commit）で区切った turn ごとに文字起こしする。
 * 一次資料: https://developers.openai.com/api/docs/guides/realtime-transcription（2026-10-28 確認）。
 */
import { WebSocket, type RawData } from "ws";
import type { AsrDelay, AsrModel, AsrVad, NoiseReduction, VadEagerness } from "./options.ts";

export const ASR_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

export interface AsrSessionOptions {
  readonly model: AsrModel;
  readonly delay: AsrDelay;
  readonly vad: AsrVad;
  readonly eagerness: VadEagerness;
  readonly noiseReduction: NoiseReduction;
  readonly prompt: string;
  readonly keywords: ReadonlyArray<string>;
  readonly languages: ReadonlyArray<string>;
}

export interface AsrEvents {
  onDelta(itemId: string, delta: string): void;
  onCompleted(itemId: string, transcript: string, usageSeconds: number | null): void;
  onFailed(itemId: string, code: string): void;
  onCommitted(itemId: string, previousItemId: string | null): void;
  onSpeechStarted(): void;
  onSpeechStopped(): void;
  /** セッション中のエラー（code のみ。本文・鍵を含めない）。 */
  onError(code: string): void;
  onClose(code: number): void;
}

/** session.update の本体（純関数・テスト対象）。 */
export function transcriptionSessionUpdate(options: AsrSessionOptions): Record<string, unknown> {
  const transcription: Record<string, unknown> = {
    model: options.model,
    languages: [...options.languages],
  };
  if (options.prompt.length > 0) transcription.prompt = options.prompt;
  const keywords = options.keywords.filter(word => word.length > 0 && !/[<>\r\n]/u.test(word));
  if (keywords.length > 0) transcription.keywords = keywords;
  if (options.model === "gpt-live-transcribe") transcription.delay = options.delay;
  const turnDetection = options.vad === "semantic" ? { type: "semantic_vad", eagerness: options.eagerness } : null;
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          noise_reduction: options.noiseReduction === "none" ? null : { type: options.noiseReduction },
          transcription,
          turn_detection: turnDetection,
        },
      },
    },
  };
}

export class RealtimeAsr {
  private socket: WebSocket | null = null;
  private closedByUs = false;
  private appendedSinceCommit = 0;

  constructor(
    private readonly apiKey: string,
    private readonly options: AsrSessionOptions,
    private readonly events: AsrEvents,
  ) {}

  /** 接続し session.updated を待つ。 */
  start(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(ASR_URL, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      this.socket = socket;
      let ready = false;
      const timer = setTimeout(() => {
        if (!ready) {
          reject(new Error("ASR_START_TIMEOUT"));
          socket.close();
        }
      }, timeoutMs);
      socket.on("open", () => {
        socket.send(JSON.stringify(transcriptionSessionUpdate(this.options)));
      });
      socket.on("message", (raw: RawData) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!ready && event.type === "session.updated") {
          ready = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (!ready && event.type === "error") {
          clearTimeout(timer);
          reject(new Error(`ASR_SESSION_${errorCode(event)}`));
          socket.close();
          return;
        }
        this.onEvent(event);
      });
      socket.on("close", (code: number) => {
        clearTimeout(timer);
        if (!ready) reject(new Error("ASR_CLOSED_BEFORE_READY"));
        else if (!this.closedByUs) this.events.onClose(code);
      });
      socket.on("error", () => {
        // close が続く。鍵や本文を含めない。
      });
    });
  }

  get open(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** commit 以降に送った音声の byte 数。 */
  get bytesSinceCommit(): number {
    return this.appendedSinceCommit;
  }

  append(pcm: Buffer): void {
    if (!this.open || pcm.length === 0) return;
    this.socket?.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
    this.appendedSinceCommit += pcm.length;
  }

  /** 送った音声が 100 ms 以上あれば commit する（空 commit はエラーになる）。 */
  commit(): boolean {
    if (!this.open || this.appendedSinceCommit < 4_800) return false;
    this.socket?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.appendedSinceCommit = 0;
    return true;
  }

  /** server VAD が commit したとき（semantic_vad）。 */
  private serverCommitted(): void {
    this.appendedSinceCommit = 0;
  }

  close(): void {
    this.closedByUs = true;
    this.socket?.close();
  }

  private onEvent(event: Record<string, unknown>): void {
    const itemId = typeof event.item_id === "string" ? event.item_id : "";
    switch (event.type) {
      case "conversation.item.input_audio_transcription.delta":
        if (typeof event.delta === "string" && event.delta.length > 0) this.events.onDelta(itemId, event.delta);
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const usage = event.usage as { type?: unknown; seconds?: unknown } | undefined;
        const seconds = usage?.type === "duration" && typeof usage.seconds === "number" ? usage.seconds : null;
        this.events.onCompleted(itemId, typeof event.transcript === "string" ? event.transcript : "", seconds);
        return;
      }
      case "conversation.item.input_audio_transcription.failed":
        this.events.onFailed(itemId, errorCode(event));
        return;
      case "input_audio_buffer.committed":
        if (this.options.vad === "semantic") this.serverCommitted();
        this.events.onCommitted(itemId, typeof event.previous_item_id === "string" ? event.previous_item_id : null);
        return;
      case "input_audio_buffer.speech_started":
        this.events.onSpeechStarted();
        return;
      case "input_audio_buffer.speech_stopped":
        this.events.onSpeechStopped();
        return;
      case "error":
        this.events.onError(errorCode(event));
        return;
      default:
        return;
    }
  }
}

function errorCode(event: Record<string, unknown>): string {
  const error = event.error as { code?: unknown; type?: unknown } | undefined;
  if (typeof error?.code === "string") return error.code;
  if (typeof error?.type === "string") return error.type;
  return "error";
}
