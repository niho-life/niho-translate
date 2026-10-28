/**
 * runDir/report.md（private。原文・訳文を含む）。
 */
import type { JudgeDocument, JudgedSegment, LatencyStats, ReferenceDocument } from "../engine.ts";
import type { Usage } from "./openai.ts";
import { AGREEMENT_WARN_BELOW } from "./asr.ts";
import { crossCheckVerdict } from "./transcript.ts";
import type { EnSentence, OutputWordsDocument } from "./types.ts";

export interface ReportContext {
  readonly doc: JudgeDocument;
  readonly reference: ReferenceDocument;
  readonly words: OutputWordsDocument;
  readonly sentences: ReadonlyArray<EnSentence>;
  readonly windowBeforeMs: number;
  readonly windowAfterMs: number;
  readonly batches: number;
  readonly llmCalls: number;
  /** 判定の呼び出しごとの所要時間（秒）。 */
  readonly callSeconds: ReadonlyArray<number>;
  readonly usage: Usage;
  readonly generatedAtIso: string;
}

export function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

export function sec(ms: number | null, digits = 2): string {
  return ms === null ? "—" : (ms / 1000).toFixed(digits);
}

export function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function latencyLine(label: string, s: LatencyStats): string {
  return `| ${label} p50 / p95 / max (s) | ${sec(s.p50)} / ${sec(s.p95)} / ${sec(s.max)}（n=${s.n}、≤5 s ${pct(s.within5s)}、≤8 s ${pct(s.within8s)}） |`;
}

function factsCell(seg: JudgedSegment): string {
  if (seg.facts.length === 0) return "—";
  return cell(seg.facts.map((f) => `${f.text}=${f.verdict}`).join("; "));
}

function uncoveredRuns(ctx: ReportContext): Array<{ startMs: number; text: string }> {
  const aligned = ctx.doc.segments.filter((s) => s.aligned && s.enStartMs !== null && s.enEndMs !== null);
  const covered = (ms: number): boolean => aligned.some((s) => (s.enStartMs as number) <= ms && ms <= (s.enEndMs as number));
  const runs: Array<{ startMs: number; text: string }> = [];
  let current: { startMs: number; parts: string[] } | null = null;
  let lastSentence = -1;
  const sentenceOf = new Map<number, number>();
  for (const s of ctx.sentences) for (let i = s.wordStart; i <= s.wordEnd; i += 1) sentenceOf.set(i, s.index);
  const flush = (): void => {
    if (current) runs.push({ startMs: current.startMs, text: current.parts.join(" ") });
    current = null;
  };
  for (const w of ctx.words.words) {
    const sentence = sentenceOf.get(w.i) ?? -1;
    if (covered(w.startMs)) {
      flush();
      continue;
    }
    if (current && sentence !== lastSentence) flush();
    if (!current) current = { startMs: w.startMs, parts: [] };
    current.parts.push(w.text);
    lastSentence = sentence;
  }
  flush();
  return runs;
}

function secondsSummary(xs: ReadonlyArray<number>): string {
  if (xs.length === 0) return "—";
  const sorted = [...xs].sort((a, b) => a - b);
  const median = sorted[Math.ceil(sorted.length / 2) - 1] ?? 0;
  return `中央値 ${median} s / 最大 ${sorted.at(-1) ?? 0} s（${xs.length} 回）`;
}

export function renderReport(ctx: ReportContext): string {
  const { doc, reference } = ctx;
  const a = doc.aggregate;
  const refById = new Map(reference.segments.map((s) => [s.id, s]));
  const flags = Object.entries(a.flagCounts)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const byType = Object.entries(a.factErrorsByType ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const out: string[] = [
    "# 同時通訳 判定レポート（private）",
    "",
    `- runId: ${doc.runId}`,
    `- engine: ${doc.engineId} / source: ${doc.sourceId}`,
    `- 判定: ${doc.judge.model}${doc.judge.effort ? `（reasoning effort ${doc.judge.effort}）` : ""} / prompt ${doc.judge.promptVersion} / ASR ${doc.judge.asr}`,
    `- 作成: ${ctx.generatedAtIso}`,
    "",
    "## 集計",
    "",
    "| 指標 | 値 |",
    "|---|---|",
    `| 区間（全体 / 採点対象 statement・question / うち対応あり） | ${a.n} / ${a.nScored} / ${a.nAligned} |`,
    latencyLine("lStart", a.lStart),
    latencyLine("lEnd", a.lEnd),
    latencyLine("lTail", a.lTail),
    `| meaning 平均（分布 0/1/2/3） | ${a.meaningMean === null ? "—" : a.meaningMean.toFixed(2)}（${a.meaningDist["0"]}/${a.meaningDist["1"]}/${a.meaningDist["2"]}/${a.meaningDist["3"]}） |`,
    `| facts ok / wrong / omitted / unclear | ${a.factTotals.ok} / ${a.factTotals.wrong} / ${a.factTotals.omitted} / ${a.factTotals.unclear} |`,
    `| 重大誤り（数・時刻・金額・否定・地名・条件・主体の wrong） | ${a.criticalFactErrors} |`,
    `| 型ごとの wrong | ${byType || "なし"} |`,
    `| flags | ${flags || "なし"} |`,
    "",
    "## 区間ごとの判定",
    "",
    "| id | kind | JA (s) | JA | EN (s) | EN | lStart (s) | lEnd (s) | lTail (s) | meaning | facts | flags | note |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const seg of doc.segments) {
    const ref = refById.get(seg.id);
    const jaTime = ref ? `${sec(ref.startMs)}–${sec(ref.endMs)}` : "—";
    const enTime = seg.aligned ? `${sec(seg.enStartMs)}–${sec(seg.enEndMs)}` : "—";
    out.push(
      `| ${cell(seg.id)} | ${seg.kind}${ref?.uncertain ? "（原稿不確か）" : ""} | ${jaTime} | ${cell(ref?.text ?? "")} | ${enTime} | ${cell(seg.enText ?? "（訳なし）")} | ${sec(seg.lStartMs)} | ${sec(seg.lEndMs)} | ${sec(seg.lTailMs)} | ${seg.meaning} | ${factsCell(seg)} | ${seg.flags.join(", ") || "—"} | ${cell(seg.note)} |`,
    );
  }
  out.push("", "## ASR とエンジン字幕の一致率", "");
  const ag = ctx.words.agreement;
  if (!ag) {
    out.push("エンジン字幕（output-transcript.txt）が無いため算出なし（ASR は prompt なし）。");
  } else {
    const low = ag.perMinute.filter((m) => m.agreement !== null && m.agreement < AGREEMENT_WARN_BELOW);
    out.push(
      `全体: 一致率 ${pct(ag.agreement)}（ASR の語 ${ag.asrTokens} のうち字幕と順序どおり対応した割合）/ 字幕の再現率 ${pct(ag.coverage)}（字幕の語 ${ag.subtitleTokens}）。`,
      low.length > 0
        ? `**警告: 一致率 ${Math.round(AGREEMENT_WARN_BELOW * 100)}% 未満の分 ${low.map((m) => m.minute).join(", ")}。ASR の崩れか、訳音声そのものが字幕と食い違っている（字幕先行・訳音声欠落）かのどちらか。別の ASR での読み直しが whisper と一致していれば後者で、この時間帯の未対応・誤りは聞き手にもそう聞こえている。**`
        : `一致率 ${Math.round(AGREEMENT_WARN_BELOW * 100)}% 未満の分はなし。`,
      "",
      "| 分 | ASR の語 | 一致率 | 字幕の語 | 字幕の再現率 | 警告 | 別 ASR での読み直し |",
      "|---:|---:|---:|---:|---:|---|---|",
    );
    for (const m of ag.perMinute) {
      const warn = m.agreement !== null && m.agreement < AGREEMENT_WARN_BELOW ? "一致率低" : "";
      const cc = m.crossCheck;
      const verdict = cc ? crossCheckVerdict(cc) : null;
      const label =
        verdict === "audio-differs-from-transcript"
          ? "ASR どうしは一致し字幕と合わない: 訳音声が字幕と違う"
          : verdict === "whisper-suspect"
            ? "別 ASR は字幕と一致: whisper の崩れの疑い"
            : "判断できない";
      const cross = !cc ? "" : `${cc.model} の語 ${cc.tokens}: whisper にある ${pct(cc.inWhisper)}、字幕にある ${pct(cc.withTranscript)}（${label}）`;
      out.push(`| ${m.minute} | ${m.asrTokens} | ${pct(m.agreement)} | ${m.subtitleTokens} | ${pct(m.coverage)} | ${warn} | ${cross} |`);
    }
  }
  const runs = uncoveredRuns(ctx);
  out.push("", "## どの区間にも対応づかなかった英語", "");
  if (runs.length === 0) out.push("なし");
  else {
    out.push("| 開始 (s) | 英語 |", "|---|---|");
    for (const r of runs) out.push(`| ${sec(r.startMs)} | ${cell(r.text)} |`);
  }
  out.push(
    "",
    "## 注記",
    "",
    "- p50 / p95 は最近傍順位法（昇順に並べて ceil(p/100 × n) 番目）。",
    "- 遅延の p50 / p95 / max は backchannel を除き、訳が対応した区間だけの値（n はその件数）。≤5 s / ≤8 s、meaning、facts、重大誤りは statement・question の全件が分母で、未対応の区間は meaning 0・遅延なし（≤8 s に入らない）として数える。",
    "- lStart = 対応する英語の最初の語の開始 − 原文区間の開始、lEnd = 同 − 原文区間の終了（負なら話し終わる前に訳が始まった）、lTail = 対応する英語の最後の語の終了 − 原文区間の終了。",
    `- 英語の時刻は ${doc.judge.asr} の単語時刻（output-timeline.wav のファイル内時刻 = t、理想再生モデル上の再生位置）。長い音声を 1 回で読ませると whisper が無音や崩れた窓のあとで無関係な文を出し続けるため、エネルギーで有声区間（閾値 ${ctx.words.thresholdDb ?? "—"} dBFS、間 1.5 s 未満は結合、25 s 超は最小エネルギー点で分割、前後 0.3 s の余白）に分け、区間ごとに呼んだ（${ctx.words.regions.length} 区間、送信 ${sec(ctx.words.sentMs, 1)} s / 元 ${sec(ctx.words.audioMs, 1)} s）。${ctx.words.asr.prompt === "engine-transcript" ? "prompt には区間の開始 −3 s（＋最大 queue）〜終了 +1 s に届いたエンジン字幕から、数字・略語・固有名詞だけを語の一覧で渡した（同じ綴りを使わせるため。字幕の文そのものを渡すと whisper が同じ内容を読み飛ばした）。" : "エンジン字幕が無いため prompt なし。"}語の時刻は区間の開始を足して t に戻した。完全無音の上に置かれた ${ctx.words.droppedSilentWords} 語を幻聴として除き、語頭・語尾が無音にかかる語は音のある位置へ寄せた（whisper は休止の後の最初の語を早めに置く傾向がある）。`,
    `- LLM には ${ctx.batches} 組（呼び出し ${ctx.llmCalls} 回）に分け、対象区間の開始 −${sec(ctx.windowBeforeMs, 0)} s〜終了 +${sec(ctx.windowAfterMs, 0)} s に始まる英単語と前後 3 区間の文脈を渡した。これより遅れた訳は未対応になる。時刻は LLM に出させず、選ばせた語 index から引いた。`,
    `- token: input ${ctx.usage.inputTokens} / output ${ctx.usage.outputTokens}（うち reasoning ${ctx.usage.reasoningTokens}）。判定 1 回の所要時間: ${secondsSummary(ctx.callSeconds)}。`,
    doc.judge.model.startsWith("agy:")
      ? `- 判定器は agy 経由の ${doc.judge.model.slice(4)}（OpenAI 以外）。ASR（${doc.judge.asr}）は OpenAI のまま。OpenAI の判定との違いは compare.ts で数値で比べる。ASR の聞き違いは判定に混ざる。`
      : `- 判定器（${doc.judge.model}）と ASR（${doc.judge.asr}）も OpenAI のモデルであり、OpenAI のエンジンを評価するときに同系統の偏り（言い回しの好み、同じ聞き違い）が出得る（--judge-backend agy で OpenAI 以外の判定と比べられる）。ASR の聞き違いは判定に混ざる。重要な結論は人手で抜き取り確認する。`,
  );
  return `${out.join("\n")}\n`;
}
