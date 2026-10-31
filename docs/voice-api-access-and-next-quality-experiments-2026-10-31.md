# 日英音声通訳APIの比較条件と次の品質実験（2026-10-31）

## 目的

[話者別5分評価](pc-speaker-separated-translation-evaluation-2026-10-31.md)では、GPT-Liveの短い用語指定で意味平均が改善した一方、時制の誤りが残った。既定のGPT-Liveにも重大な誤訳がある。品質を最優先に、現時点で利用できる別エンジンと用語制御を同じ公開日本語音声で比較する。単一runの平均点だけで製品の既定を切り替えず、原文・訳字幕・実際の訳音声ASRで事実を確認する。

## 外部サービスの契約条件

| 候補 | 日英の訳音声 | 用語・背景の制御 | 今すぐ5分比較できるか | 次の手順 |
|---|---|---|---|---|
| Qwen3.8 LiveTranslate | 既存の研究アダプターで実測済み | `translation.corpus.phrases`のhotwords | 研究用キーあり | 同じ話者別5分音声で無指定と用語指定を比較 |
| Kotoba STS | 既存の研究アダプターで実測済み | 公開Realtime仕様には任意の背景プロンプトなし | 研究用キーあり | Qwen/GPT-Liveの結果との事実別比較に使う |
| DeepL Voice API | [session仕様](https://developers.deepl.com/api-reference/voice/request-session)は`target_media_languages`で英語音声を指定できる | 原文認識の`spoken_terms_id`と訳文の`glossary_ids`を別々に指定できる | 対応するAPI契約・鍵なし | 音声出力を含む試用枠、単価、最小契約、用語制御、データ取扱いを営業に確認 |
| ElevenLabs Realtime Translation | [WebSocket仕様](https://elevenlabs.io/docs/api-reference/realtime-translation/v-1-translation-realtime)に訳音声と原文・訳文テキスト、品質寄りの`eagerness=low`がある | 公開session仕様で一般的な自由背景指定は確認できない | Enterprise workspace限定 | 評価用アクセスが得られるときだけ追加比較 |

[DeepLのプラン説明](https://support.deepl.com/hc/en-us/articles/360019924499-About-DeepL-plans)では一般向けVoice契約にVoice APIは含まれない。[APIプラン説明](https://support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-plans)ではDeveloperに音声翻訳は含まれず、Growthの説明はspeech-to-text中心である。一方、[Voice API概要](https://developers.deepl.com/docs/voice/overview)は有料API契約者にspeech-to-speechを提供すると書き、DeepLが販売者の[AWS Marketplace掲載](https://aws.amazon.com/marketplace/pp/prodview-2fii5e2hmuneo)にはGrowthの年間60時間のspeech-to-speech枠と年間312ドルが明記されている。通常のDeepL直販Growthで同条件か、月額契約が可能かはこの資料だけでは確定できない。12か月契約を先に購入せず、契約経路別の適格性と試用条件を確認する。

DeepLのsession設定では、`source_language=ja`、`source_language_mode=fixed`、`target_media_languages=["en"]`、`target_media_content_type=audio/pcm;encoding=s16le;rate=24000`が比較用の候補。入力PCMは24 kHzを受けず、16 kHzまたはOpus等への変換が必要。用語を比較する場合、`spoken_terms_id`のみ、`glossary_ids`のみ、両方の4条件を分ける。公式仕様上、前者は原文認識、後者は訳文の語の適用を制御するためである。原文にない事実を加えないこと、質問・否定・数字・人物の帰属を保つことを採用基準とする。

[対応言語表](https://developers.deepl.com/docs/voice/supported-voice-languages)では日本語の文字起こし、英語の翻訳・音声出力がいずれもDeepL提供とされる。日英が使えることは仕様で確認できるが、既存候補より品質・速度が良いという実測結果ではない。

[DeepLのWebSocket仕様](https://developers.deepl.com/api-reference/voice/websocket-streaming)は50〜250msの入力チャンクを推奨し、1チャンク100KBまたは1秒以下、前チャンク長の半分未満の間隔を禁止する。終了時は`end_of_source_media`の後に`end_of_stream`を待つ。原文・訳文の`tentative`は更新されるため、確定訳文との重複連結を避ける。訳音声PCMは到着順に再生キューへ入れ、`target_media_chunk`の到着時刻と再生開始時刻を別々に記録する。[Voice API概要](https://developers.deepl.com/docs/voice/overview)は、日本語の用語集では文字列境界が認識結果に依存し、長い語が区間をまたぐと用語指定を逃す可能性も説明する。

## 同条件比較

- 入力: 既存評価で使用した公開対談の5分を話者別トラックで実時間送信する。無音も含め、同一の原音・参照原稿・採点指示版を使う。
- 条件: Qwen既定、Qwen hotwords（地名・行政語のみ）、Qwen `server_vad`（用語指定なし）。用語と区切り方を同時に変えず、それぞれの効果を見る。将来のDeepL試験でも同じトラックを使い、モデルや音声出力形式以外の条件を揃える。
- 品質: 正解日本語と訳**音声**ASR・モデル字幕を並べ、質問の断定化、否定・時制・数字・固有名詞・人物帰属・抜けを個別に監査する。ASRだけの不一致は確定誤訳と数えない。
- 速度: 原語の区間開始から意味対応する英語**音声**の最初の語までの`L_start`をp50/p95/8秒以内率で示す。重要事実は原語で事実が確定した時点から対応英語音声までの`L_fact`も別に見る。
- 再現性: 5分1回の優劣は暫定。改善候補は別録音・別話者・再試行で確認する。速度のために重大な誤訳を増やした条件は採用しない。

### Qwen 5分実時間リプレイの再生待ち

公開対談の市長トラックを話者別に300秒送信し、末尾へ20秒の無音を付けた。3条件ともAPIの致命エラーはなく、終了時の音声排出は完了した。受信した24kHz PCMを到着順に等速再生するモデルでは次の通り。

| 条件 | 訳音声の合計長 | 再生待ち最大 / P95 | 終了時排出 |
|---|---:|---:|---|
| 既定の`speaker_detection` | 292.08秒 | 16.76 / 14.86秒 | 完了 |
| 5語のhotwords、同じ区切り | 290.56秒 | 20.31 / 17.57秒 | 完了 |
| hotwordsなし、`server_vad` | 297.04秒 | 16.07 / 12.90秒 | 完了 |

再生待ちは発話開始から訳音声開始までの`L_start`とは別の指標。字幕の早さだけでは聞き手が受け取る時刻は分からない。単一runの差を用語指定や区切り方式の因果効果とは断定しない。既定runの到着時刻とチャンク長から再生だけを仮に一律1.2倍にすると、待ち行列最大は約7.60秒になるが、翻訳確定前の時間を含まない。加速再生の聞き取りやすさも未確認なので、品質改善の証拠として扱わない。

### 訳音声の意味と対応遅延

下表は同じ20区間、同じCodex判定指示v3、同じローカル英語ASRモデルの評価。`L_start`は原文の区間開始から対応する**英語音声の語**までで、字幕到着時刻ではない。英語音声の時刻はAPIチャンクの到着順に24kHz PCMを等速再生するモデルで、今回のQwen runをPCスピーカーへ実際に出した時刻ではない。原文とモデル字幕・訳音声ASRを別に突き合わせた誤りは表の自動重大件数に含まれない場合がある。

| 条件 | 意味平均 / 3 | `L_start` 中央 / P95 | 8秒以内 | 自動重大誤り |
|---|---:|---:|---:|---:|
| Qwen既定 | 2.40 | 11.44 / 18.84秒 | 35% | 2 |
| 5語hotwords | 2.55 | 9.15 / 20.18秒 | 35% | 1 |
| `server_vad`、用語なし | 2.55 | 9.28 / 14.69秒 | 40% | 4 |

3条件とも、原文の「5月に第1回目の集会を**開催いたします**」を英語で過去の開催として話し始めた。モデル英文字幕と訳音声ASRの両方に過去形があり、ローカルASRだけの誤りではない。さらに未発話の「市民に命名への参加を募った」を加えた。既定runでは避難所支援の職員派遣主体と帰還職員の感想の帰属を取り違えた。用語指定runでは原文の尼崎市をAmagasaki Cityと伝えたが、`server_vad`runはNagasaki Cityへ置換した。用語指定でも「今後、協力を呼びかけるかもしれない」を「呼びかけたい」へ変え、可能性の度合いを落とした。単語辞書は固有名詞の改善候補だが、時制・条件・主体帰属の安全策にはならない。

訳音声ASRとモデル英文字幕の単語一致率は既定98.0%、hotwords98.2%、`server_vad`98.4%。この指標は音声ASRの大まかな整合性であり、個々の単語や発音を人が聞いて確認したことにはならない。

少なくとも今回の3runは、品質優先でも速度の8秒目標でも製品既定の採用条件を満たさない。別録音と人手の音声確認なしに、日英通訳全体の順位を決める資料ではない。

[前回の同じ話者トラック評価](pc-speaker-separated-translation-evaluation-2026-10-31.md)ではGPT-Live `plain-q`が意味1.95/3、`L_start` P95 10.24秒、短い用語指定が意味2.35/3、P95 9.99秒だった。Qwenはこの1録音の機械判定平均では高いが、P95は14.69〜20.18秒で、過去と未来の逆転が3条件で残る。各候補の既定採用は引き続き保留する。意味平均だけで音声の品質を順位付けしない。

## 次に実行する検証

1. GPT-Liveの短い背景情報と用語指定を分離し、同じ話者別音声を各条件で再試験する。既存の1回の改善は再現性の確認が必要。質問・否定・時制・主体・地名の個別誤りを、意味平均より優先する。OpenAI APIの音声runにはChatGPTのCodex判定枠とは別のAPI利用枠が必要。
2. DeepL Voice APIの音声出力付き試用または短期契約が取れたら、最初に公開音声5分の無指定条件を測る。次に`spoken_terms_id`と`glossary_ids`を別々に比較する。研究アダプターは、仕様上のHTTPS session発行→WebSocket→原文・訳文の確定/暫定更新→24kHz PCM出力→終了確認を既存ハーネスへ接続する。適格なAPIキー取得前に品質を推測して製品実装を進めない。
3. ElevenLabsはEnterprise評価枠が提示された場合にだけ追加する。公開仕様の`eagerness=low`と既定の差を、同じ5分音声・同じ事実基準で比較する。

製品切替の最低条件は、複数の自然会話5分で確認済み重大事実誤りをなくし、音声基準の`L_start` P95を8秒以内へ近づけ、8秒以内率を上げ、長い連続発話でも再生待ちが増え続けないこと。現時点ではどの候補もオーナーの最大8秒・高精度の受入基準を満たしていない。これを満たすまで研究候補を製品既定へ接続しない。

## オーナーがDeepLへ確認する際の文面

[DeepLの営業窓口](https://www.deepl.com/en/contact-us)では「DeepL API」を対象製品に選べる。以下を問い合わせ欄に貼り付ける。

> 日本語話者1人の音声を英語の訳音声へリアルタイム変換するアプリを評価しています。Voice APIの`POST /v3/voice/realtime`で`target_media_languages=["en"]`を使える契約の名称、評価用アクセスの有無、最小契約期間・金額、音声入力1分当たりの料金、同時接続上限、5分の公開音声による試験可否を教えてください。API Growthの直販契約でも音声出力を利用できるか、AWS Marketplaceの年間契約以外に月額や短期試用があるかも確認したいです。`spoken_terms_id`と`glossary_ids`を同時に利用できるか、日本語入力と英語音声出力の処理・保存場所と保持期間も教えてください。

この問い合わせは契約・支払いではない。返答後に試験予算を決める。ElevenLabsもEnterprise見積もりと評価用アクセスが提示されるまで支払い対象にしない。
