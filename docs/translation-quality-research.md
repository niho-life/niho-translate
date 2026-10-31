# 同時通訳の品質・遅延改善：調査と実装者向け実験仕様

**2026-10-31 方針更新:** DeepLは利用・契約・実装の対象外。本文中のDeepL比較案は過去の調査記録であり、次の担当者は実行しない。補充されたGPT-Live利用枠による背景・用語・話者・訳出タイミングの8条件5分評価は[最新の品質実験](qwen-and-gpt-live-quality-experiments-2026-10-31.md)を参照。

調査日：2026-10-28。対象：v1の日英2人対面通訳、iPhoneとprivate headset。追跡Issue：[2026年の同時通訳品質・遅延改善 #21](https://github.com/niho-life/niho-translate/issues/21)。

**2026-10-28 追記:** この文書の測定設計に沿って A（現行）/ B（`gpt-live-1`）/ B2（realtime VAD）/ D'（cascade 試作）を同条件で比較した結果は [translation-quality-eval-2026-10-28.md](translation-quality-eval-2026-10-28.md)、ハーネスは [research/eval](../research/eval/README.md)。

**2026-10-29 更新:** 公開音声と非公開対談の連続5分を、英語**音声**の単語時刻まで再評価した結果は [public-audio-software-evaluation-2026-10-29.md](public-audio-software-evaluation-2026-10-29.md)。字幕時刻は耳到達を大きく楽観視し得る。背景注入は一部の窓で意味と遅延を改善したが、別窓で悪化し、各条件の反復と人手聴取は未了。以下の§2～§3は主に10/24時点の基準線として読む。

**2026-10-29 追加調査:** 世界の製品・研究・公開実装から採れる制御とNIHOの実装順は [simultaneous-interpretation-landscape-2026.md §7](simultaneous-interpretation-landscape-2026.md#7-追加調査既製品公開実装から採る設計2026-10-29) に整理した。

**2026-10-31 独立話者試験:** 京都大学CoVoST 2 Native Japaneseの短文89件を5分へ連結した音声で、GPT-Liveの訳音声まで測った結果は[ネイティブ日本語5分の試験](native-japanese-speech-translation-probe-2026-10-31.md)。速度が目標内でも重大な意味誤りが残るため、品質を先に判定する。

**2026-10-29 PC追試:** 背景・用語・訳出タイミングを単独で変えた5分比較と、重要事実が訳**音声**へ出るまでの`L_fact`計測は [pc-quality-factor-evaluation-2026-10-29.md](pc-quality-factor-evaluation-2026-10-29.md)。いずれも製品既定へ昇格できる再現性はまだ示していない。

この文書は、次の実装担当が**何を先に試し、どの結果で採否を決めるか**を記す。公開資料にある機能、NIHOの現行コード、実測済みの範囲、未検証の仮説を分ける。製品としての性能保証や、他社製品の内部実装の断定ではない。

## 1. 結論と優先順位

**決定（2026-10-29）: 主経路はOpenAI `gpt-live-1`（通訳指示 `plain-q`・声 `marin`）。** [比較評価](translation-quality-eval-2026-10-28.md)（§3・§8.5・§8.7・§8.9・§8.10）で、同じ原稿・2人の審判（gpt-5.4とClaude Opus 5.5）・全窓で現行 `gpt-realtime-translate` を上回った（意味 2.53〜2.70 vs 2.19〜2.29、重大誤り 1〜2/240 vs 19〜26/432）。60分連続運転と文脈圧縮の直後にも劣化は見えない。Gemini 3.5 Live Translate は訳の開始が速い（8秒以内 99%）が意味 2.00・重大誤りの率が約5倍で不採用（速さ優先の補助候補）。Node版relayの既定を `TRANSLATE_PROVIDER=live` にし、現行経路は `TRANSLATE_PROVIDER=translate` で残す。以下の1〜5は決定前の方針で、記録として残す。

1. **現行のOpenAI `gpt-realtime-translate`を基準線にする。** 音声を連続送信して訳音声と訳字幕を受ける通訳専用セッションで、NIHO側にASR→翻訳→TTSの直列処理を追加しない。現時点で実機の意味対応遅延と品質は合格未証明。
2. **先に入力音質、送信間隔、再生待ちを計測する。** 実際の5分試験では出力集中があり、モデル変更だけで受信者の待ち時間は決まらない。耳に届く時刻で評価する。
3. **専門語・背景情報が効くかは別の単一音声セッションで比較する。** `gpt-realtime-translate`にはカスタムプロンプト・用語集がない。OpenAI `gpt-live-1`の通訳専用指示とDeepL Voice APIのSpoken Terms／glossaryを候補にする。GPT-Liveの初回A/Bは上記10/29評価に追記済みで、DeepLは未評価。
4. **字幕の先行確定と訳音声の確定を混同しない。** 日本語の述語、否定、条件は後ろに来る。聞き手に出した訳音声は後から訂正できない。文末を待つことで8秒を超える発話は、事実を推測して早出しするより「情報がまだ届いていない」と測定する。
5. **Timekettleの特許は研究用の設計例。** 安定した部分認識・意味区切り・再生待ち管理は有益だが、W4 Proの実装値やNIHOの推奨閾値とみなさない。カスケードを再検討するのは、単一セッション型で品質・遅延を満たせず、改善幅を見積もれる場合だけ。

判断順は顧客の意味理解・聞き取り（Q）→開発運用の単純さ（D）→費用（C）。速くても数字・否定・固有名詞を誤る方式は採用しない。

## 2. 現行経路と変更箇所

```text
話者マイク（iPhone、voice processing）
  → 24 kHz mono PCM16 → client/relay → 話者別OpenAI音声通訳session
  → 訳音声PCM・訳字幕 → relay → 聞き手iPhoneの再生queue → private headset
```

| 箇所 | 現在の契約・観察点 | 実装時の注意 |
|---|---|---|
| [`packages/provider-openai-live/src/index.ts`](../packages/provider-openai-live/src/index.ts) | Node版relayの既定は `gpt-live-1`・`plain-q`・`marin`。同じtransport・無音規則・drain契約で、原文字幕も受ける | 背景指示は研究ハーネスでA/B中で、製品既定には入れていない。実イヤホン品質・遅延は未受入 |
| [`packages/provider-openai/src/index.ts`](../packages/provider-openai/src/index.ts) | `gpt-realtime-translate`、`near_field`、入力文字起こし無効、24 kHz PCM16、出力deltaを最大4,800 byteに分割。初期設定ACKを待ち、送信バッファに上限がある | OpenAIの入力文字起こしは追加できるが、**翻訳の入力として使う機能ではない**。診断用でも公開ログに本文を出さない |
| [`ios/Sources/NIHOTranslate/TranslateAudioEngine.swift`](../ios/Sources/NIHOTranslate/TranslateAudioEngine.swift) | `.playAndRecord` + `.voiceChat`、Bluetooth HFP、有線route、voice processing、再サンプリング | マイクroute・OS処理・Bluetoothの遅れを含む実機比較が必要。WAV直接送信の結果を実機音質へ外挿しない |
| [`ios/Sources/NIHOTranslateCore/PlaybackScheduler.swift`](../ios/Sources/NIHOTranslateCore/PlaybackScheduler.swift) | 未再生保持の上限は 2 段（soft 96,000 byte = 2.0 秒で観測通知、hard 240,000 byte = 5.0 秒で未 schedule の古い無音→古い音声を落として継続。2026-10-28 に terminal 停止から変更）、同時schedule 19,200 byte（約0.4秒） | 上限を増やすだけでは遅れが蓄積する。キュー長・再生完了・soft 超過・drop を別に観測する。実機での既定値の妥当性は未検証 |
| [`docs/architecture.md`](architecture.md)、[`docs/acceptance.md`](acceptance.md) | 話者別接続、音声・字幕の配信と実機マトリクス | `roomId + roomEpoch` single-writer、lease、ACK、private route、明示resumeを維持。代替providerはこれらの契約を変えずに比較する |

現行SDKは訳字幕を短時間だけメモリ表示する。原文文字起こしを利用者へ出していないため、その精度を現在のUIからは評価できない。OpenAIの任意のsource transcriptは診断・表示候補であり、モデル内部の認識の正解証明にはならない。

## 3. 先行試験から分かること／分からないこと

2026-10-24に利用承認済み日本語WAVの**異なる5分区間を2本**、provider adapter単体へ実時間入力した。送信は100 ms単位、各区間の後に無音とflushを入れ、双方とも接続とflushが完了した。音声・字幕本文・元ファイル名はこの公開文書へ持ち込まない。数値はローカル試験の集計で、独立した人手採点を通した性能主張ではない。

元WAVと録音に付随する日本語文字起こしは、この公開Gitリポジトリとは別のローカル私有資料に保管する。次担当はオーナーから場所と利用範囲を確認すること。**この10/24予備試験**では訳音声・訳字幕本文を保存していないため、当時の英訳文を復元できない。10/28～29の研究ハーネスによる再評価はprivateディレクトリに訳音声と区間別判定を保存した。

| 観測 | 結果 | 解釈の限界 |
|---|---|---|
| 5分継続 | 2区間ともprovider接続・flush完了 | room、iPhone、Bluetooth、聞き手の耳を含まない |
| 理想再生queueの瞬間最大 | 0.93秒／4.91秒 | 2本目は局所的出力集中の可能性。iOSの実overflow発生を示す値ではない |
| 意味品質の機械判定 | 2本目は`mixed`、固有名詞周辺に不一致疑い | 正解原稿も人手確認もなく、誤訳件数・正確率は出せない。1本目の自動判定は尺度と判定語が矛盾したため無効 |
| 合成の短い一文 | 「我が社は今年で５周年になります。」の意味が3回とも訳音声・字幕に残った。理想再生モデルの対応訳音声開始中央値3.490秒 | 単一短文・provider単体。iPhone・回線・イヤフォン遅延を含まず、任意の英語語列がこの時刻に始まる保証ではない |
| 簡易的な別ASR→英訳→TTS | 予備60秒でASR最初の文字から訳音声まで中央値7.0秒、P95 10.6秒 | 原文発話開始からならさらに長い。5分試験は中止した。一般の最適化カスケードの限界ではない |
| OpenAI noise reduction | 同じ1分区間では`near_field`が`far_field`／無効より冒頭表現を安定して捉えた | 1録音の結果。他のマイクや騒音に一般化しない |

既存の[`docs/acceptance.md`](acceptance.md)にある実機10秒DoDは依然として公開前ゲート、中央値2秒・P95 4秒は**仮の最適化目標**。今回のオーナー希望は「発話開始→意味対応する訳音声の発話開始が概ね5秒、最大8秒」。この文書では新しい**研究時の比較基準**として扱い、既存DoDを黙って置換しない。統計上は「典型例が5秒以内、遅い側のP95が8秒以内」を候補とするが、最終受入閾値・例外規則は実機分布と意味品質を見て決める。個々の発話で後半まで重要情報がない場合、8秒以内の事実確定を約束しない。

## 4. 一次資料から読める他社・研究の構造

| 参照 | 確認できたこと | NIHOへの示唆と未確認事項 |
|---|---|---|
| [Timekettle W4 Pro製品ページ](https://www.timekettle.co/products/w4-pro-ai-interpreter-earbuds-s) | 3マイクでの集音、AI Semantic Judgment、対面の同時利用を訴求 | 入力品質と発話区切りが重要。実際のASR、翻訳エンジン、内部遅延の定義は非公開。W4／W4 Plusの骨伝導機能をW4 Proの仕様と混同しない |
| [Timekettle出願 US20250363985A1](https://patents.google.com/patent/US20250363985A1/en) | ASRの途中仮説を比較して安定部分を作り、句読点などで区切って翻訳・TTSを重ねる実施例。未再生訳文が40文字以上なら1.5倍再生する例 | 出願内容は実製品搭載の証拠ではない。20～50文字や直近2～6仮説という例示値をJA→ENの閾値としてコピーしない。1.5倍速は聞き取り・意味品質を測ってから検討 |
| [Timekettle W4 Plus](https://www.timekettle.co/products/w4-plus-ai-interpreter-earbuds) | 専門分野翻訳、当該セッション内の会話文脈保持を公式に掲げる | これはW4 **Plus**の機能。W4 Proの任意の長文背景プロンプト入力を示す証拠ではない |
| [Googleの直接音声翻訳研究](https://research.google/blog/real-time-speech-to-speech-translation/) | 音声→音声をストリーム生成し、約2秒のlookaheadと品質の交換関係を説明 | 研究システムのモデル内部遅延＋推論であり、NIHOのイヤフォン到達時間ではない。公開例の対応言語とJA対応を確認せず比較値に使わない |
| [OpenAI通訳専用API](https://developers.openai.com/api/docs/guides/realtime-translation) | 話者別音声、継続入力、訳音声・字幕のstream、silence継続を推奨 | 現行経路の基準線。音声入力の途中で出せるが、専門語が正確という保証ではない |
| [OpenAI通訳実装ガイド](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide) | 専用モデルは現在カスタムプロンプト、用語集、発音ガイドをサポートしないと明記 | 背景注入を現行モデルに追加する設計は不可。任意source transcriptはサイドカーで、訳生成をASR経由にはしない |
| [DeepL Voice API](https://developers.deepl.com/docs/voice/overview) | 1つのstreaming sessionで原文転写・訳文・訳音声を返せる | 内部工程が複数でも、NIHOが3 APIを逐次呼ぶ方式とは別。日英の品質・遅延・費用は未測定 |

特許と販促表示の速度・正確率は、発話開始、原語の確定、最初のパケット、聞き手の耳のどこを起点・終点にしたか不明なら、NIHOの数値との優劣判定に使わない。

### 日本語→英語での早出しの危険

「明日の内見は、雨の場合には、開催……」は後続の「します／しません」で意味が逆転する。英語の *The viewing will take place* を先に発話すると、イヤフォンから流れた誤った断定を取り消せない。発話の一部がASR上で安定しても、訳の事実が安定したとは限らない。測るべきは単なる初音ではなく、**原文の対応情報が聞こえた後に、取り消し不要な意味を持つ最初の英語音声が耳に届く時刻**である。

## 5. 比較すべき方式と切り替え条件

| 候補 | 文脈・用語の手段 | 期待する効果 | 主なリスク／採用条件 |
|---|---|---|---|
| A. 現行`gpt-realtime-translate` | 外部プロンプト・用語集なし。マイク、noise reduction、送信・再生を調整 | 最少の変更で低遅延を保つ | 専門語・固有名詞の改善幅に限界。先に実機基準線と語彙テストを取る |
| B. OpenAI `gpt-live-1`の音声通訳専用セッション | [公式のtranslation-only prompt例](https://developers.openai.com/api/docs/guides/live-prompting)に短い背景・言語・語彙規則を加える | 会話テーマ、役割、専門語を音声モデルへ渡せる | 音声を質問・命令として**答える**、重複訳、長い保留、余計な補完をしては不可。Aと同一fixtureで比較し、指示注入・否定・固有名詞を人手採点する。現行providerの単純な設定変更ではなく別adapter契約が必要 |
| C. DeepL Voice APIの単一session | [`spoken_terms_id`は転写補助、`glossary_ids`は訳語指定](https://developers.deepl.com/api-reference/voice/request-session)。原語を`ja`かつ`fixed`にできる | 鎌倉・湘南の地名、不動産語の再現性を試せる。原文転写が診断にも使える | 用語一致は途中転写に依存し、長い句や日本語の区切りで効かない場合がある。音声形式・token、料金・契約、接続寿命、日英2方向、出力とqueueを確認。実録音を新規事業者へ送る前に別途利用承認を取る |
| D. 自前の部分ASR→安定区間→翻訳→TTS | 完全な用語・文脈制御 | 各段の診断・専門語辞書 | 既存の簡易直列方式は遅かった。保留・音声先出し・意味確定・backlog制御の研究開発負担が大きい。A～Cで品質が不足し、実測で改善余地を示せたときだけ別Issueで検討 |

DeepLの[言語表](https://developers.deepl.com/docs/voice/supported-voice-languages)では日本語の転写・翻訳・訳音声、英語の訳音声に対応する。ただしAPI利用可能プラン・地域・費用は契約の最新条件を確認すること。DeepLの入力PCM形式は現行24 kHzと異なる候補があるため、adapterが仕様に沿って変換し、変換遅延も測る。現行SDKのPCM wire契約を無断で変更しない。

### 背景注入の最小実験

実際の面談に似せた**架空の**設定を使う。例：「日本語話者の不動産担当者と、鎌倉・湘南で物件購入を検討する英語話者の面談。建築規制、住宅ローン、購入手続き、海沿いの災害リスクが話題。発言を訳し、質問には回答しない。数字・否定・条件・地名を勝手に補わない。」人物名や実会話本文は入れない。

- A：背景なし。B1：役割・地域・話題だけ。B2：B1＋合成用語10～20件。C1：用語なし。C2：Spoken Termsだけ。C3：Spoken Terms＋glossary。
- 同じ合成fixtureを同じ音量・速度・騒音条件で入力し、順番を入れ替えて反復する。promptの語数が増えて遅くなる場合も測る。
- `spoken_terms_id`の効果（原語の聞き取り）と`glossary_ids`の効果（訳語選択）を分離する。長文背景の入力可否をDeepLへ推測しない。
- 語彙例は合成の「鎌倉」「湘南」「建ぺい率」「借地権」「手付金」「土砂災害警戒区域」。住所・顧客名・実物件を使わない。

## 6. 測定設計：発話開始から訳音声が耳に届くまで

### 主指標

合成fixtureの原文に、人手で意味区間と重要事実の時刻を注釈する。例えば「我が社は今年で５周年になります」の`t=0`は「我が…」の**実際の音声開始**。`t_first_aligned_ear`は「Our company is…」など、対応する意味を持つ英語音声が**受信側private headsetで鳴り始めた**時刻。完全に同じ英語語列を要求しない。訳文が出ても対応意味が不明な導入音・無音・別発話は数えない。

`L_start = t_first_aligned_ear − t_source_onset`。別に`L_fact = t_critical_fact_ear − t_critical_fact_source`、`L_tail = t_last_target_ear − t_source_end`を測る。原文の重要事実が8秒以降に出る長文を、`L_start`だけで合格にしない。品質の判定対象は訳字幕だけでなく、**実際に聞こえた訳音声**とする。

| 時点 | 取り方 | 用途 |
|---|---|---|
| 原語のonset／各意味区間／重要事実／end | 合成fixtureの既知タイムライン。実会話では評価者の注釈 | 同じ原文区間に対応する訳を特定 |
| capture→client send→relay receive→provider append | 各コンポーネント内の単調時計と計数。機器をまたぐ差は同期・同一時計系がなければ計算しない | 輸送・変換の待ちを切り分ける |
| provider最初の訳字幕・訳音声delta | サーバー側単調時計 | 補助指標。意味対応・耳到達の代用にしない |
| listener受信→queue投入→schedule→再生開始／終了 | iPhoneの単調時計、queue byteとscheduled byte | 再生待ちとterminal overflowの特定 |
| private headsetで実際に聞こえた開始／終端 | 同一測定系での外部ループバック録音、または同期済みfixture＋評価者。測定構成と誤差幅を記す | 主指標。端末時計の単純差を使わない |

外部ループバックが難しいときは`ear onset`を「未測定」と明記し、端末での再生schedule開始を**推定値**として分ける。Bluetooth出力のOSバッファをゼロと仮定しない。測定用の合成音声は評価環境でのみ扱い、SDKのファイル・DB・ログ・crash reportへ保存しない。

### 集計と受入

- 各方向（日→英／英→日）で、短文、述語遅延の長文、否定・条件・金額・時刻・地名・話者交代・重複発話を分ける。誤りの分母は**評価した意味区間数**。単語一致率だけで意味品質を判定しない。
- 人手採点は少なくとも「意味が通る」「重要事実が一致」「過剰補完なし」「音声と字幕の整合」「発音の聞き取り」の5軸。重大誤訳＝否定・条件・金額・日付・主体・地名・時制（将来予定と過去実績など）の反転／創作。判断不一致は第三者が理由つきで裁定する。
- `L_start`、`L_fact`、`L_tail`のP50/P95、最悪値、件数、欠損、失敗率を**方向・route・回線ごと**に示す。品質合格例だけを抽出して速度を報告しない。未訳・無音・timeoutは失敗として母集団に含める。
- 5分連続の同条件runを複数実施し、各1分のqueue・遅れの傾きを記録。受入前に既存[`docs/acceptance.md`](acceptance.md)の60分×route／回線マトリクスも行う。5分成功を60分成功としない。
- オーナーの研究基準は`L_start`の典型値5秒・遅い側8秒を目指すこと。ただし重大誤訳0を優先し、述語がまだ聞こえない発話は情報到来時刻も併記する。実機10秒DoDと2秒／4秒の仮目標は別列で報告する。
- `PLAYBACK_BACKPRESSURE`、queue増加、途切れ、字幕先行・訳音声欠落、回線切替、route喪失を別の失敗カテゴリとし、遅いケースを平均から消さない。

### 記録するデータ

評価表には`run_id`（ランダム）、匿名fixture ID、SDK commit、provider/model、設定ID、方向、端末OS、route、回線、各区間の時間差・queue統計、品質カテゴリ、失敗コード、評価者間一致だけを残す。providerから受ける本文・PCM・個人名・元ファイルpath・セッションtoken・会話内容をイベントログに含めない。人手レビューは一時的な評価環境で音声を聞き、公開repoへは集計と**合成例だけ**を置く。実録音の別provider送信は既存のOpenAI利用承認に含まれない。

## 7. 実装順序と停止条件

1. **計測を先に通す。** 合成日英fixtureで発話onset、対応訳音声のear onset、queue・overflowを測る。現行コードの音声・字幕非保存契約を維持し、計測が本文へ触れないことを確認する。
2. **現行Aの基準線を固定する。** iPhone 2台、HFP／有線、Wi-Fi／携帯、5分run。`near_field`を基準に、同一入力条件で他noise reductionと100／200 ms appendを比較。OpenAIは[200 ms engine frame](https://developers.openai.com/api/reference/resources/realtime/translation-client-events)を処理し、無音継続を求める。短いappendが必ず速いわけではない。非ゼロPCMや小声は削らない。
3. **出力集中の区間を探す。** queue byte→秒換算、再生速度、意味品質を同時に見る。完全無音を除く現行処理は維持しつつ、長い**非無音**訳音声が入力より速く溜まる場合を特定。無条件の倍速、途中破棄、queue上限拡大は行わない。聞き取れる範囲での再生速度調整は別群で盲検比較する。
4. **Bを隔離したprototypeで試す。** 公式の通訳専用promptを土台に、短い背景／用語の条件を比較。権限・予算・room状態・本文非保存を満たすadapter境界だけ作り、質問に回答したり訳を創作したりするなら停止する。
5. **Cを隔離したprototypeで試す。** アカウント・料金・データ取り扱いを確認後、まず合成fixtureのみ。日英双方の音声入出力、source transcript、target text/audio、用語指定、session寿命、PCM変換費を確認する。実録音の送信は別承認後に限る。
6. **同じ採点表でA/B/Cを比較する。** B/Cの改善が地名だけか、否定・金額も改善するか、P95やqueueを悪化させないかを見る。品質改善があっても、発話に答える・重要事実を補う・繰り返し訳すなら製品候補から外す。採用候補を1つに絞った後、既存の実機受入マトリクス全体を実行する。
7. **Dは研究分岐。** A/B/Cの限界が数値と人手評価で明らかになった場合、部分認識の安定性と意味確定を分ける設計を別Issueにする。特許の閾値は候補値にすぎず、JA→ENの否定・述語テストで検証する。

プロバイダ切り替え時は、話者別セッション、固定source/target、private route、使用量lease、接続失敗時の明示resume、出力deltaの順序・上限・captionとaudioの対応を保持する。接続方式が違っても、clientにprovider秘密情報を渡さない。安全契約を緩めて速度改善と報告しない。

## 8. 次のセッションが最初に答える質問

- 実機HFP／有線で、発話onset→耳の対応訳音声onsetは各方向でP50/P95何秒か。provider first byteとの開きはどこにあるか。
- 旧`gpt-realtime-translate`の5分で観測した最大4.91秒の理想queueは、どの原文・出力条件の局所集中か。現行GPT-Liveの公開ラジオ評価では最大0.37～0.45秒だったので、現行経路では意味確定・音声生成の遅れとiOSの実queueを分けて追う。iOSでterminal overflowが再現するか。
- 「固有名詞の誤り」は認識、訳語、訳音声、評価者の聞き取りのどこで発生するか。原文字幕を診断に使っても、文字起こしを真値と誤認しないか。
- Bの背景・用語は不動産語を改善し、誤った推測や応答行動を増やさないか。Bの遅延・費用はAよりどう変わるか。
- CのSpoken TermsとglossaryはJA→ENとEN→JAで効くか。転写の安定性・訳音声開始・再生待ちを含めてAに勝るか。
- 述語や否定が8秒以降に来る発話は、正確性を守ったまま何を先に発話できるか。先出しできない例を明示できるか。

## 9. 参照資料と再確認箇所

API・料金・言語対応は変わり得る。実装開始日に一次資料を再確認する。

- OpenAI：[通訳ガイド](https://developers.openai.com/api/docs/guides/realtime-translation)、[translation client events／200 msフレーム・任意原文転写](https://developers.openai.com/api/reference/resources/realtime/translation-client-events)、[通訳実装ガイド／promptとglossary非対応](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide)、[GPT-Live promptの通訳例](https://developers.openai.com/api/docs/guides/live-prompting)、[モデル料金](https://developers.openai.com/api/docs/pricing)。調査日の公示価格は通訳専用$0.034／分、`gpt-live-1` $0.05／分（セッション単位。双方向・別料金の有無と最新条件を再見積もり）。
- DeepL：[Voice概要](https://developers.deepl.com/docs/voice/overview)、[session設定・入出力形式・Spoken Terms・glossary](https://developers.deepl.com/api-reference/voice/request-session)、[対応言語](https://developers.deepl.com/docs/voice/supported-voice-languages)。プラン・価格・利用条件は契約確認が必要。
- Timekettle：[W4 Proの公式仕様](https://www.timekettle.co/products/w4-pro-ai-interpreter-earbuds-s)、[W4 Plusの公式仕様](https://www.timekettle.co/products/w4-plus-ai-interpreter-earbuds)、[公開特許出願](https://patents.google.com/patent/US20250363985A1/en)。特許と製品機能は区別する。
- Google Research：[直接音声翻訳とlookaheadの説明](https://research.google/blog/real-time-speech-to-speech-translation/)。研究で示す遅延を日英iPhone実機の保証にしない。

## 10. この文書の未検証事項

実iPhone 2台・private headsetでの`L_start`／`L_fact`／`L_tail`、人手採点の翻訳正確率、DeepL Voiceとの同条件比較、背景注入の反復性、再生速度調整の聞き取り、実機60分の遅れ蓄積は未検証。GPT-Liveのソフトウェア上の実API比較は上記10/28・10/29評価に記録した。次の実装セッションは、測定条件・分母・失敗例・未測定を隠さず更新する。
