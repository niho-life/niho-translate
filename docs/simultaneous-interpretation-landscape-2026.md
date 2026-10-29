# 日英同時通訳の設計に関する研究・製品の調査（2026-10）

調査日: 2026-10-28。対象: v1 の日英 2 人対面通訳（ホスト 1＋ゲスト 1、iPhone とイヤフォン、話者別ストリーム、聞き手だけに訳音声）。追跡 Issue: [#21](https://github.com/niho-life/niho-translate/issues/21)。前提の調査は [translation-quality-research.md](translation-quality-research.md)、同日の比較結果は [translation-quality-eval-2026-10-28.md](translation-quality-eval-2026-10-28.md)。

**2026-10-29 更新:** §7 に追加の一次資料と、現行実装へ反映する順序を記載した。§4 の「A」は10/28時点の旧基準線で、現在のNode relayの既定は `gpt-live-1` の `plain-q`。連続5分の音声時刻による評価は [public-audio-software-evaluation-2026-10-29.md](public-audio-software-evaluation-2026-10-29.md) を正とする。

公開資料から事実として言えることを整理し、NIHO の判断順（意味 > 運用の単純さ > 費用）で使える形にする。一次資料で確認した数値だけを断定し、起点・終点が書かれていない販促値は「比較不可」とする。研究の遅延値はモデル出力の時刻で、端末・回線・Bluetooth・再生待ちを含まない。NIHO の `L_start`（節の発話開始→その意味を担う英語音声の開始）とは定義が違うので、§1.1 の読み替えを経ずに並べない。

## 結論（10 行以内）

1. 日→英の直接音声翻訳を公開ベンチマークで評価した研究・公開重みは見つからなかった。主な研究（Hibiki、Hibiki-Zero、StreamSpeech、SimulTron、Google 2025）は欧州語と英語の間、Seed LiveInterpret は中⇄英。日本語を含むのは SeamlessStreaming だけで、論文自身が日本語群の品質低下と遅延増を書いている。日英は自前で測るしかない。
2. 近い言語対でも長文の LAAL は 5.6〜7.3 秒（Hibiki-Zero 論文の長文テストで Hibiki-Zero と Seamless）、中→英の音声→音声 AL は 5.18（Seed）。人間の通訳者も英→日で 2〜4 秒、日→英はさらに遅い。指標は違うが、現行 A の `L_start` P50 5.3 秒が研究の水準より大きく遅いとは言えない。残る遅さは日本語の節の長さと述語の位置に由来し、話者が短く区切れば縮むと見込める。
3. 述語・否定の後置への対処は「待つ」「源言語の語順に寄せて訳す」「予測して早出し」「字幕だけ書き換える」の 4 系統。音声は取り消せないので予測は採らない。A は待つ方策を学習済みで（通訳者の音声で学習と公式に記載）、外から変えられるのは B の prompt と字幕・再生の扱いだけ。
4. 英語が長くなる問題は人間も機械も圧縮（要約・省略・一般化）で解く。長さを報酬にするとモデルは訳抜けで最適化する（Seed で訳音声 35% 短縮・品質低下）。圧縮は重大誤りを増やさない範囲で測り、再生の加速は聞き取りを盲検してから入れる。
5. 質問が一人称の陳述になる癖は、主語の省略・文末の疑問標識・節末前の訳出開始が重なると起きると推定する（日英で質問の保持を測った研究は見つからない）。通訳の規範は一人称の直接話法。質問保持と人称を独立の評価軸にし、B は `-q` プリセットで比べる。
6. 固有名詞は全方式の弱点（2021 年の評価で音声翻訳の人名の正解は 37〜40%）。用語を入れられるのは DeepL Voice（spoken terms＋glossary）、Qwen（hotword）、GPT-Live（prompt）とイベント製品の glossary。OpenAI translate と Gemini Live Translate は入れられない。streaming の用語置換は複数語で漏れ得る（DeepL が明記）。
7. BLEU/COMET は通訳らしい単調な訳を不当に低く採点し得る（Simul-COMET）。Seed の SVIP（断片ごとの有効情報＋遅延・話速・発音）が NIHO の目的に最も近い人手評価。LLM 判定には位置・冗長・自己選好の偏りがあり、OpenAI のエンジンを OpenAI の判定器で採る現状は第 2 判定器と人手の anchor で補正する。
8. 現行方針（A を基準に残し、B を adapter 化して実機で並走）を支持する。次に比べる直接音声は Gemini 3.5 Live Translate（日英対応・約 $0.037/分・指示不可）。用語集の効果を見るなら自作カスケードより先に DeepL Voice。カスケードの再挑戦は §4.3 の条件をすべて満たすときだけ。

## 1. 研究（2023〜2026）

### 1.1 遅延指標の読み替え

| 指標 | 何を測るか | NIHO の指標との関係 |
|---|---|---|
| AL（Ma et al. 2019） | 各訳語を出すまでに読んだ原音の量と、等速で訳す理想方策との差の平均。訳が長いと過小評価される | 語ごとの平均。節の頭から測る `L_start` とは別物 |
| LAAL（Papi et al. 2022） | AL の理想方策を、参照訳と出力の長い方で割る。過剰な生成を得点にしない | 原語の語とその訳の平均の時間差を近似する（Hibiki の説明）。Hibiki と Hibiki-Zero は Whisper の単語時刻で計算 |
| StreamLAAL | 分割しない長い音声での LAAL。IWSLT 2025 の順位付けに使用（計算時間は含めない） | 同上 |
| StartOffset / EndOffset（SimulEval） | 最初の出力まで / 原音の終わりから出力の終わりまで | EndOffset は `L_tail` に近い |
| Ending Offset（Seamless）/ End Offset（Hibiki） | 原音の終わり→訳音声の終わり（Hibiki は最後の語の終わり同士） | `L_tail` に近い |
| ATD（Kano et al.、arXiv 2022） | 訳の終わりの時刻も見る。長い訳による遅れを罰する（AL は罰しない） | 英語が長くなる問題（§3 b）を測る |
| FLAL（Seed） | 段落単位で最初の確定訳が出るまで | 最初の語の時刻で、意味の対応は問わない |
| EVS（通訳研究） | 原発話と対応する訳の時間差。文頭・文末で測る | 人間の基準線。`L_start` / `L_end` と同じ考え方 |

読み方: `L_start` ≈ 節の長さ ＋ `L_end`。今日の正解原稿は節の長さ P50 6.7 秒、30% が 8 秒超なので、モデルが節末で訳し始めても `L_start` は大きくなる。研究の値に端末・回線・Bluetooth・再生待ちを足したものが、NIHO の耳の時刻に当たる。

### 1.2 直接音声翻訳の研究

| 研究 | 言語対（日本語） | 音声の作り方・方策 | 公表された遅延と品質 | 重み・利用 |
|---|---|---|---|---|
| SeamlessStreaming（Meta、2023-12） | 多言語。日本語は音声入力・音声出力とも対象 | 1 モデル。EMMA（注意ヘッドごとの単調方策）で読む/書くを決め、テキスト→音声ユニット→vocoder | Fleurs 平均（閾値 0.5）: 音声→英語テキスト AL 1.68 秒・LAAL 2.20 秒、音声→英語音声 Ending Offset 2.79 秒（ASR-BLEU は offline 29.7→22.1）。日本語を含む遠い言語群は品質低下・遅延増と明記 | CC BY-NC 4.0 |
| Hibiki（Kyutai、2025-02、ICML 2025） | 仏→英のみ | decoder-only の multistream で原音・訳音声・訳テキストを 12.5 Hz で同時に扱う。翻訳モデルの perplexity で語ごとの遅れを決める contextual alignment で学習データを合成。推論は温度サンプリングだけ | 長文: ASR-BLEU 27.2・LAAL 5.6 秒・End Offset 2.8 秒（Seamless 25.4・4.2・1.6）。人手 MOS の品質 3.78（Seamless 2.22）。学習で一律 10 秒遅らせると LAAL 9.0 秒、文末まで待たせると 21.5 秒 | CC-BY 4.0。蒸留版は iPhone 16 Pro で実時間 |
| Hibiki-Zero（Kyutai、2026-02、ICML 2026） | 仏・西・葡・独→英（伊は 850 時間で追加） | 文単位の対応だけで学習し、GRPO 強化学習で遅延を詰める | 長文: LAAL 5.6〜6.3 秒・End Offset 2.0〜2.6 秒（同じテストで Seamless 6.2〜7.3 秒・2.5〜3.2 秒） | CC BY-NC-SA 4.0。1 セッション 1 話者 1 言語 |
| Seed LiveInterpret 2.0（ByteDance、2025-07） | 中⇄英のみ | 音声を chunk ごとに読み、訳音声を直接生成（声の複製つき）。訳質・遅延・訳音声の長さを報酬に強化学習 | 長文 RealSI: 音声→音声 中→英 AL 5.18・FLAL 2.71・SVIP 67.8、英→中 AL 4.75。音声→テキスト 中→英 AL 2.58・VIP 79.5（表に単位の記載なし） | 重み非公開 |
| StreamSpeech（中国科学院 ICT、ACL 2024） | 仏・西・独→英（短文の CVSS-C） | CTC の対応で読む/書くを決め、訳テキスト→ユニット→HiFi-GAN の 2 段 | 仏→英 chunk 320 ms: ASR-BLEU 22.9・AL 1.27 秒・StartOffset 1.67 秒。960 ms: 25.0・AL 2.80 秒（offline 28.5） | MIT、重み公開 |
| SimulTron（Google、2024-06） | 西→英（会話データ） | Translatotron 系。因果 conformer＋wait-k 注意＋streaming vocoder | MuST-C で 1.1〜2.3 秒（算出は先行研究に準拠とだけ記載）。Pixel 7 Pro で実時間 | 非公開 |
| Google の実時間 S2ST（2025-11 blog） | 英⇄西・独・仏・伊・葡 | 直前 10 秒を要約する streaming encoder＋訳音声を自己回帰で生成し、話者の声を保つ。lookahead は標準 2 秒、言語ごとに調整できる | 「2 秒の遅れ＋推論時間」。測り方の記載なし。語順が大きく違う言語の lookahead は今後の課題 | Meet・Pixel 10。Pixel の Voice Translate は言語数のためにカスケードと明記 |

Seamless の長文 LAAL は Hibiki 論文で 4.2 秒、Hibiki-Zero 論文で 6.2 秒と違う。テスト集合が違うので、論文をまたいで数値を並べない。

### 1.3 日本語に関わる研究

- **人間の通訳者の遅れ。** 名古屋大の同時通訳 DB の単語対（日→英 3,722、英→日 4,932）で、日→英の遅れは英→日よりはるかに大きく、語順の違いが一因（Ono et al. 2008）。NAIST-SIC の英→日（TED）では、簡略化した EVS が経験別に文頭 2.95〜3.57 秒、文末 2.48〜3.89 秒で、文献の 2〜4 秒と一致し、5 秒超も少なくない（Doi et al. 2021）。
- **人間の方略。** 日→英の通訳データ（CIAIR）では、翻訳に比べて分割・受動化・一般化・要約/省略が多い（He et al. 2016）。受動化は動詞を待たずに英語を始めるため。省略・一般化は人間の作業記憶の制約による副産物で、通訳データをそのまま学ぶと最適でない可能性があると著者は述べる。日→英の参照訳を受動化・所有格化して日本語の語順に寄せると、速く良い訳になる（He et al. 2015）。
- **予測。** 文末の動詞を予測し、予測を信じるかを強化学習で決める（Grissom II et al. 2014、独語などの動詞後置言語を想定）。wait-k で暗黙に予測する（STACL、Ma et al. 2019。実験は中→英）。外れた予測を音声で出すと取り消せない。
- **英→日（逆方向だが語順の問題は同じ）。** IWSLT 2025 の遅延帯は英→日だけ 0〜3.5 / 3.5〜5 秒で、英→独の 0〜2 / 2〜4 秒より広い。NAIST の 2025 年システム（Whisper＋Qwen）は英→日 StreamLAAL 3.35 秒で BLEU 29.8（開発セット）。Doi et al. 2024 は chunk ごとの単調訳（CMT）を参照にすると simulST の評価が上がり、既存の通訳由来・offline の参照は過小評価すると示した。Simul-MuST-C（EMNLP 2024）は GPT-4o で salami 型の単調な訳を作り、文法的に遠い言語対ほど効果が大きいと報告。CMU の 2025 年システムは英→中・独だけで、日本語はない。
- **日→英のシステム。** NICT の日→英同時吹替（ACL 2023 demo）は文単位のカスケード（ASR→文区切り→MT→TTS）に適応再生（再生待ちが閾値を超えたら加速）を組み、日本語動画 90 本（約 21.8 時間）で平均遅延 11.90 秒（速いモード。原文と訳音声の文の開始時刻の差）。NICT の万博向けシステム（2025）は数語のチャンク単位の訳と文単位の訳を並列に走らせ、区切りが一致したら連続するチャンク訳を文訳に置き換える（展示・実証は主に字幕表示）。後処理に要約を含む。
- 京都大学・CMU による 2023〜2026 年の日→英 SimulST の論文は、今回の検索では見つからなかった。

### 1.4 研究から読めること

- 文脈に応じて待つ方策（Hibiki の contextual alignment、Seed の強化学習、OpenAI translate の通訳音声での学習）は、一律の待ち（wait-k、固定 lookahead、文末待ち）より品質と遅延の釣り合いが良い。Hibiki の比較では文末待ちの LAAL が 21.5 秒になった。
- 出した訳音声の訂正を扱う研究は見つからない。Seed は書き換え（rewriting）をする商用系と自らを区別し、「十分な情報が来てから訳す」と説明する。
- 直接音声の研究はすべて 1 話者の流れを訳す設計で、2 人の交代や重なりは評価していない（Hibiki-Zero は 1 セッション 1 話者と明記）。NIHO の話者別ストリームはこの前提に合う。

## 2. 商用 API・製品（2026-10 時点）

### 2.1 組み込める API

| API（確認した版） | 方式 | 日⇄英 | 公表遅延 | 用語・文脈 | 公示料金 | 制約・注意 |
|---|---|---|---|---|---|---|
| OpenAI `gpt-realtime-translate`（2026-05-07 公開） | 直接音声。通訳者の音声数千時間で学習し、十分な文脈を待ってから話す | 入力 70+、出力 13（日・英とも含む） | 数値なし | prompt・用語集・発音指定・声の指定なし。名前・固有表現を取り違えることがあると明記 | $0.034/分 | 200 ms 単位で無音も送り続ける。context 16k・出力上限 2k token。セッション長の上限は記載なし。聞き手と同じ言語の発話は訳さないことがある |
| OpenAI `gpt-live-1`（API 一般提供 2026-09-10） | full-duplex の会話モデルを公式の通訳専用 prompt で使う | 言語一覧なし。日本語の声 2 種を 2026-10-16 に追加 | なし | prompt で背景・発音・話速を指定できる。割り込み後も少し話し続けることがあると明記 | $0.05/分（秒課金）＋裏のモデル費 | 質問に答えない・補わないことは prompt 頼み |
| Google `gemini-3.5-live-translate-preview`（2026-06-09 公開プレビュー） | 音声→音声の専用モデル。turn を待たず、話している間に訳す | 70+（表に ja・en） | 「話者の数秒後ろ」（数値なし） | 指示・tools は受けない（用語集なし）。入力言語は自動検出 | 入力 $0.0053/分＋出力 $0.0315/分（約 $0.0368/分） | 入力 16 kHz・100 ms chunk、出力 24 kHz。言語検出の誤り・声の揺れ・背景音の混入を制限事項に明記。SynthID 透かし |
| DeepL Voice API | 1 session で原文転写・訳文・訳音声（内部構成は非公開） | 日: 転写・訳・訳音声とも可。英も可 | なし | spoken terms（beta、転写側）＋glossary 最大 10（訳語側）、formality。用語全体が転写に現れた時だけ適用し、複数語は分割で漏れ得る（streaming に固有と明記） | docs に記載なし | 訳先 5・訳音声 1 まで。chunk 1 秒以下（推奨 50〜250 ms）。無データ 30 秒で終了。接続はいつでも切れ得るので再接続前提。有料 API 契約 |
| ElevenLabs Realtime Translation（WebSocket） | 翻訳＋TTS（`eleven_v4_turbo` などを選ぶ） | 対応表を確認できず | なし | `eagerness`（high は最速、low は文をより待ち質を上げる） | 未確認 | enterprise workspace 限定。Dubbing（日を含む 90+ 言語）は動画・音声ファイルを処理する別機能 |
| Alibaba `qwen3.8-livetranslate-flash-realtime`（2026-09-20） | 訳（Thinker）→音声（Talker）の 2 段、話者分離つき | 入力 60、訳音声 29（日・英を含む） | LAAL 2.3 秒（測り方の記載なし→比較不可） | hotword、長い文脈で名前・用語を決める、画像も文脈に使える | 記事に記載なし | 地域別 endpoint。データの扱いは別途確認 |
| Palabra.ai | ASR から TTS まで自社で一貫するパイプライン | 60+（一覧に日） | 「1 秒未満」（定義なし→比較不可） | glossary、話者ごとの合成声 | 従量 $0.04/分 | クラウド・オンプレ |

### 2.2 製品・会議サービス

| 製品 | 方式 | 日本語 | 公表遅延 | 用語 | 備考 |
|---|---|---|---|---|---|
| Google Meet の音声翻訳 | Gemini 系の音声→音声モデル | 2026-10-22 に 63 言語の任意の組み合わせへ拡大。日本語の有無はページに記載なし | 開発チームは 2〜3 秒の遅れを目標とし、それより速い出力は追いにくく、遅いと会話が崩れたと説明（2025-09） | なし | Business Standard 以上・AI Pro/Ultra など。会議 90 分上限のプランあり |
| Google 翻訳の Live translate（2025-12 ベータ） | Gemini の音声→音声 | 70+ 言語（日本語の明記なし） | なし | なし | 任意のイヤフォン。Android の米・墨・印から |
| Microsoft Teams Interpreter | カスケード（音声→英語テキスト→機械翻訳→TTS、声の模倣可） | 9 言語に日・英 | なし | なし | Copilot ライセンスで 1 人 月 20 時間。PSTN 通話・イベントは非対応 |
| Apple Live Translation（AirPods） | 端末内処理（Apple Intelligence） | 2025-11 時点で対応 | なし | なし | ANC が相手の生声を下げる。AirPods Pro 2 以降などと対応 iPhone |
| Wordly | 音声認識＋機械翻訳＋TTS | 話す・聞くとも日本語 | 字幕「1 秒未満」（定義なし→比較不可） | glossary（数千語） | イベント向け |
| KUDO AI | 特許の音声→音声工程（内部非公開） | 未確認 | 「平均 4.1 秒」（定義なし→比較不可） | glossary | 話者の速さを示し速すぎを警告する Speedometer（2024 年の特許） |
| Interprefy AI | 非公開 | 80 言語に日（音声の入出力） | AI は「最小限」（数値なし）。人間の遠隔通訳は基盤 0.2 秒未満＋通訳者 約 5 秒 | glossary | イベント向け |
| Timekettle W4 Pro / X1 | 非公開（AI Semantic Judgment / Semantic Segmentation） | 対応（英⇄日はオフラインパックもあり） | 2025-01 の発表に「3〜5 秒」と「ほぼゼロ」が併記（矛盾→比較不可） | W4 Pro に個人用語集 | X1 は 3〜20 人。特許出願の構成は既存調査 §4 |
| Vasco E1 | 交互に話す方式 | E1 のページに明記なし | なし | なし | 同時通訳ではない |
| ポケトーク ライブ通訳 | Web ブラウザで動くサービス | 話者 10 言語（日・英を含む）→75 言語の音声・テキスト | なし | 記載なし | 2025-03 に複数人で共有するプラン |

### 2.3 読み方

- 販促の遅延値（KUDO 4.1 秒、Timekettle 3〜5 秒、Palabra・Wordly の 1 秒未満、Qwen 2.3 秒）は起点・終点が書かれておらず、NIHO の `L_start` と比べられない。
- 方式は二つに分かれる。遅延と声を取る音声→音声モデル（OpenAI、Google、Seed、Qwen）と、言語数と用語集を取るカスケード（Microsoft、Wordly、Palabra、Pixel の Voice Translate）。用語集を正式に持つのはカスケード側に多い。
- 直接音声に外から入れられる文脈は、GPT-Live の prompt と Qwen の hotword・長い文脈だけ。OpenAI translate と Gemini Live Translate は指示を受けない。

## 3. 論点別の知見

### (a) 日本語の述語・否定の後置と早出し

- 人間でも日→英は英→日より遅れる（Ono et al. 2008）。評価会も英→日に広い遅延帯を設ける（IWSLT 2025）。Seamless は日本語群で遅延が増え、Google は語順が違う言語の lookahead を今後の課題とする。
- 早出しの方法は 4 つ。(1) 待つ: OpenAI translate は十分な文脈を待つよう学習、Seed は十分な情報が来た時だけ訳す。(2) 源言語の語順に寄せて訳す: 受動化・分割・主題の先出し（He et al. 2015・2016、CMT、salami）。(3) 予測する: 動詞予測（Grissom II et al. 2014）、暗黙の予測（STACL）。(4) 字幕だけ書き換える: re-translation は少ない書き換えでも streaming と同等以上（Arivazhagan et al. 2020）。NICT はチャンク訳を文訳で置き換える。
- 訳音声は取り消せない。音声の訂正を扱う研究は見つからない。人間の通訳の規範では誤りに気づいたら訂正する（NCIHC 2005）が、そのぶん発話量が増える。
- 原語を理解できる評価者は、書き換えの少なさより遅延の小ささを好んだ（Javorský et al. 2022、独→捷の字幕）。字幕の書き換えは許容されやすいが、音声には当てはまらない。
- 今日の結果では A・B とも `L_end` P50 が −0.5〜0.3 秒で、節の終わりの前後で英語が始まっている。発話開始から 8 秒以内を全区間で満たすには述語より前に訳す必要があり、否定・条件の誤りを増やす方向になる。

### (b) 英語の発話量（長さ・話速・聞き手の負担）

- 今日の比較で、自作カスケード D' は 300 秒の日本語に英語 234〜318 秒（0.78〜1.06 倍）、A は 154〜223 秒（0.51〜0.74 倍）。直接音声モデルは訳を圧縮している。
- 人間の同時通訳も要約・省略・一般化で圧縮する（He et al. 2016）。
- 訳音声の長さを原音に合わせる報酬だけで学習すると、Seed では訳音声が約 35% 短く、token が約 15% 減り、品質が落ちた（訳を抜いて報酬を稼ぐ）。品質の報酬を足すと、音声の短縮は約 15% で品質を保った。吹替では訳の冗長さを時間に合わせて制御する研究がある（Lakew et al. 2021）。
- AL は長い訳による遅れを罰しないが、ATD は罰する（Kano et al.）。NIHO は `L_tail` と再生待ちを併記する。
- 再生側では、NICT の吹替は待ちが閾値を超えたら加速する。Timekettle の特許出願は未再生 40 文字以上で 1.5 倍の例を挙げる。KUDO は話者に速すぎを警告する。GPT-Live は prompt で話速を変えられる。
- 聞き手の負担: chunk 間の無音が多いと不自然で認知負荷が上がり得るとして、無音を減らす研究がある（NaturalFlow、Interspeech 2026）。Seed の SVIP は話速を独立の採点項目にしている。

### (c) 話者の人称・質問の保持（対話通訳）

- 対話通訳の規範は一人称の直接話法で、通訳者が自分のことを話すときは三人称（「通訳者は…」）を使う（ミシガン州裁判所事務局の通訳者手引き 2015）。足さない・省かない・置き換えない、話者の調子を保つ（NCIHC 2005）。
- GPT-Live の公式通訳 prompt は、すべての発話を引用として扱い、質問・命令に答えないよう指示する。人称と質問文の扱いは書いていない。
- 今日の比較では全エンジンで質問が一人称の陳述になった（A 16、B 10、D' 9 件）。
- 機構の推定（未検証）: 日本語は主語を省き、疑問は文末の「か」や上昇調で示す。英語の疑問文は文頭で語順が決まるので、文末を聞く前に平叙文で始めると戻れず、省かれた主語が「I」で補われやすい。音声→テキスト翻訳のモデルは韻律を内部に持つが、訳を変えるほど強くないという報告がある（Tsiamas et al. 2024、英→独・西・日）。上昇調だけの質問は落ちやすい可能性がある。
- 日英で質問の保持や人称を測った研究・製品の公表値は見つからなかった。

### (d) 固有名詞・用語

- 音声翻訳は用語の 75〜80%、固有表現の 65〜70%、人名は 37〜40% しか正しく訳せなかった（Gaido et al. 2021、英→西・仏・伊）。
- 入れる場所は 3 つ。認識側（DeepL の spoken terms、Qwen の hotword）、訳語側（DeepL の glossary、Palabra・Wordly・KUDO・Interprefy・Timekettle の glossary）、文脈（GPT-Live の prompt、Qwen の長い文脈）。OpenAI translate と Gemini Live Translate は入れられない。
- streaming の構造的な限界: DeepL は用語全体が転写に現れた時だけ glossary を適用し、複数語の用語は分割で漏れ得ると明記する。
- 今日の比較では B の背景＋用語集で地名の誤りが 0 件（なしで 2 件）だったが、run 間のばらつきの範囲で、効果は示せていない。

### (e) 耳に届く時刻の測り方

- 人間の EVS は文頭・文末で測る（Doi et al. 2021）。NICT の吹替は原文と訳音声の文の開始時刻の差を平均する。Seed の SVIP は遅延を 5 段階（3 秒未満、3〜5、5〜7、7〜9、10 秒以上）で人が採点する。
- 研究の値はモデル出力の時刻で、端末・回線・Bluetooth・再生待ちを含まない。Google の 2 秒は内部の lookahead で、推論時間が加わる。
- Bluetooth: iOS の `AVAudioSession.outputLatency` は OS の見積もり。AirPods 2 で OS の値 約 161 ms に対し、実測は接続直後 215〜220 ms から 20〜30 分で 155〜160 ms へ下がったという開発者の報告がある（逸話・route 不明）。時間で変わる前提で、route ごとにループバックで実測し、定数とばらつきとして足す。
- OpenAI のガイドは、最初の訳音声の遅延と発話終了後の遅延を、品質と別に追うよう勧める。DeepL は低遅延のために chunk 50〜250 ms を推奨する。
- 発話の切れ目のまとめ出し（今日 A で理想再生待ち 3.3 秒）は耳の遅延を押し上げ、保持上限を超えると音声を落とす。NICT の吹替は加速で吸収するが、評価は遅延・途切れ・長さの一致で、聞き取りやすさの評価は見当たらない。

### (f) 評価

- 自動指標: Seed は BLEURT・COMET が真の能力を反映しないことがあるとして、人手の VIP/SVIP を主に使う。既定の COMET は長距離の並べ替えをした offline 訳を高く採点し、単調な通訳の訳を低く見る（Simul-COMET、英日、Findings of ACL 2026）。offline の参照訳も simulST を過小評価する（Doi et al. 2024）。
- 人手: SVIP は断片ごとに意味の有効性（VIP）を見たうえで、遅延・話速・発音・流暢さを 5 段階で採点し、どれかが 1 点なら無効、すべて 3 点以上なら有効、2 点があれば文の意味が通じるかで決める。MQM は専門家が文書の文脈つきで誤りを分類し、crowd の評価と順位が変わる（Freitag et al. 2021）。continuous rating は原語を少しでも理解できる評価者なら信頼できる（Javorský et al. 2022）。
- LLM 判定: GEMBA は system-level で MQM と高く一致したが（WMT22 の 3 言語対）、区間単位の妥当性は示していない（Kocmi and Federmann 2023）。判定器は提示順・長さ・自分の出力を好む偏りを持ち（Zheng et al. 2023）、自分の出力を見分ける力と自己選好は相関する（Panickssery et al. 2024）。
- NIHO の現状: ASR と判定器が OpenAI で、比べるエンジンも OpenAI。同系統の偏りがあり得る。OpenAI 以外の第 2 判定器（`research/eval` の `agy` backend）との一致率と、人が採点した小さな anchor 集合での一致率を出してから、判定の差を読む。

## 4. NIHO への示唆

### 4.1 直接音声モデルを基準にしたときの「直せること」と「限界」

| 論点 | prompt で（B のみ） | 入出力・再生で（A/B 共通） | モデル側の限界 |
|---|---|---|---|
| (a) 述語の後置 | 「否定・条件・数は節末まで確定させない」「迷ったら短く待つ」を試す（効果は未検証） | 訳字幕は後で置き換えてよいが、訳音声は書き換えない。評価は `L_start` と `L_end` を併記し、8 秒超の節は情報が来た時刻を基準にする。話者への案内（短く区切って話す）は `L_start` を縮める最も安い手段（推定） | 待つか予測するかは学習済みの方策。A は外から変えられない |
| (b) 発話量 | 簡潔に、言い淀みと繰り返しは訳さない、話速の指定 | 再生待ちは soft 2 秒（通知）・hard 5 秒（未再生の無音→古い音声の順に落とす）の 2 段に変更済み（2026-10-28、実機未検証）。落とした音声による意味の欠落を数え、加速（例 1.1〜1.25 倍、仮の値）と盲検で比べる | A の圧縮の度合いは変えられない。圧縮しすぎると訳抜けになる |
| (c) 人称・質問 | `-q` プリセット（質問は二人称の質問のまま、陳述にしない）を同じ窓で A/B | 評価に「質問の保持」「人称」を独立の軸として足す。話者への案内（質問は文末をはっきり言う）は補助 | 文末の疑問標識が来るまで英語の文型は決まらない。A は prompt を受けない |
| (d) 固有名詞 | 背景＋用語。3 窓 × 2 run 以上で効果を確かめる | 地名のローマ字表記を固定する。事前登録の用語（地名・物件名）の置き場と扱いは別 Issue | A と Gemini は用語を受けない。streaming の glossary は複数語で漏れる |
| (e) 耳の遅延 | — | route ごとのループバック実測。`outputLatency` は記録するが信用しない。`L_start`・`L_end`・`L_fact` と再生待ちの P95 を route 別に出す | provider 内部の lookahead は見えない |
| (f) 評価 | — | 判定器 2 系統の一致率、人手の anchor（例: 50 区間を 2 人）、SVIP 型の遅延・話速・発音の人手採点。BLEU/COMET は補助に留める | LLM 判定の区間単位の妥当性は確立していない |
| 音声と字幕の不一致（A） | — | 研究ハーネスで再現率を測り（同じ窓で 10 run 以上）、合成音声で再現すれば OpenAI へ報告する | モデル内部の不整合で、外からは直せない |

### 4.2 次に比べる候補

- **Gemini 3.5 Live Translate**: 日英を API で扱え、料金は A と同等（約 $0.037/分）。指示と用語を受けない点も A と同じ。同じ窓で `L_start` と意味を比べる価値がある。
- **DeepL Voice**: 用語集の効果を確かめる最短の経路（運用を任せられるカスケード）。料金・契約・実録音を送る許諾を先に確認する。
- **Qwen3.8 LiveTranslate / ElevenLabs Realtime Translation**: hotword、`eagerness` という調整軸を持つ。データの扱い（地域 endpoint）と契約（enterprise 限定）を先に確認する。
- 新しい事業者へ実録音を送ることは既存の利用承認に含まれない。合成 fixture から始める（既存調査 §5 と同じ）。

### 4.3 カスケード再挑戦の条件（すべて満たすときだけ）

1. 直接音声（A・B・Gemini）の重大誤りが固有名詞・用語に偏り、用語の注入で減ることを DeepL Voice で先に示せる。
2. 英語の長さを原音の 0.75 倍以下に抑える訳（要約的な同時通訳）を、重大誤りを増やさずに作れることを同じ判定で示せる（D' は 0.78〜1.06 倍だった）。
3. NICT 型の分離（チャンク訳を字幕と音声にすぐ出し、文訳が来たら字幕だけ置き換える。音声は取り消さない）で、合成 fixture の `L_start` P50 6 秒以下・P95 10 秒以下を示せる。
4. 3 段の provider の障害・費用・再生待ちを、話者別セッション・private route・lease・本文非保存の契約を変えずに運用できる。

## 5. 一次資料一覧（URL・確認日）

| 区分 | 資料 | URL | 確認日 |
|---|---|---|---|
| 研究 | Seamless（Barrault et al. 2023） | https://arxiv.org/abs/2312.05187 | 2026-10-28 |
| 研究 | Hibiki（Labiausse et al. 2025） | https://arxiv.org/abs/2502.03382 | 2026-10-28 |
| 研究 | Hibiki の model card（license） | https://huggingface.co/kyutai/hibiki-2b-pytorch-bf16 | 2026-10-28 |
| 研究 | Hibiki-Zero | https://arxiv.org/abs/2602.11072 | 2026-10-28 |
| 研究 | Hibiki-Zero の model card | https://huggingface.co/kyutai/hibiki-zero-3b-pytorch-bf16 | 2026-10-28 |
| 研究 | Seed LiveInterpret 2.0 | https://arxiv.org/abs/2507.17527 | 2026-10-28 |
| 研究 | StreamSpeech（Zhang et al. 2024） | https://arxiv.org/abs/2406.03049 | 2026-10-28 |
| 研究 | StreamSpeech の実装と重み | https://github.com/ictnlp/StreamSpeech | 2026-10-28 |
| 研究 | SimulTron | https://arxiv.org/abs/2406.02133 | 2026-10-28 |
| 研究 | Google Research: Real-time speech-to-speech translation | https://research.google/blog/real-time-speech-to-speech-translation/ | 2026-10-28 |
| 研究 | NaturalFlow | https://arxiv.org/abs/2606.13121 | 2026-10-28 |
| 日本語 | Ono et al. 2008（単語単位の同時通訳コーパス） | https://nagoya.repo.nii.ac.jp/records/13225 | 2026-10-28 |
| 日本語 | Doi et al. 2021（NAIST-SIC） | https://aclanthology.org/2021.iwslt-1.27/ | 2026-10-28 |
| 日本語 | He et al. 2016（Interpretese vs. Translationese） | https://aclanthology.org/N16-1111/ | 2026-10-28 |
| 日本語 | He et al. 2015（Syntax-based Rewriting） | https://aclanthology.org/D15-1006/ | 2026-10-28 |
| 日本語・語順 | Grissom II et al. 2014 | https://aclanthology.org/D14-1140/ | 2026-10-28 |
| 日本語・語順 | STACL（Ma et al. 2019） | https://arxiv.org/abs/1810.08398 | 2026-10-28 |
| 日本語 | IWSLT 2025 Simultaneous track | https://iwslt.org/2025/simultaneous | 2026-10-28 |
| 日本語 | NAIST の IWSLT 2025 システム | https://aclanthology.org/2025.iwslt-1.39/ | 2026-10-28 |
| 日本語 | CMU の IWSLT 2025 システム | https://arxiv.org/abs/2506.13143 | 2026-10-28 |
| 日本語 | Doi et al. 2024（CMT） | https://arxiv.org/abs/2406.08940 | 2026-10-28 |
| 日本語 | Simul-MuST-C | https://aclanthology.org/2024.emnlp-main.1238/ | 2026-10-28 |
| 日本語 | SASST | https://arxiv.org/abs/2508.07781 | 2026-10-28 |
| 日本語 | NICT 日→英同時吹替（Wang et al. 2023） | https://aclanthology.org/2023.acl-demo.16/ | 2026-10-28 |
| 日本語 | NICT 研究報告（万博の同時通訳） | https://www.nict.go.jp/publication/shuppan/kihou-journal/houkoku71-1r_HTML/2025O-03-02.pdf | 2026-10-28 |
| 指標・評価 | LAAL（Papi et al. 2022） | https://arxiv.org/abs/2206.05807 | 2026-10-28 |
| 指標・評価 | ATD（Kano et al.、arXiv 2022） | https://arxiv.org/abs/2211.13173 | 2026-10-28 |
| 指標・評価 | Re-translation vs. Streaming（Arivazhagan et al. 2020） | https://aclanthology.org/2020.iwslt-1.27/ | 2026-10-28 |
| 指標・評価 | Continuous Rating（Javorský et al. 2022） | https://aclanthology.org/2022.wmt-1.9/ | 2026-10-28 |
| 指標・評価 | Simul-COMET（Doi et al. 2026） | https://aclanthology.org/2026.findings-acl.2110/ | 2026-10-28 |
| 指標・評価 | MQM（Freitag et al. 2021） | https://arxiv.org/abs/2104.14478 | 2026-10-28 |
| 指標・評価 | GEMBA（Kocmi and Federmann 2023） | https://arxiv.org/abs/2302.14520 | 2026-10-28 |
| 指標・評価 | LLM-as-a-Judge（Zheng et al. 2023） | https://arxiv.org/abs/2306.05685 | 2026-10-28 |
| 指標・評価 | 自己選好（Panickssery et al. 2024） | https://arxiv.org/abs/2404.13076 | 2026-10-28 |
| 論点 | 固有名詞・用語（Gaido et al. 2021） | https://aclanthology.org/2021.emnlp-main.128/ | 2026-10-28 |
| 論点 | 韻律の利用（Tsiamas et al. 2024） | https://machinelearning.apple.com/research/speech-is-more | 2026-10-28 |
| 論点 | 吹替の冗長さ制御（Lakew et al. 2021） | https://arxiv.org/abs/2110.03847 | 2026-10-28 |
| 論点 | NCIHC 医療通訳の実務基準（2005） | https://www.ncihc.org/assets/media/ncihc%20national%20standards%20of%20practice.pdf | 2026-10-28 |
| 論点 | ミシガン州裁判所 通訳者手引き（2015） | https://www.courts.michigan.gov/49bc33/siteassets/court-administration/access-temporary/foreign-language/flinterpreter-policiesproceduresmanual.pdf | 2026-10-28 |
| 論点 | AirPods の出力遅延の報告（開発者フォーラム） | https://developer.apple.com/forums/thread/679274 | 2026-10-28 |
| OpenAI | Realtime translation ガイド | https://developers.openai.com/api/docs/guides/realtime-translation | 2026-10-28 |
| OpenAI | 通訳実装ガイド（言語一覧・制約） | https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide | 2026-10-28 |
| OpenAI | `gpt-realtime-translate` model | https://developers.openai.com/api/docs/models/gpt-realtime-translate | 2026-10-28 |
| OpenAI | translation client events | https://developers.openai.com/api/reference/resources/realtime/translation-client-events | 2026-10-28 |
| OpenAI | `gpt-live-1` model | https://developers.openai.com/api/docs/models/gpt-live-1 | 2026-10-28 |
| OpenAI | GPT-Live prompting（通訳 prompt） | https://developers.openai.com/api/docs/guides/live-prompting | 2026-10-28 |
| OpenAI | 料金 | https://developers.openai.com/api/docs/pricing | 2026-10-28 |
| OpenAI | changelog（公開日） | https://developers.openai.com/api/docs/changelog | 2026-10-28 |
| Google | Live translation（Gemini Live API） | https://ai.google.dev/gemini-api/docs/live-api/live-translate | 2026-10-28 |
| Google | Gemini API 料金 | https://ai.google.dev/gemini-api/docs/pricing | 2026-10-28 |
| Google | Gemini 3.5 Live Translate の発表 | https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-live-3-5-translate/ | 2026-10-28 |
| Google | Meet の音声翻訳 63 言語 | https://workspaceupdates.googleblog.com/2026/10/real-time-speech-translation-in-google-Meet-expands-to-63-languages-with-automatic-language-detection.html | 2026-10-28 |
| Google | Meet の音声翻訳の開発（2025-09） | https://blog.google/products/workspace/google-meet-langauge-translation-ai/ | 2026-10-28 |
| Google | 翻訳アプリの Live translate（2025-12） | https://blog.google/products-and-platforms/products/search/gemini-capabilities-translation-upgrades/ | 2026-10-28 |
| DeepL | Voice 概要 | https://developers.deepl.com/docs/voice/overview | 2026-10-28 |
| DeepL | session の設定 | https://developers.deepl.com/api-reference/voice/request-session | 2026-10-28 |
| DeepL | 形式と session の制限 | https://developers.deepl.com/docs/voice/voice-api-requirements | 2026-10-28 |
| DeepL | 対応言語 | https://developers.deepl.com/docs/voice/supported-voice-languages | 2026-10-28 |
| ElevenLabs | Realtime Translation API | https://elevenlabs.io/docs/api-reference/realtime-translation/v-1-translation-realtime | 2026-10-28 |
| ElevenLabs | Dubbing | https://elevenlabs.io/docs/overview/capabilities/dubbing | 2026-10-28 |
| Alibaba | Qwen3.8-LiveTranslate | https://www.alibabacloud.com/blog/qwen3-8-livetranslate-names-the-speaker--carries-the-meaning-_603581 | 2026-10-28 |
| Palabra | Speech-to-speech API | https://palabra.ai/api | 2026-10-28 |
| Microsoft | Teams Interpreter の管理 | https://learn.microsoft.com/en-us/microsoftteams/interpreter-agent-teams | 2026-10-28 |
| Apple | Live Translation on AirPods（2025-11） | https://www.apple.com/ie/newsroom/2025/11/live-translation-on-airpods-expands-to-the-eu/ | 2026-10-28 |
| Wordly | 品質と遅延 | https://www.wordly.ai/wordly-interpretation-quality | 2026-10-28 |
| Wordly | 対応言語 | https://www.wordly.ai/translator-languages | 2026-10-28 |
| KUDO | Speech translation for venues | https://kudo.ai/solutions/live-speech-translation-for-venues-and-rooms | 2026-10-28 |
| KUDO | Speedometer の特許 | https://kudo.ai/press-release/kudo-awarded-second-patent-from-the-united-states-patent-office-uspto-for-innovative-speech-speed-monitoring-technology/ | 2026-10-28 |
| Interprefy | 対応言語 | https://knowledge.interprefy.com/what-languages-can-interprefy-ai-translate-from-and-to | 2026-10-28 |
| Interprefy | 遅延の説明 | https://ai-knowledge.interprefy.com/what-is-the-sound-delay-between-the-speaker-and-the-interpretation | 2026-10-28 |
| Timekettle | W4 Pro | https://www.timekettle.co/products/w4-pro-ai-interpreter-earbuds-s | 2026-10-28 |
| Timekettle | X1 | https://www.timekettle.co/products/x1-ai-interpreter-hub | 2026-10-28 |
| Timekettle | W4 Pro の発表（2025-01-08） | https://www.aap.com.au/aapreleases/cision20250107ae90430 | 2026-10-28 |
| Vasco | Translator E1 | https://vasco-translator.com/vasco-translator-e1 | 2026-10-28 |
| ポケトーク | ライブ通訳の発表（2025-03-31） | https://pocketalk.jp/hubfs/resource/corporate/pr/pr_20250331.pdf | 2026-10-28 |

## 6. 未確認・限界

- 日→英の直接音声翻訳の公開研究・公開ベンチマークは見つからなかった。京都大学・CMU の 2023〜2026 年の日→英 SimulST も見つからなかった（検索の網羅性には限界がある）。製品間を日英で比べた独立のベンチマークも見つからない。
- OpenAI translate・GPT-Live・Gemini Live Translate のセッション長の上限、GPT-Live の対応言語一覧は文書に記載がない。`gpt-realtime-translate` の context 16k・出力上限 2k token が長いセッションにどう効くかは未確認。
- Google Meet の 63 言語と翻訳アプリの Live translate に日本語が含まれるかは未確認。ElevenLabs の日本語対応と料金、KUDO の日本語対応と glossary の上限（サポート記事は取得できず）、DeepL Voice の料金と内部構成、Seed の製品提供の形（報道のみ）、Vasco E1 の日本語、Timekettle の遅延（公式発表の中で矛盾）は確認できなかった。
- 販促値はどれも起点・終点が不明で、NIHO の数値と比べていない。
- 「質問→一人称の陳述」の機構は推定で、検証していない。Bluetooth の遅延値は開発者の逸話で、NIHO の route（HFP・有線）では未測定。
- 研究の数値は、Seamless・Seed・NAIST 2025・NAIST-SIC・He et al.・NICT の 2 本は PDF 本文、Hibiki・Hibiki-Zero・StreamSpeech は HTML 本文の表で確認した。SimulTron と一部の抄録は取得ツールの要約経由で、表の列の読み違いの可能性が残る。
- DeepL の docs には AI エージェント向けの指示文が埋め込まれていたが、調査の内容とは関係なく従っていない。
- 料金・言語・提供条件は変わる。実装を始める日に一次資料を再確認する。

## 7. 追加調査：既製品・公開実装から採る設計（2026-10-29）

### 7.1 世界の実装を「製品に使える制御」で比較する

| 系統と一次資料 | 公開されている仕組み・制御 | NIHO に採り込む判断 |
|---|---|---|
| [Google の直接音声翻訳研究](https://research.google/blog/real-time-speech-to-speech-translation/)／[Meet 開発チーム](https://blog.google/products-and-platforms/products/workspace/google-meet-langauge-translation-ai/) | ストリーミングの音声エンコーダ・生成器。研究システムでは約2秒の先読みを用い、Meetの開発者は会話の聞きやすさから2〜3秒の遅れを目安に説明する。公開された直接方式の対象は英語と欧州5言語で、日本語の成果値ではない | モデルの先読みと耳への到達を分けて測る。固定の2秒先読みをNIHO側へ追加しない |
| [Meta SeamlessStreaming](https://ai.meta.com/resources/models-and-libraries/seamless-communication-models/)／[公式実装・ライセンス](https://github.com/facebookresearch/seamless_communication) | モデル内の単調なread/write方策で「聞き続ける／訳を出す」を選ぶ。日本語は対象だが、公開モデル重みはCC BY-NC 4.0 | 音声の確定タイミングをモデル・言語対の能力として評価する。非商用重みを製品へ組み込まない |
| [Microsoft Teams Interpreter](https://learn.microsoft.com/en-us/microsoftteams/interpreter-agent-teams) | 音声認識→翻訳→音声合成の管理された経路。日本語と英語を含む複数話者の会議に対応 | 直列工程があるだけで品質・速度不足とは決めない。ただしNIHOが独自に3サービスをつなぐ判断は、管理された単一セッションAPIと同条件で比較してから行う |
| [Timekettle W4 Plus](https://www.timekettle.co/products/w4-plus-ai-interpreter-earbuds)／[米国特許出願](https://patents.google.com/patent/US20250363985A1/en) | 製品は専門分野・会話記憶を案内。特許にはASR途中結果の安定判定、区切り、訳音声の再生待ち対策が実施例としてある | 用語と長い会話の一貫性、再生待ちを別の評価軸にする。特許の数値をW4 Proの実装値としてコピーしない |
| [DeepL Voice API](https://developers.deepl.com/api-reference/voice/request-session) | 単一の音声セッションで、原文認識への `spoken_terms_id` と訳文への `glossary_ids` を別々に設定できる。ストリーミングの分割位置によって複数語の用語指定は漏れ得る | 鎌倉・湘南の地名、物件用語、人名の正確さを比較する第一候補。用語適用率も測る |
| [Qwen LiveTranslate API](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen3-5-livetranslate-flash-realtime) | 日英の音声入出力、原文字幕、話者検出、`session.translation.corpus.phrases` によるhotwordを文書化 | DeepLと同じ用語fixtureで比較する候補。提供地域・契約・データ保持を確認するまで私有音声は送らない |
| [ElevenLabs Realtime Translation API](https://elevenlabs.io/docs/api-reference/realtime-translation/v-1-translation-realtime)／[発表](https://elevenlabs.io/blog/realtime-translation) | `eagerness=low/medium/high` で訳出開始の慎重さを調整でき、原文・訳文テキストと訳音声を返す。2026-10時点の提供はenterprise向けalpha | 品質優先のlowと中間のmediumを比較する候補。日英対応・アクセス・保持条件の確認前に実データ試験を予定しない |
| [Apple Live Translation](https://support.apple.com/ja-jp/123185) | 端末上で処理し、騒音時にはiPhoneを相手へ近づける運用を案内 | 録音環境・マイク位置・イヤフォン経路を、モデルの点数から切り分ける。PCのWAV試験を実機の代用にしない |
| [OpenAI 通訳ガイド](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide)／[GPT-Live指示例](https://developers.openai.com/api/docs/guides/live-prompting) | 専用翻訳モデルはカスタムprompt・用語集を受けず、原文文字起こしはサイドカー。GPT-Liveには通訳専用の指示例がある | 現在の `gpt-live-1`＋`plain-q` を比較基準とし、背景情報の既定採用は複数録音・反復で検証する |

研究で公開された [StreamSpeech](https://github.com/ictnlp/StreamSpeech) は欧州語→英語、[Hikari](https://github.com/sbintuitions/hikari) は英語→日本語テキスト、[Voiceping のJA–EN Whisper実装](https://github.com/voiceping-ai/whisper-ja-en-speech-translation) は音声→テキスト翻訳である。いずれも現行の**日→英・連続音声→訳音声・対面通訳**をそのまま置き換える公開実装とは確認できなかった。評価器や学習方策の参考に留める。

### 7.2 現行コードに反映したものと次の採用ゲート

| 順位 | 内容 | 状態・採否の根拠 |
|---:|---|---|
| 1 | 話者別の連続音声入力、原文・訳文字幕、再生待ちの上限、内容を残さない診断 | 実装済み。入力の無音は継続送信される。出力側だけデジタル無音を短縮する。iPhoneとイヤフォンの実測は未了 |
| 2 | 長い会話での遅延蓄積を見える化 | このPRで研究レポートに**原文開始時刻で区切った1分ごとの**意味平均、`L_start` p50/p95、8秒以内率、未対応、重大事実誤りを追加。未対応は8秒以内率と意味平均の分母に残す |
| 3 | 同一条件の既製API比較 | 合成の日英対話・地名/数字/否定/質問を用い、5分以上×複数録音×反復で `gpt-live-1`、DeepL Voice、Qwen、利用可能ならElevenLabsを比較。音声時刻で `L_start`/`L_fact`、終了時刻・再生待ち、用語適用率を採る。各APIの費用・データ保持・利用可能地域も記録。Qwenの研究用adapterは追加済み（APIキー未設定のため実疎通未了） |
| 4 | 背景・用語・訳出タイミングの調整 | 既存の背景promptは私有対談3組で意味中央値2.35→2.58/3だったが、`L_start` p95は10.54→11.65秒と悪化。単一の成功窓で製品既定を変えない。用語指定や`eagerness`も独立録音で重大誤り・p95・聞き取りを並べる |
| 5 | 独自の部分ASR→分割翻訳→TTS | 既製の単一セッションAPIで意味と耳到達の両方を満たせない場合だけ試作。訳音声の後からの訂正不可、文末の否定、三段の障害・費用を受入条件に入れる |

[IWSLT 2026 の長時間音声評価](https://aclanthology.org/2026.iwslt-1.3/)は、音声の語時刻と意味対応で遅延を測り、長い音声では遅延が蓄積し得ることを報告している。上の1分表はこの問題をNIHOの既存指標で診断するもので、論文のYAALなどを実装したものではない。[WMT 2026 の人間と機械の同時通訳比較](https://aclanthology.org/2026.wmt-main.30/)が扱う内容・提示・文体の違いも踏まえ、最終採否では数字・否定・主体の人手確認と、聞き手に分かる英語かの盲検を残す。自動判定の点数だけで製品品質を保証しない。

現行の公開音声5分試験では `gpt-live-1` の意味平均2.69/3に対し、音声基準の `L_start` はp50 7.94秒、p95 13.52秒、8秒以内49%だった。別の私有対談では6runのうち1runで対応38区間中24件が8秒超、理想再生キュー最大0.39秒だった。参考原稿・語対応は人手校正前で、いずれも実機の耳到達ではない。**現在の意味と遅延を最高水準・製品受入済みとは扱わず、次の比較の基準線にする。** 根拠と限界は[連続音声の評価記録](public-audio-software-evaluation-2026-10-29.md)にある。
