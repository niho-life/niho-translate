# 同時通訳 比較評価ハーネス（research/eval）

追跡Issue: [#21](https://github.com/niho-life/niho-translate/issues/21)。設計の背景は [docs/translation-quality-research.md](../../docs/translation-quality-research.md)。

目的: 同じ日本語音声を実時間で複数の通訳エンジンへ流し、**意味対応する英語音声の開始遅延**と**意味精度**を同じ正解原稿・同じ判定器で比較する。オーナー基準は「発話開始→対応する英語音声の開始が概ね5秒、最大8秒」「日本語の文意が伝わる英語」。

このディレクトリは公開リポジトリの一部である。**音声・原文・訳文・実データのpath・APIキーをここに置かない。** 実データと実行結果は `EVAL_PRIVATE_DIR`（Git管理外の私有フォルダ）にだけ書く。

## 1. 構成と担当

| path | 役割 | 担当 |
|---|---|---|
| `src/engine.ts` | エンジン契約・スキーマ（本文書と一体。変更はメイン担当のみ） | main |
| `src/prompts/` | 通訳指示プリセットと合成用語集（変更はメイン担当のみ） | main |
| `src/run.ts`, `src/audio.ts`, `src/timeline.ts`, `src/pacing.ts`, `src/engines/openai-translate.ts`, `src/engines/openai-live.ts`, `src/engines/openai-realtime.ts`, `src/engines/gemini-live-translate.ts`, `src/engines/qwen-live-translate.ts`, `src/engines/index.ts` | ハーネス本体と OpenAI 3 エンジン＋Gemini / Qwen Live Translate | main / agent A |
| `src/engines/cascade/**` | カスケード型（ASR→区切り→LLM訳→TTS）の試作。`src/engines/cascade/index.ts` が `EngineFactory` を export する | agent B |
| `src/reference/**` | 正解原稿（時刻付き日本語区間）作成ツール | agent C |
| `src/judge/**`, `src/aggregate.ts` | 判定器（EN 単語時刻→区間対応→意味採点）と集計 | agent D |
| `tests/` | 純関数の単体テスト（担当ごとにファイルを分ける: `harness-*.test.ts`, `cascade-*.test.ts`, `reference-*.test.ts`, `judge-*.test.ts`） | 各担当 |

`src/engines/index.ts` は `engineId → EngineFactory` の表。agent A が作り、`cascade` は `./cascade/index.ts` の default export を lazy import する（B が未完成でも A の typecheck が通るよう、import 失敗は実行時エラーにする）。

## 2. 時間基準と実時間送信

- 入力は ffmpeg で 24 kHz mono PCM16 に変換した window（`--window start:end` 秒）。
- `t0` = 最初の frame を `engine.appendPcm` に渡した瞬間（`performance.now()`）。以後の時刻 `t` はすべて t0 からの ms。`engine.start()` 完了は負の `t` で記録。
- frame `i` は `t0 + i*frameMs` に送る（絶対時刻へのスケジューリング、drift 補正あり）。実送信との差 `late` を記録。無音も含め全部送る。
- window 終端後、`--tail-silence-sec`（既定 6）の完全無音を実時間で送り、その後 `engine.finish()`。finish は最大 `--finish-timeout-sec`（既定 20）待つ。
- 出力音声は到着順に **理想再生モデル**へ入れる: `playStart_k = max(t_k, playEnd_{k-1})`, `playEnd_k = playStart_k + bytes_k / 48`。`queueMs_k = max(0, playEnd_{k-1} − t_k)`。iOS の保持上限 96,000 byte（2,000 ms）超えを `over2000` として数える。
- 字幕 delta の `t` は到着時刻。

## 3. 実行結果（すべて `EVAL_PRIVATE_DIR/runs/<runId>/`）

`runId = <YYYYMMDD-HHMMSS>-<engineId>-<sourceId>-<4文字乱数>`。

| file | 内容 |
|---|---|
| `config.json` | `EngineConfig` と CLI 引数（入力 path は含めない。`sourceId` だけ） |
| `events.jsonl` | `RunEvent` を 1 行ずつ（本文を含む。private） |
| `summary.json` | `RunSummary`（本文なし。公開レポートへ転記可） |
| `source.wav` | 送った window（24 kHz mono、tail silence を含む） |
| `output-timeline.wav` | 訳音声を `playStart` の位置に置き、隙間を無音で埋めた 24 kHz mono。**ファイル内時刻 = t** |
| `mixed.wav` | stereo 24 kHz。L = source（0.8 倍）、R = output-timeline。人が同時性を聴くため |
| `output-transcript.txt` | `t<TAB>text` の行。訳字幕 delta |
| `input-transcript.txt` | 同、原文字幕（取れたエンジンだけ） |

stdout には `summary.json` の内容だけを JSON で出す。本文・path・鍵を出さない。

## 4. エンジンとオプション（`--engine <id> --option k=v ...`）

| engineId | 経路 | options（既定値） |
|---|---|---|
| `openai-translate` | 現行製品経路。`packages/provider-openai` の `OpenAITranslationProvider` を relay-local と同じ Node `ws` transport で使う（出力の完全無音 200 ms 上限まで製品と同じ）。既定以外のオプションは provider と同じ event 処理・無音規則を持つ薄い client で送る | `noiseReduction=near_field|far_field|none`（near_field）、`inputTranscription=0|1`（0。1 で `audio.input.transcription.model=gpt-realtime-whisper` の原文字幕を取る） |
| `openai-live` | `wss://api.openai.com/v1/live/sessions`、`session.start` に `model: gpt-live-1`、`instructions`、`audio.format {audio/pcm, 24000}`。`session.input_audio.append` で送る。`session.output_audio.delta` / `session.output_transcript.delta` / `session.input_transcript.delta` を受ける。終端は `session.close`→`session.closed` | `preset=plain|domain|domain-glossary`（domain）、`voice`（marin） |
| `openai-realtime` | Realtime API `session.update {type: realtime}`、`output_modalities: ["audio"]`、`audio.input.turn_detection`、`instructions`。`response.output_audio.delta` / `response.output_audio_transcript.delta` を受ける | `model=gpt-realtime-2.1|gpt-realtime-2.1-mini`（2.1）、`vad=semantic:high|semantic:medium|semantic:low|server:<silence_ms>`（semantic:high）、`interrupt=0|1`（0）、`preset`（domain）、`inputTranscription=0|1`（0） |
| `cascade` | `gpt-live-transcribe`（streaming ASR）→ 日本語の節単位の区切り → LLM 訳（直前文脈つき）→ streaming TTS。agent B の設計書 `src/engines/cascade/README.md` を正とする | B が定義（`asrDelay`, `segmenter`, `llm`, `tts`, `context`, `glossary` など） |
| `gemini-live-translate` | Vertex AI の Live API `wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`（`global`）。`setup` に `model: projects/<project>/locations/global/publishers/google/models/gemini-3.5-live-translate-preview`、`generationConfig.translationConfig.targetLanguageCode`、`inputAudioTranscription` / `outputAudioTranscription`（setup 直下）。音声は 16 kHz に間引いて `realtimeInput.audio`、終端は `realtimeInput.audioStreamEnd`。`serverContent.modelTurn.parts[].inlineData`（24 kHz）と `outputTranscription` / `inputTranscription` を受ける。通訳専用モデルで instructions・voice は無い。認証は `GOOGLE_ACCESS_TOKEN`（`gcloud auth print-access-token`） | `project`（既定 `GOOGLE_CLOUD_PROJECT`）、`location`（global）、`echo=true|false`（false） |
| `qwen-live-translate` | Alibaba Cloud Model Studio の `qwen3.8-livetranslate-flash-realtime`。シンガポール/北京のworkspace別WebSocketへ16 kHz PCMを継続送信し、24 kHz PCM訳音声・原文/訳文deltaを受ける。終端は `session.finish`→`session.finished`。公式仕様のhotword辞書と話者検出/音声活動検出を比較できる。入力言語はモデルの自動判定。製品経路には未接続 | `region=singapore|beijing`（singapore）、`hotwords=off|env`（off）、`turnDetection=speaker|server-vad`（speaker）。`DASHSCOPE_API_KEY`、`QWEN_WORKSPACE_ID`を環境に設定。`hotwords=env`なら`QWEN_HOTWORDS_JSON`に `{ "鎌倉": "Kamakura" }` 形式を設定。用語本文・workspace IDはCLI引数やstdoutへ渡さない |

Qwenのモデル・イベント形式は[公式ガイド](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen3-5-livetranslate-flash-realtime)と[client event](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/live-translator-client-events)に合わせた。公開リポジトリには合成fixtureだけを置く。私有の会話音声をAlibabaへ送る承認は得ていないため、実行する場合もまず公開・合成音声に限定する。`QWEN_HOTWORDS_JSON`の値は記録しないが、件数はprivate eventsに記録する。原文の最終転記が途中deltaを修正した場合はprivate `events.jsonl`の`qwen.input_revision.text`へ記録する。Qwen入力の24→16 kHz変換にはframe間で状態を保持する7 kHz低域フィルタを使い、折り返しを抑える。既存Gemini比較の変換方式は測定値の再現性のため変更していない。

Qwenを再試験する場合: [公式無料枠ガイド](https://www.alibabacloud.com/help/en/model-studio/new-free-quota)に従いシンガポールの対象モデルの残枠と**Free Quota Only**を確認する。通常の従量課金用APIキー（Token/Coding Plan専用キーでは無料枠を使えない）と同地域のworkspace IDを、秘密を出さずに環境変数へ渡す。チャット・CLI引数・PRには載せない。公開/合成音声で短い接続試験を行った後、5分窓を反復する。2026-10-29の実サービス疎通・公開音声5分試験は[評価レポート](../../docs/public-audio-software-evaluation-2026-10-29.md)に記録した。日→英の品質優位は確認できず、製品経路への組み込みは保留する。

通訳指示は `src/prompts/interpreter.ts` の `buildInterpreterInstructions(preset, source, target)`。用語集は `src/prompts/glossary.ts`（合成・公開情報のみ）。cascade も同じ用語集を ASR keywords と LLM prompt に使う。

費用の目安（2026-10-28 公示）: translate $0.034/分、live $0.05/分、realtime は token 課金（audio in $32 / out $64 per 1M、text out $24/1M。mini は別単価）、gpt-live-transcribe $0.017/分、gpt-5.4-mini $0.75 / $4.50 per 1M（Fast mode は 2 倍）、gpt-4o-mini-tts $12/1M audio tokens（2027-01-06 停止予定。後継は `gpt-realtime-2.1-mini`）。`costUsd` は分かる範囲で推定、不明なら undefined。

## 5. 正解原稿（agent C、`EVAL_PRIVATE_DIR/reference/<sourceId>.json`）

`ReferenceDocument`。区間は **意味の確定する節または文**（目安 2〜12 秒）。長い文は述語（または接続助詞）で切る。「はい」「うん」だけの区間は `kind: backchannel`（遅延統計から除外）。質問は `question`。言い直し・断片は `fragment`。

- 時刻は whisper-1（`response_format=verbose_json`, `timestamp_granularities[]=word,segment`, `language=ja`）の単語時刻から。`gpt-4o-transcribe-diarize` の区間と話者ラベルで話者を補う。ローカル `whisper-cli`（large-v3-turbo）を第 3 の照合に使ってよい。
- 本文は ASR 出力を、録音に付属する既存の文字起こし（オーナー提供・人手未校正）と照合して直す。3 系統が食い違う箇所は `uncertain: true`。
- `facts` は数・期間・金額・時刻・否定・地名（`place`）・その他の固有名詞（`proper_noun`）・条件・主体・時制を、原文の表記で列挙する（判定器が各 fact の保存を採点する）。地名は人名・社名と分け、`place` にする。
- 原稿作成に LLM（既定 `anthropic:claude-opus-5-5`〔Anthropic API、`--reasoning` は effort に写す〕。`--llm gpt-5.4` で OpenAI）を使ってよいが、本文を公開物へ出さない。2026-10-28 までの原稿は gpt-5.4 で作ったもので、Claude は区間を細かく切るので同じ窓で混ぜない。
- 第 4 系統 D は `--turn-transcript <abs.md>`（`[hh:mm:ss] 話者N: 本文`、window の前後を含んでよい。本文一致で window 内を抜き出す）。既定は録音付属の人手未校正転記。`--transcript-kind gemini` を付けると Gemini（Vertex AI）の文字起こしとして扱い、A〜C の 2 系統以上が一致する場合を除き D の語を優先する（whisper 系の聞き違いを別系統で正すため）。

## 6. 判定（agent D、run ディレクトリ内に `output-words.json`, `judgement.json`, `report.md`）

1. `output-timeline.wav` を whisper-1（`language=en`, word timestamps）で文字起こしし、各英単語に **t（ms）** を付ける。ファイル内時刻 = t なので変換不要。`--asr-backend local` ではローカル `whisper-cli` と明示したモデルを使い、API 課金を避ける。ローカルの語は `output-words-local.json` に分けて保存し、既存の `output-words.json` を上書きしない。
2. LLM 判定器（既定は Claude `claude-opus-5-5`・effort `high`〔`--judge-backend anthropic`、Anthropic API〕。`--judge-backend openai` で gpt-5.4、`agy` で Antigravity CLI 経由の Claude、`codex` で ChatGPT ログイン済み Codex app-server のテキスト判定。`--model` で変更可）に、正解区間（id, startMs, endMs, text, facts）と英語の文（単語時刻付き）を渡し、区間ごとに `JudgedSegment` を返させる（JSON schema で強制）。1 回の呼び出しは 15 区間程度に分け、前後の区間を文脈として渡す。
3. 指標: `lStartMs = enStartMs − startMs`、`lEndMs = enStartMs − endMs`、`lTailMs = enEndMs − endMs`。`enStartMs` は **その区間の意味を担う最初の英単語**の時刻（導入の無関係語・前区間の残りは含めない）。`backchannel` は遅延統計から除外、`aligned=false`（訳が無い）は欠落として `meaning=0`、遅延は null にして件数を分母に残す。
4. `critical fact error` = type が `CRITICAL_FACT_TYPES`（number/time/amount/negation/place/subject/condition/tense）の fact で verdict `wrong`。将来予定を過去の実績に変える誤りも重大として数える。`omitted` は別に数え、型ごとの wrong 件数を `factErrorsByType` に残す。2026-10-30以前の集計とは定義が異なるため、比較時は保存済み判定から再集計する。
   - whisper-1 は長い無音で幻聴（"Thank you for watching." 等）を出すため、判定器は `output-timeline.wav` をエネルギーで有声区間に分けて区間ごとに文字起こしし、区間の開始を足して時刻を戻す（無音は送らない）。prompt にはエンジン字幕から抜いた数字・固有名詞などのキーワードだけを渡す（字幕の文を渡すと whisper がその内容を飛ばした）。
   - ASR 語とエンジン字幕の一致率（`asrAgreement`、全体と 1 分ごと）を記録し、60% 未満の分は gpt-4o-transcribe で再確認して report.md に「エンジンの音声が字幕と違う」か「判定不能」かを記す。一致率が低い分は、聞き手に字幕と違う英語が流れた候補として扱う。
   - `--effort`（判定モデルの推論の深さ）は `judge.effort` に記録する。
5. `aggregate` は `JudgeAggregate`。`within8s` は statement/question の分母に対する割合。`report.md` は private（本文を含む）、stdout は aggregate のみ。`report.md` の「1分ごとの意味と遅延」は原文区間の開始時刻で集計し、未対応を8秒以内率と意味平均の分母に残す。長い連続音声で遅延や欠落が後半へ偏るかを見るための診断であり、[IWSLT 2026のYAAL](https://aclanthology.org/2026.iwslt-1.3/)と同じ指標ではない。p50/p95は対応できた区間の語時刻のみで計算する。
6. `src/aggregate.ts --runs <runDir...>` は複数 run の `summary.json` と音声 ASR 由来の `judgement.json` から Markdown 表（数値のみ）を作る。`--word-source subtitle` の既定出力は `judgement-subtitle.json` とし、過去に `judgement.json` に保存された `judge.asr=engine-subtitle` も音声品質・遅延の集計対象から除く。

### 重要事実の音声遅延 `L_fact`

`src/fact-latency.ts` は、原文ASRの語時刻と訳**音声**ASRの語時刻に、確認した事実ごとの語indexを付けて計算する。`L_fact = 訳音声でその事実を話し始めた時刻 − 原音声でその事実を話し終えた時刻`。発話開始を基準にした `L_factOnset` も別に出す。`verdict=wrong/omitted/unclear` は速度の成功例から除外し、その件数を残す。`preSourceEnd` は原音声で事実が完成するより先に英語で発話した件数で、正しい文面でも推測の可能性がある。日本語の文末の否定など、意味を決める語が現れる前から遅延を測ってしまう問題を避けるためである。

annotation JSON は `sourceId` と `anchors` 配列を持つ。各要素に `segmentId`、`factIndex`、`sourceWordLo/Hi`、`targetWordLo/Hi`（省略なら両方 `null`）、`verdict`、`review`（`asr-reviewed` または `audio-reviewed`）を記す。語indexは各ASRの `words` 配列の0始まりで、数値を目視確認する。**否定は `can't` / `don't`、数量は `half` など、訳の事実が確定する最初の語を `targetWordLo` とする。**「I」や「we」など事実がまだ分からない前置き語を使うと早すぎる値になる。原文と訳文・index・結果はすべてprivateに保管し、公開PRには集計だけを書ける。`asr-reviewed` は実音声を人が聴いていないので、正解時刻とみなさない。

```sh
EVAL_PRIVATE_DIR=/path/to/private/eval node --experimental-transform-types research/eval/src/fact-latency.ts \
  --reference /path/to/private/eval/reference/source.json \
  --source-asr /path/to/private/eval/work/source-whisper1.json \
  --target-asr /path/to/private/eval/runs/run-id/output-words-local.json \
  --anchors /path/to/private/eval/work/fact-anchors.json \
  --out /path/to/private/eval/runs/run-id/fact-latency.json
```

この計測は選択した事実の診断であり、全発話の品質やイヤフォン到達時刻を代表しない。欠落・誤訳を含めた全区間評価は上記の判定器と併用する。

## 7. 実行

```sh
export EVAL_PRIVATE_DIR=/path/to/private/eval
export OPENAI_API_KEY="$(gcloud secrets versions access latest --secret=AI_OPERATIONS_OPENAI_API_KEY --project=niho-app-stg --account=takahama.t@niho.life --quiet)"
export ANTHROPIC_API_KEY="$(gcloud secrets versions access latest --secret=NIHO_TRANSLATE_ANTHROPIC_API_KEY --project=niho-app-stg --account=takahama.t@niho.life --quiet)"
# gemini-live-translate だけ（Vertex AI。トークンは 1 時間で切れる）
export GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token --account=takahama.t@niho.life)"
export GOOGLE_CLOUD_PROJECT=niho-app-stg
npm --silent run eval:run -- --wav /abs/path.wav --window 150:450 --source-id src1-w1 --engine openai-translate --frame-ms 200
# GPT-Live の背景注入 A/B。背景本文は private に保管し、CLI 引数や公開リポへ書かない
npm --silent run eval:run -- --wav /abs/path.wav --window 150:450 --source-id src1-w1 --engine openai-live --frame-ms 200 --option preset=plain-q --option contextFile="$EVAL_PRIVATE_DIR/work/topic-context.txt"
npm --silent run eval:judge -- --run "$EVAL_PRIVATE_DIR/runs/<runId>" --reference "$EVAL_PRIVATE_DIR/reference/src1-w1.json"
# 既定の判定器は Claude（ANTHROPIC_API_KEY）。gpt-5.4 で判定するなら --judge-backend openai。--skip-asr で既存の output-words.json を再利用する
npm --silent run eval:judge -- --run "$EVAL_PRIVATE_DIR/runs/<runId>" --reference "$EVAL_PRIVATE_DIR/reference/src1-w1.json" --judge-backend openai --skip-asr --out-name judgement-gpt54.json
# 既存の output-words.json を再利用し、LLM 判定だけ ChatGPT 契約枠で実行する
npm --silent run eval:judge -- --run "$EVAL_PRIVATE_DIR/runs/<runId>" --reference "$EVAL_PRIVATE_DIR/reference/src1-w1.json" --judge-backend codex --skip-asr --out-name judgement-codex.json
# ASR を呼ばず、字幕到着時刻で意味だけを安価に下見する。音声の遅延値には使わない
npm --silent run eval:judge -- --run "$EVAL_PRIVATE_DIR/runs/<runId>" --reference "$EVAL_PRIVATE_DIR/reference/src1-w1.json" --judge-backend codex --word-source subtitle --out-name judgement-codex-subtitle.json
# ローカル whisper.cpp で実際の英語発話の単語時刻を測る。ffmpeg と whisper-cli が必要。モデルは private に置く
npm --silent run eval:judge -- --run "$EVAL_PRIVATE_DIR/runs/<runId>" --reference "$EVAL_PRIVATE_DIR/reference/src1-w1.json" --judge-backend codex --asr-backend local --whisper-model "$EVAL_PRIVATE_DIR/../models/ggml-small.en.bin" --out-name judgement-codex-local.json
# 先に ASR だけ実行する場合。後で --skip-asr --asr-backend local を付ければ同じ単語時刻を再利用できる
npm --silent run eval:judge -- --run "$EVAL_PRIVATE_DIR/runs/<runId>" --reference "$EVAL_PRIVATE_DIR/reference/src1-w1.json" --judge-backend codex --asr-backend local --whisper-model "$EVAL_PRIVATE_DIR/../models/ggml-small.en.bin" --asr-only
npm --silent run eval:aggregate -- --runs "$EVAL_PRIVATE_DIR"/runs/*
```

`codex` はローカル CLI の ChatGPT ログインを使う。子プロセスには API key を渡さない。音声の入力・文字起こし・Realtime 音声出力は Codex app-server の対象外なので、通訳エンジンの5分間リプレイそのものは代替できない。`--skip-asr` は **選択した ASR の既存の v2 単語ファイルが無ければ失敗し、ASR を呼ばない**。字幕だけの `--word-source subtitle` の `lStart` は英語発話開始の実測値ではない。`--asr-backend local` は実際の出力音声に基づくが、小型モデルの単語時刻に誤差があり、字幕との一致率が低い部分は人手で音声を確認する。Codex 判定は OpenAI 系統の自己評価バイアスがあるため、採用判断は別系統の判定または人手確認と合わせる。

`openai-live` の `contextFile` は研究専用のオプション。20〜800文字の1行テキストを読み、背景は用語の曖昧さを減らす目的に限定し、音声で発話されていない事実を加えない指示とともに渡す。本文は run の config やログには保存せず、指定ファイルだけを private に置く。製品の既定指示は変更しない。

`npm run typecheck` と `npm test`（vitest、純関数のみ。外部 API・実音声を使わない）を通す。実 API を使う検証は `EVAL_PRIVATE_DIR` 配下だけに書き、結果の数値だけを報告する。

## 8. 共通の禁止事項

- 鍵を引数・ファイル・ログ・エラーメッセージに出さない。`OPENAI_API_KEY`・`ANTHROPIC_API_KEY`・`GOOGLE_ACCESS_TOKEN` は環境変数からだけ読む。
- 原文・訳文・音声・実データの path を `research/**`、tests、CI、stdout に出さない（stdout は集計 JSON のみ）。
- `packages/**`、`ios/**`、`examples/**`、`scripts/**` を変更しない（製品経路の比較対象を固定するため）。
- 他担当の path を編集しない。`engine.ts`・`prompts/**`・本 README の変更が必要なら、変更内容をメイン担当へ報告して止まる。
- commit・push・PR・Issue 操作をしない。git stash を使わない。他 CLI / 他 agent への再委任をしない。
