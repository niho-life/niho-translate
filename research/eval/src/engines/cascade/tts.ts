/**
 * TTS: /v1/audio/speech（gpt-4o-mini-tts, response_format=pcm = 24 kHz mono PCM16）を stream で読む。
 * 最初の音声が firstByteTimeoutMs 以内に来なければ 1 回だけ出し直す（音声が出始めた後は出し直さない）。
 */
import { PcmAligner } from "./audio-out.ts";

export const TTS_INSTRUCTIONS =
  "You are the English voice of a simultaneous interpreter. Speak calmly and clearly at a natural, slightly brisk conversational pace. Read the text exactly as written.";

export interface SpeechResult {
  readonly firstAudioMs: number | null;
  readonly totalMs: number;
  readonly bytes: number;
  readonly attempts: number;
}

export interface SpeechParams {
  readonly apiKey: string;
  readonly model: string;
  readonly voice: string;
  readonly input: string;
  readonly instructions: string;
  readonly firstByteTimeoutMs: number;
  readonly onAudio: (pcm: Buffer) => void;
  /** エンジン終了時の中断。 */
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export class TtsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function attempt(params: SpeechParams, started: number, timeoutMs: number | null, onFirst: () => void): Promise<{ bytes: number; firstAudioMs: number | null }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const now = params.now ?? (() => performance.now());
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  params.signal?.addEventListener("abort", onOuterAbort, { once: true });
  let gotAudio = false;
  const timer = timeoutMs === null ? null : setTimeout(() => {
    if (!gotAudio) controller.abort();
  }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${params.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: params.model,
          voice: params.voice,
          input: params.input,
          instructions: params.instructions,
          response_format: "pcm",
          stream_format: "audio",
        }),
        signal: controller.signal,
      });
    } catch {
      throw new TtsError(controller.signal.aborted ? "TTS_FIRST_BYTE_TIMEOUT" : "TTS_NETWORK");
    }
    if (!response.ok || !response.body) throw new TtsError(`TTS_HTTP_${response.status}`);
    const aligner = new PcmAligner();
    const reader = response.body.getReader();
    let bytes = 0;
    let firstAudioMs: number | null = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const pcm = aligner.push(value);
        if (!pcm) continue;
        if (!gotAudio) {
          gotAudio = true;
          firstAudioMs = now() - started;
          onFirst();
        }
        bytes += pcm.length;
        params.onAudio(pcm);
      }
    } catch {
      throw new TtsError(gotAudio ? "TTS_STREAM_BROKEN" : controller.signal.aborted ? "TTS_FIRST_BYTE_TIMEOUT" : "TTS_STREAM_READ");
    }
    return { bytes, firstAudioMs };
  } finally {
    if (timer !== null) clearTimeout(timer);
    params.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function streamSpeech(params: SpeechParams): Promise<SpeechResult> {
  const now = params.now ?? (() => performance.now());
  const started = now();
  let audioStarted = false;
  const markStarted = (): void => {
    audioStarted = true;
  };
  try {
    const first = await attempt(params, started, params.firstByteTimeoutMs, markStarted);
    return { firstAudioMs: first.firstAudioMs, totalMs: now() - started, bytes: first.bytes, attempts: 1 };
  } catch (error) {
    if (audioStarted || params.signal?.aborted) throw error;
  }
  const second = await attempt(params, started, null, markStarted);
  return { firstAudioMs: second.firstAudioMs, totalMs: now() - started, bytes: second.bytes, attempts: 2 };
}

/** 音声の出どころ（TTS 1 本）。onAudio は届いたそのままの chunk。 */
export type SpeechSource = (onAudio: (pcm: Buffer) => void, signal: AbortSignal) => Promise<SpeechResult>;

export interface HedgedSpeechResult extends SpeechResult {
  readonly source: "primary" | "fallback";
}

/**
 * 主の TTS が hedgeMs 以内に音声を返さなければ（または音声の前に失敗したら）予備の TTS を並行して始め、
 * 先に音声を返した方だけを使う。負けた方は中断する。両方失敗したら最後のエラーを投げる。
 */
export async function hedgedSpeech(
  primary: SpeechSource,
  fallback: SpeechSource | null,
  hedgeMs: number,
  onAudio: (pcm: Buffer) => void,
  hooks: { readonly onHedge?: (reason: "timeout" | "error") => void; readonly signal?: AbortSignal } = {},
): Promise<HedgedSpeechResult> {
  type Which = "primary" | "fallback";
  let winner: Which | null = null;
  const controllers: Partial<Record<Which, AbortController>> = {};
  const runs: Partial<Record<Which, Promise<SpeechResult>>> = {};
  let wake: () => void = () => undefined;
  const settled: Partial<Record<Which, { ok: true; value: SpeechResult } | { ok: false; error: unknown }>> = {};
  const launch = (which: Which, source: SpeechSource): void => {
    const controller = new AbortController();
    controllers[which] = controller;
    const signal = hooks.signal ? AbortSignal.any([controller.signal, hooks.signal]) : controller.signal;
    runs[which] = source(pcm => {
      if (winner === null) {
        winner = which;
        const other = which === "primary" ? "fallback" : "primary";
        controllers[other]?.abort();
        wake();
      }
      if (winner === which) onAudio(pcm);
    }, signal);
    runs[which].then(
      value => {
        settled[which] = { ok: true, value };
        wake();
      },
      (error: unknown) => {
        settled[which] = { ok: false, error };
        wake();
      },
    );
  };
  launch("primary", primary);
  const timer = fallback && hedgeMs > 0
    ? setTimeout(() => {
      if (winner === null && !runs.fallback && !hooks.signal?.aborted) {
        hooks.onHedge?.("timeout");
        launch("fallback", fallback);
      }
    }, hedgeMs)
    : null;
  try {
    for (;;) {
      if (winner !== null) {
        const value = await (runs[winner] as Promise<SpeechResult>);
        return { ...value, source: winner };
      }
      const primaryDone = settled.primary;
      const fallbackDone = settled.fallback;
      // 音声を 1 つも返さずに成功した（空の音声）なら、その結果を返す。
      if (primaryDone?.ok) return { ...primaryDone.value, source: "primary" };
      if (fallbackDone?.ok) return { ...fallbackDone.value, source: "fallback" };
      if (primaryDone && !runs.fallback && fallback && !hooks.signal?.aborted) {
        hooks.onHedge?.("error");
        launch("fallback", fallback);
        continue;
      }
      if (primaryDone && (!runs.fallback || fallbackDone)) {
        throw fallbackDone && !fallbackDone.ok ? fallbackDone.error : primaryDone.error;
      }
      await new Promise<void>(resolve => {
        wake = resolve;
      });
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
