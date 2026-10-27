/**
 * cascade エンジン: streaming ASR → 日本語の節単位の区切り → 文脈つき LLM 訳 → streaming TTS。
 * 設計・オプション・計測値は ./README.md。
 */
import { BYTES_PER_MS, type Engine, type EngineConfig, type EngineFactory, type EngineSecrets, type EngineSink } from "../../engine.ts";
import { glossarySourceTerms } from "../../prompts/glossary.ts";
import { RealtimeAsr } from "./asr.ts";
import { AudioPacer, OrderedAudioOutput, systemClock } from "./audio-out.ts";
import { estimateCascadeCostUsd } from "./cost.ts";
import { backchannelEnglish } from "./japanese.ts";
import { parseCascadeOptions, type CascadeOptions } from "./options.ts";
import { REALTIME_TTS_MODEL, RealtimeTts } from "./realtime-tts.ts";
import { Segmenter, type SegmentUnit } from "./segmenter.ts";
import { EnglishChunker } from "./text-stream.ts";
import { TranscriptAssembler } from "./transcript.ts";
import {
  buildFusedInstructions,
  buildTranslatorInput,
  buildTranslatorInstructions,
  hedgedStream,
  LlmError,
  sanitizeTranslation,
  streamTranslation,
  type HistoryEntry,
  type LlmCallResult,
} from "./translator.ts";
import { hedgedSpeech, streamSpeech, TTS_INSTRUCTIONS, type SpeechSource } from "./tts.ts";
import { EnergyVad, DEFAULT_VAD_CONFIG, type VadEvent } from "./vad.ts";

export const ASR_PROMPT =
  "鎌倉のコミュニティスペースでの日本語の対面会話。湘南での暮らし、地名、不動産（購入・賃貸・内見・契約）、ビザや移住の話題。";

type CommitReason = "silence" | "max" | "finish" | "server";

const now = (): number => performance.now();
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

/** finish の後に届いた遅着の出力を捨てる sink。 */
function guardSink(sink: EngineSink, isClosed: () => boolean): EngineSink {
  return {
    outputAudio: pcm => {
      if (!isClosed()) sink.outputAudio(pcm);
    },
    outputTranscript: (text, meta) => {
      if (!isClosed()) sink.outputTranscript(text, meta);
    },
    inputTranscript: (text, meta) => {
      if (!isClosed()) sink.inputTranscript(text, meta);
    },
    diag: (kind, data) => {
      if (!isClosed()) sink.diag(kind, data);
    },
    fatal: (code, detail) => {
      if (isClosed()) return;
      if (detail === undefined) sink.fatal(code);
      else sink.fatal(code, detail);
    },
  };
}

class CascadeEngine implements Engine {
  private readonly options: CascadeOptions;
  private readonly sink: EngineSink;
  private readonly abort = new AbortController();
  private closed = false;
  private readonly segmenter: Segmenter;
  private readonly assembler = new TranscriptAssembler();
  private readonly vad: EnergyVad | null;
  private readonly ordered: OrderedAudioOutput;
  private readonly pacer: AudioPacer;
  private readonly instructions: string;
  private readonly history: HistoryEntry[] = [];
  private asr: RealtimeAsr | null = null;
  private realtimeTts: RealtimeTts | null = null;
  private llmChain: Promise<void> = Promise.resolve();
  private readonly inflight = new Set<Promise<void>>();
  private ttsActive = 0;
  private readonly ttsWaiting: Array<() => void> = [];
  private readonly commitQueue: CommitReason[] = [];
  private readonly itemReason = new Map<string, CommitReason>();
  private readonly settledItems = new Set<string>();
  private pausePending = false;
  private serverSpeechActive = false;
  private firstDeltaSeen = false;
  private finishing = false;
  private stopped = false;
  private fatalRaised = false;
  private asrBilledSeconds = 0;
  private asrUsageSeen = false;
  private audioSentMs = 0;
  private llmInputTokens = 0;
  private llmCachedTokens = 0;
  private llmOutputTokens = 0;
  private llmHedges = 0;
  private llmCalls = 0;
  private ttsAudioMs = 0;
  private ttsInputChars = 0;
  /** 推定費用。finish の後に入る（単価の分からない構成では入らない）。 */
  costUsd?: number;

  constructor(
    config: EngineConfig,
    sink: EngineSink,
    private readonly secrets: EngineSecrets,
  ) {
    this.sink = guardSink(sink, () => this.closed);
    if (config.sourceLanguage !== "ja" || config.targetLanguage !== "en") {
      throw new Error("cascade supports ja→en only");
    }
    if (!secrets.openaiApiKey) throw new Error("OPENAI_API_KEY_REQUIRED");
    this.options = parseCascadeOptions(config.options);
    const o = this.options;
    this.segmenter = new Segmenter({
      mode: o.segmenter,
      minClauseChars: o.minClauseChars,
      minClauseMs: o.minClauseMs,
      softMaxMs: o.softMaxMs,
      hardMaxMs: o.hardMaxMs,
    });
    this.vad = o.asrVad === "client" ? new EnergyVad({ ...DEFAULT_VAD_CONFIG, commitSilenceMs: o.commitSilenceMs }) : null;
    this.pacer = new AudioPacer(o.paceAheadMs, systemClock, pcm => this.sink.outputAudio(pcm));
    this.ordered = new OrderedAudioOutput(pcm => this.pacer.push(pcm));
    this.instructions = o.llm === "realtime-mini"
      ? buildFusedInstructions({ glossary: o.glossary, domain: o.domain })
      : buildTranslatorInstructions({ glossary: o.glossary, domain: o.domain });
  }

  async start(): Promise<void> {
    const o = this.options;
    const asr = new RealtimeAsr(this.secrets.openaiApiKey, {
      model: o.asr,
      delay: o.asrDelay,
      vad: o.asrVad,
      eagerness: o.vadEagerness,
      noiseReduction: o.noiseReduction,
      prompt: o.domain ? ASR_PROMPT : "",
      keywords: o.glossary ? glossarySourceTerms() : [],
      languages: ["ja"],
    }, {
      onDelta: (itemId, delta) => this.onAsrDelta(itemId, delta),
      onCompleted: (itemId, transcript, seconds) => this.onAsrCompleted(itemId, transcript, seconds),
      onFailed: (itemId, code) => this.onAsrFailed(itemId, code),
      onCommitted: (itemId, previous) => this.onAsrCommitted(itemId, previous),
      onSpeechStarted: () => {
        this.serverSpeechActive = true;
        this.sink.diag("vad.speech_started", { source: "server" });
      },
      onSpeechStopped: () => {
        this.serverSpeechActive = false;
        this.sink.diag("vad.speech_stopped", { source: "server" });
      },
      onError: code => this.sink.diag("asr.error", { code }),
      onClose: code => {
        if (!this.finishing) this.raiseFatal("ASR_CLOSED", String(code));
      },
    });
    this.asr = asr;
    const tasks: Array<Promise<unknown>> = [asr.start()];
    if (o.llm !== "realtime-mini" || o.tts === "gpt-4o-mini-tts") tasks.push(this.warmUp());
    if (o.tts === "realtime-mini") {
      const tts = new RealtimeTts(this.secrets.openaiApiKey, o.voice, {
        onTranscriptMismatch: (tag, expected, spoken) => {
          this.sink.diag("tts.transcript_mismatch", { tag, expectedChars: expected.length, spokenChars: spoken.length });
          this.sink.diag("tts.transcript_mismatch.text", { tag, expected, spoken });
        },
        onClose: code => {
          if (!this.finishing) this.raiseFatal("TTS_CLOSED", String(code));
        },
      });
      this.realtimeTts = tts;
      tasks.push(tts.start());
    }
    try {
      await Promise.all(tasks);
    } catch (error) {
      // 片方だけ開いた接続を残さない（プロセスが終わらなくなる）。
      this.finishing = true;
      this.stopped = true;
      this.asr?.close();
      this.realtimeTts?.close();
      throw error;
    }
  }

  appendPcm(pcm: Buffer): void {
    if (this.stopped) return;
    this.audioSentMs += pcm.length / BYTES_PER_MS;
    this.asr?.append(pcm);
    if (this.vad) {
      for (const event of this.vad.process(pcm)) this.onVadEvent(event);
      if (this.pausePending && !this.vad.inSpeech && this.vad.silenceSinceVoiceMs >= this.options.pauseMs) {
        this.pausePending = false;
        this.handleUnits(this.segmenter.pause(now()));
      }
    }
    this.handleUnits(this.segmenter.tick(now()));
  }

  async finish(): Promise<void> {
    this.finishing = true;
    const deadline = now() + this.options.finishTimeoutMs;
    const asr = this.asr;
    const needsCommit = this.vad ? this.vad.hasSpeechSinceCommit : this.serverSpeechActive;
    if (asr && needsCommit && asr.commit()) {
      this.commitQueue.push("finish");
      this.vad?.markCommitted();
      this.sink.diag("asr.commit", { reason: "finish" });
    }
    await this.waitUntil(() => this.assembler.openItems === 0 || !this.asr?.open, Math.min(deadline, now() + 4_000));
    this.handleUnits(this.segmenter.flush(now()));
    await this.raceDeadline(this.allWork(), deadline - 500);
    if (this.pacer.heldMs + 300 > deadline - now()) this.pacer.flushAll();
    await this.raceDeadline(this.pacer.whenDrained(), deadline);
    this.pacer.flushAll();
    this.stopped = true;
    this.abort.abort();
    this.asr?.close();
    this.realtimeTts?.close();
    const realtime = this.realtimeTts?.usage;
    const billedSeconds = this.asrUsageSeen ? this.asrBilledSeconds : this.audioSentMs / 1_000;
    // hedge で中断した要求も入力 token は課金されうるので、1 要求あたりの平均入力を hedge 回数ぶん足す（概算）。
    const hedgeInputTokens = this.llmCalls > 0 ? Math.round((this.llmInputTokens / this.llmCalls) * this.llmHedges) : 0;
    const cost = estimateCascadeCostUsd({
      asrModel: this.options.asr,
      asrBilledSeconds: billedSeconds,
      llmModel: this.options.llm,
      llmTier: this.options.llmTier,
      llmInputTokens: this.llmInputTokens + hedgeInputTokens,
      llmCachedTokens: this.llmCachedTokens,
      llmOutputTokens: this.llmOutputTokens,
      tts: this.options.tts,
      ttsAudioMs: this.ttsAudioMs,
      ttsInputChars: this.ttsInputChars,
      realtimeTextInputTokens: realtime?.textInputTokens ?? 0,
      realtimeCachedInputTokens: realtime?.cachedInputTokens ?? 0,
      realtimeTextOutputTokens: realtime?.textOutputTokens ?? 0,
      realtimeAudioOutputTokens: realtime?.audioOutputTokens ?? 0,
    });
    const usage: Record<string, unknown> = {
      asrBilledSeconds: billedSeconds,
      audioSentMs: Math.round(this.audioSentMs),
      llmInputTokens: this.llmInputTokens,
      llmCachedTokens: this.llmCachedTokens,
      llmOutputTokens: this.llmOutputTokens,
      llmHedges: this.llmHedges,
      ttsAudioMs: Math.round(this.ttsAudioMs),
      ttsInputChars: this.ttsInputChars,
      asrRevisedAfterCut: this.segmenter.revisedBeforeCut,
    };
    if (realtime) usage.realtimeTts = { ...realtime };
    if (cost !== undefined) {
      this.costUsd = cost;
      usage.costUsd = Number(cost.toFixed(5));
    }
    this.sink.diag("usage", usage);
    this.closed = true;
  }

  // ---- ASR ----

  private onVadEvent(event: VadEvent): void {
    switch (event.type) {
      case "speech_start":
        this.pausePending = false;
        this.sink.diag("vad.speech_started", { source: "client" });
        return;
      case "speech_end":
        this.sink.diag("vad.speech_stopped", { source: "client", silenceMs: event.silenceMs });
        this.commit("silence");
        return;
      case "max_length":
        this.commit("max");
        return;
    }
  }

  private commit(reason: CommitReason): void {
    if (this.asr?.commit()) {
      this.commitQueue.push(reason);
      this.sink.diag("asr.commit", { reason });
    }
  }

  private onAsrDelta(itemId: string, delta: string): void {
    if (!this.firstDeltaSeen) {
      this.firstDeltaSeen = true;
      this.sink.diag("asr.first_delta");
    }
    this.sink.inputTranscript(delta, { itemId });
    this.assembler.delta(itemId, delta);
    this.handleUnits(this.segmenter.update(this.assembler.text, now()));
  }

  private onAsrCommitted(itemId: string, previousItemId: string | null): void {
    this.assembler.committed(itemId, previousItemId);
    const reason: CommitReason = this.options.asrVad === "semantic" ? (this.commitQueue.shift() ?? "server") : (this.commitQueue.shift() ?? "silence");
    this.itemReason.set(itemId, reason);
  }

  private onAsrCompleted(itemId: string, transcript: string, seconds: number | null): void {
    if (seconds !== null) {
      this.asrUsageSeen = true;
      this.asrBilledSeconds += seconds;
    }
    this.sink.inputTranscript(transcript, { itemId, final: true });
    const result = this.assembler.completed(itemId, transcript);
    this.sink.diag("asr.item_completed", { itemId, finalChars: result.finalChars, deltaChars: result.deltaChars, revised: result.revised });
    this.settle();
  }

  private onAsrFailed(itemId: string, code: string): void {
    this.sink.diag("asr.item_failed", { itemId, code });
    this.assembler.failed(itemId);
    this.settle();
  }

  /** 先頭から確定した item を順に区切りへ反映する（確定順が前後しても S の順で処理する）。 */
  private settle(): void {
    const t = now();
    const units: SegmentUnit[] = [];
    for (const itemId of this.assembler.finalItemsInOrder()) {
      if (this.settledItems.has(itemId)) continue;
      this.settledItems.add(itemId);
      units.push(...this.segmenter.update(this.assembler.textThrough(itemId), t));
      const reason = this.itemReason.get(itemId) ?? (this.options.asrVad === "semantic" ? "server" : "silence");
      if (reason === "max") continue;
      units.push(...this.segmenter.markBoundary(t));
      if (reason === "server" || reason === "finish") {
        units.push(...this.segmenter.pause(t));
      } else if (this.vad && !this.vad.inSpeech && this.vad.silenceSinceVoiceMs >= this.options.pauseMs) {
        units.push(...this.segmenter.pause(t));
      } else {
        this.pausePending = true;
      }
    }
    units.push(...this.segmenter.update(this.assembler.text, t));
    this.handleUnits(units);
  }

  // ---- units → LLM → TTS ----

  private handleUnits(units: ReadonlyArray<SegmentUnit>): void {
    for (const unit of units) {
      this.sink.diag("segment.committed", {
        segmentId: unit.segmentId,
        chars: unit.chars,
        reason: unit.reason,
        end: unit.end,
        kind: unit.kind,
        sinceFirstCharMs: Math.round(unit.committedMs - unit.firstCharMs),
      });
      this.sink.diag("segment.text", { segmentId: unit.segmentId, text: unit.text });
      if (unit.reason === "forced") this.sink.diag("segment.forced", { segmentId: unit.segmentId });
      if (unit.kind === "filler" || (unit.kind === "backchannel" && this.options.backchannel === "drop")) {
        this.sink.diag("segment.dropped", { segmentId: unit.segmentId, kind: unit.kind });
        continue;
      }
      const fixed = unit.kind === "backchannel" ? backchannelEnglish(unit.text) : null;
      const task = this.llmChain.then(() => this.translate(unit, fixed));
      this.llmChain = task.catch(() => undefined);
      this.track(task);
    }
  }

  private async translate(unit: SegmentUnit, fixed: string | null): Promise<void> {
    if (this.stopped) return;
    const segmentId = unit.segmentId;
    let chunkIndex = 0;
    const speak = (text: string): void => {
      const clean = sanitizeTranslation(text);
      if (clean.length > 0) this.enqueueTts(segmentId, chunkIndex++, clean);
    };
    if (fixed !== null) {
      this.sink.outputTranscript(fixed, { segmentId, final: true });
      this.history.push({ ja: unit.text, en: fixed });
      speak(fixed);
      return;
    }
    const o = this.options;
    if (o.llm === "realtime-mini") {
      await this.translateFused(unit);
      return;
    }
    const chunker = new EnglishChunker(o.ttsChunk);
    const input = buildTranslatorInput(this.history, unit, o.context);
    const started = now();
    this.sink.diag("llm.request", { segmentId, model: o.llm, tier: o.llmTier, contextUnits: Math.min(this.history.length, o.context) });
    let firstSeen = false;
    const result = await this.callTranslator(segmentId, {
      model: o.llm,
      instructions: this.instructions,
      input,
      maxOutputTokens: Math.min(600, 60 + unit.chars * 4),
      serviceTier: o.llmTier,
    }, delta => {
      if (!firstSeen) {
        firstSeen = true;
        this.sink.diag("llm.first_token", { segmentId, ms: Math.round(now() - started) });
      }
      for (const chunk of chunker.push(delta)) speak(chunk);
    });
    const rest = chunker.finish();
    if (rest) speak(rest);
    if (!result) return;
    if (result.usage) {
      this.llmCalls++;
      this.llmInputTokens += result.usage.inputTokens;
      this.llmCachedTokens += result.usage.cachedTokens;
      this.llmOutputTokens += result.usage.outputTokens;
    }
    const english = sanitizeTranslation(result.text);
    this.sink.diag("llm.done", {
      segmentId,
      ms: Math.round(now() - started),
      attemptMs: Math.round(result.totalMs),
      headersMs: Math.round(result.headersMs),
      chars: english.length,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
    });
    if (english.length === 0) {
      this.sink.diag("llm.empty", { segmentId });
      return;
    }
    this.sink.outputTranscript(english, { segmentId, final: true });
    this.history.push({ ja: unit.text, en: english });
    if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
  }

  /** Responses API を呼ぶ（hedge・1 回の出し直しつき。translator.ts の hedgedStream）。 */
  private callTranslator(
    segmentId: string,
    base: { readonly model: string; readonly instructions: string; readonly input: string; readonly maxOutputTokens: number; readonly serviceTier: "default" | "priority" },
    onDelta: (delta: string) => void,
  ): Promise<LlmCallResult | null> {
    return hedgedStream(
      (signal, forward) => streamTranslation({ apiKey: this.secrets.openaiApiKey, ...base, signal, onDelta: forward }),
      onDelta,
      {
        hedgeMs: this.options.llmHedgeMs,
        signal: this.abort.signal,
        onHedge: () => {
          this.llmHedges++;
          this.sink.diag("llm.hedge", { segmentId, afterMs: this.options.llmHedgeMs });
        },
        onError: (error, attempt) => {
          this.sink.diag("llm.error", { segmentId, code: error instanceof LlmError ? error.code : "LLM_ERROR", attempt });
        },
      },
    );
  }

  /** fused: 訳と発話を realtime モデルの 1 応答で行う。英訳文字列は応答音声の transcript。 */
  private async translateFused(unit: SegmentUnit): Promise<void> {
    const tts = this.realtimeTts;
    if (!tts) return;
    const o = this.options;
    const segmentId = unit.segmentId;
    const key = `${segmentId}#0`;
    this.ordered.open(key);
    const started = now();
    this.sink.diag("llm.request", { segmentId, model: REALTIME_TTS_MODEL, fused: true, contextUnits: Math.min(this.history.length, o.context) });
    let firstSeen = false;
    try {
      const result = await tts.respond({
        instructions: this.instructions,
        input: buildTranslatorInput(this.history, unit, o.context),
        onAudio: pcm => {
          if (!firstSeen) {
            firstSeen = true;
            this.sink.diag("tts.first_audio", { segmentId, chunk: 0, ms: Math.round(now() - started), fused: true });
          }
          this.ttsAudioMs += pcm.length / BYTES_PER_MS;
          this.ordered.push(key, pcm);
        },
      });
      const english = sanitizeTranslation(result.transcript);
      this.sink.diag("llm.done", { segmentId, ms: Math.round(result.totalMs), chars: english.length, fused: true });
      this.sink.diag("tts.done", {
        segmentId,
        chunk: 0,
        ms: Math.round(result.totalMs),
        bytes: result.bytes,
        audioMs: Math.round(result.bytes / BYTES_PER_MS),
        attempts: 1,
      });
      if (english.length === 0) {
        this.sink.diag("llm.empty", { segmentId });
        return;
      }
      this.sink.outputTranscript(english, { segmentId, final: true });
      this.history.push({ ja: unit.text, en: english });
    } catch (error) {
      this.sink.diag("llm.error", { segmentId, code: error instanceof Error ? error.message : "FUSED_ERROR", attempt: 1 });
    } finally {
      this.ordered.close(key);
    }
  }

  private enqueueTts(segmentId: string, chunk: number, text: string): void {
    const key = `${segmentId}#${chunk}`;
    this.ordered.open(key);
    this.ttsInputChars += text.length;
    const task = (async () => {
      await this.acquireTts();
      try {
        if (this.stopped) return;
        const engine = this.options.tts;
        this.sink.diag("tts.request", { segmentId, chunk, chars: text.length, engine });
        const requested = now();
        let firstSeen = false;
        const onAudio = (pcm: Buffer): void => {
          if (!firstSeen) {
            firstSeen = true;
            this.sink.diag("tts.first_audio", { segmentId, chunk, ms: Math.round(now() - requested) });
          }
          this.ttsAudioMs += pcm.length / BYTES_PER_MS;
          this.ordered.push(key, pcm);
        };
        const http: SpeechSource = (forward, signal) => streamSpeech({
          apiKey: this.secrets.openaiApiKey,
          model: "gpt-4o-mini-tts",
          voice: this.options.voice,
          input: text,
          instructions: TTS_INSTRUCTIONS,
          firstByteTimeoutMs: this.options.ttsFirstByteTimeoutMs,
          onAudio: forward,
          signal,
        });
        const realtime = this.realtimeTts;
        const result = realtime
          ? await hedgedSpeech((forward, signal) => realtime.speak(text, forward, signal), this.options.ttsHedgeMs > 0 ? http : null, this.options.ttsHedgeMs, onAudio, {
            signal: this.abort.signal,
            onHedge: reason => this.sink.diag("tts.hedge", { segmentId, chunk, reason, afterMs: Math.round(now() - requested) }),
          })
          : { ...(await http(onAudio, this.abort.signal)), source: "primary" as const };
        this.sink.diag("tts.done", {
          segmentId,
          chunk,
          ms: Math.round(result.totalMs),
          bytes: result.bytes,
          audioMs: Math.round(result.bytes / BYTES_PER_MS),
          attempts: result.attempts,
          source: result.source,
        });
      } catch (error) {
        this.sink.diag("tts.error", { segmentId, chunk, code: error instanceof Error ? error.message : "TTS_ERROR" });
      } finally {
        this.ordered.close(key);
        this.releaseTts();
      }
    })();
    this.track(task);
  }

  private acquireTts(): Promise<void> {
    if (this.ttsActive < this.options.ttsConcurrency) {
      this.ttsActive++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.ttsWaiting.push(() => {
        this.ttsActive++;
        resolve();
      });
    });
  }

  private releaseTts(): void {
    this.ttsActive--;
    this.ttsWaiting.shift()?.();
  }

  // ---- helpers ----

  private track(task: Promise<void>): void {
    const guarded = task.catch(() => undefined);
    this.inflight.add(guarded);
    void guarded.then(() => this.inflight.delete(guarded));
  }

  private async allWork(): Promise<void> {
    for (let guard = 0; guard < 1_000; guard++) {
      await this.llmChain;
      if (this.inflight.size === 0) return;
      await Promise.all([...this.inflight]);
    }
  }

  private async raceDeadline(task: Promise<unknown>, until: number): Promise<void> {
    await Promise.race([task.then(() => undefined, () => undefined), sleep(until - now())]);
  }

  private async waitUntil(predicate: () => boolean, until: number): Promise<void> {
    while (!predicate() && now() < until) await sleep(50);
  }

  private async warmUp(): Promise<void> {
    // HTTPS の接続を先に張っておく（最初の LLM / TTS の TLS ハンドシェイクを省く）。費用は掛からない。
    const request = async (): Promise<void> => {
      try {
        const model = this.options.llm === "realtime-mini" ? "gpt-4o-mini-tts" : this.options.llm;
        const response = await fetch(`https://api.openai.com/v1/models/${model}`, {
          headers: { Authorization: `Bearer ${this.secrets.openaiApiKey}` },
          signal: AbortSignal.timeout(3_000),
        });
        await response.arrayBuffer();
      } catch {
        // 失敗しても本処理には影響しない
      }
    };
    await Promise.all([request(), request()]);
  }

  private raiseFatal(code: string, detail?: string): void {
    if (this.fatalRaised) return;
    this.fatalRaised = true;
    this.stopped = true;
    if (detail === undefined) this.sink.fatal(code);
    else this.sink.fatal(code, detail);
  }
}

const createCascadeEngine: EngineFactory = (config, sink, secrets) => new CascadeEngine(config, sink, secrets);

export default createCascadeEngine;
