# 受入項目

## 自動テスト

- provider fake transport: 5秒/240,000-byte connect前queue、`session.created`、初期設定ACK待ち、bufferedAmount未観測の拒否、native ping/pongの照合/timeout/cleanup、input append、audio metadata一致、2-byte/1,002-byte/大きい分割deltaの即時・byte完全一致、close重複なし、先頭完全無音の抑制・発声後の完全無音200ms上限・最小非ゼロsampleとmixed chunkの保持、unknown control、backpressure、connect/close timeout
- protocol: client入力frame alignment、provider出力even-byte alignment、canonical base64、exact schema、host room control、identity、strict error enum、deliveryId/client.ack、初回unauthorized例外
- room: host 1 + guest 1、第三者拒否、2分席予約、generation、readyとstartの分離、guest control拒否、90分寿命、opposite listener必須、mic mute中のlistening
- room-core focus policy: 推定時刻・idle解放の単体検証（v1 relayは音声配信のゲートに使わない。4人overlap優先はv2 TODO）
- relay: 小声などspeech.startなしの翻訳音声・字幕の配信、日英2人の相互翻訳、client時刻非依存、provider token invalidation、admission replacement/revocation、同participant reconnect/old close競合、接続ごと32件のreceiver操作上限
- delivery: 全media/non-mediaの単調deliveryId、未ACK 512 KiB/128 event、ACKなしlistener停止、未来ACK拒否、duplicate/old connection ACK fence、listener喪失時provider停止
- presence: 接続/ready/切断/5秒同期、定常sync中の音声継続、single-flight、current admission照合、遅い旧世代応答の破棄、sync失敗fail-closed、明示resume、15秒client ping timeout、restart後の旧grant拒否
- lease: 最大15秒、`maxInputAudioMs`、relay受信時刻による200 ms burst/rate、300 ms usage遅延中の音声継続、pending/in-flight snapshot、stop/renew時のfinal drain、同lease ledger、usage/renew各single-flight、結果不明snapshotの非再送とlease quarantine、renew中継続、期限後renew拒否、遅い旧source応答の破棄、新lease IDでの明示resume
- Swift core/Session fake: input/output PCM、captionOnly、room/identity/ping/ACK encoding、delivery順序/reset、bounded outgoing/inflight、self/speaker generation gate、connection/task callback fence、Native ping single-flight/pong/timeout/旧callback gate、private route no-auto-resumeと明示capture再開、退出後のsocket/audio/permission/send完了破棄、同一Sessionのticket再試行拒否、PCM先行予約、96,000-byte上限で既存queue順序を保つoverflow拒否、現行overflowのterminal停止、pause/reset、旧completion/overflow fence
- offline WAV replay: fake transportを注入した実provider adapterの可変長deltaの無音正規化後の音声一致と、`127.0.0.1`のreference mock relayへ実WebSocket 2接続した双方向protocol/ACK/byte順序/自己配信なし。WAVなしはメモリ上の非音声PCM、WAV指定時は最大60秒をffmpegで24 kHz mono PCM16へ変換し、音声・字幕・path・filename・PCMを保存または表示しない
- SwiftPM macOS build/testとiOS 15.5 simulator SDK source/example typecheck
- provider終了/期限: 末尾音声と遅いcontrol ACK、flush ACKなし/未送信input破棄時はoutputDrained=false、再入する予期せぬ切断の一度だけの通知、仮想時計での1時間期限・期限後input拒否、relayの安全停止・明示resume・旧provider末尾の破棄

## 公開前に手動で残る項目

### 性能受入マトリクス

性能受入ではSDKに実会話を保存しません。合成音声または利用承認済み評価素材を使い、音声・字幕本文ではなく、下記の区間別集計、端末・route・回線条件、合否だけを記録します。端末時計を同期していないclient/relayの`Date.now()`差分やprovider/relayのaudio first byteを、受信者がイヤフォンで聞いた時刻として扱いません。

| ID | 端末・private route | 回線 | 発話fixture | Authority条件 | 記録する区間 |
|---|---|---|---|---|---|
| A | iPhone 2台・Bluetooth HFP | 同一Wi-Fi | 短文（日→英、英→日） | 通常 | 初回準備、対応原文区間→イヤフォン音声、対応字幕、発話終了→残り再生 |
| B | iPhone 2台・有線headset | 同一Wi-Fi | 長い連続発話（日→英、英→日） | usage応答300 ms遅延 | 同上、音切れ、`AUDIO_LIMIT`誤検知の有無 |
| C | iPhone 2台・Bluetooth HFP | 携帯回線 | 短文・長文・無音 | presence/renew応答300 ms遅延 | 区間別中央値/P95、期限内継続、期限後停止 |
| D | iPhone 2台・有線headset | Wi-Fi→携帯回線切替 | 固有名詞・数字を含む短文/長文 | 応答遅延 + 回線切替 | 音声/字幕の意味対応、再接続準備、旧callback混入の有無 |
| E | iPhone 2台・routeをHFP↔有線で切替 | Wi-Fi | 60分の長文・無音混在 | 通常と300 ms遅延を各1回 | 5分ごとの音声/字幕latency、残り再生、queue増加、音切れ |

各runでOS/端末、SDK commit、route、回線、方向、fixture ID、初回準備時間、意味対応する原文区間→イヤフォン音声、同区間→字幕、発話終了後の残り再生、5分ごとの遅れ、error/route切替を記録します。音声latencyの中央値2秒・P95 4秒は現時点の**仮の最適化目標**として別欄に集計し、未達でも測定値を残します。これは達成済みの主張、公式保証、既存の実機10秒DoDの置換ではありません。

手順は次のとおりです。

1. 両端末のprivate routeと録音同意を確認し、評価fixture IDだけを記録する。
2. room接続開始から最初の入力受付までを「初回接続・準備」として測る。
3. 原文の意味区間ごとに、受信イヤフォンで対応音声を聞いた時点と対応字幕を見た時点を観測する。first byte到着は補助telemetryとして分離する。
4. 発話終了後、その発話に対応して後から生成・受信される分も含め、翻訳音声全体が聞こえ終わるまでを別に測る。短文、長い連続発話、無音、固有名詞・数字で繰り返す。
5. 300 msのusage/presence/renew遅延、lease期限超過、Wi-Fi/携帯切替を個別に注入し、期限内継続・期限後停止・明示resumeを確認する。
6. 60分runでは5分ごとに同じ区間を測り、遅れと残り再生が累積しないか確認する。

### その他の公開前確認

1. 実OpenAI APIで10秒以上の音声を流し、実audioが端末speakerではなくprivate headsetへ届くこと
2. iPhone実機のpermission、interruption、background、Bluetooth HFP、有線headset、route切断、network切替
3. capture resampling、voice processing、energy speech boundaryの推定精度、長時間の音質/latency
4. private Authorityのatomic durable jti consume/current admission更新、hostLastSeen/lastAnySeen、30秒pause/120秒end/90分寿命、budget reservation、usage照合、ended epoch非復活
5. Nodeのnative ping/pongが長い無音・発話中も設定に触れず、同一payloadのpongだけを5秒期限内に確認すること。APIの設定更新・elapsed_ms・訳音声の有無を生存確認に使わないこと。現在のCloudflare transportは実通訳不可であり、送信境界を検証できる代替実装まで有効化しないこと。
6. production single-writer routing、process restart/alarm復帰、bounded tombstone cleanup
7. アクセシビリティ、日英文言、host/guestの実操作
8. 実回線で約15秒の接続期限、5秒間隔Native ping、最大約10秒のpong期限、無音継続、network切替後の切断表示とfresh ticket + 新Sessionでの復帰

上記が完了するまで、製品としての実API/実iPhone接続・10秒受入・60分連続運転・実回線watchdogの全体合格とは報告しません。provider単体の実API試験範囲は末尾に記録します。構文check、pure gate、fake transport成功も実通信成功の代用にしません。watchdogの合格はtransport生存確認に限り、翻訳成功の合格とは分けます。

`npm run test:wav` のoffline/mock成功も、翻訳の意味精度、実OpenAI API、Swift `AVAudioConverter`、実iPhone、イヤフォンへ届くlatency、実機10秒受入、60分連続運転の成功を意味しません。reference mockのechoは翻訳結果または耳に届くlatencyとして扱いません。

## 実APIで確認した範囲（2026-10-23）

provider adapter単体で、合成日→英/英→日とローカルWAVの15秒抜粋を実APIへ送り、音声と字幕を受信しました。合成2ケースでは時刻・金額・否定の3事実を字幕上で確認しました。内容と音声は保存せず、集計だけを記録しています。繰り返しの1回では金額項目の文字列による自動判定が一致しませんでした。表現違いの取りこぼしか実際の誤訳かは未確定で、人による確認を残します。これは人による包括的な翻訳品質評価ではありません。

実APIからの大量の完全ゼロPCMを24kHzで順に消費するモデルでは、再生待ちが約20秒へ増えました。完全無音を200msへ制限した比較モデルでは約0.6秒でした。inputを200msへ変更するだけでは解消しません。elapsed_msを出力durationとは扱わず、sample rateやcodecは推測で変更していません。これらは端末で耳に届く意味対応latencyの測定ではなく、実機受入は引き続き必要です。

無音上限の修正後も実APIで日英両方向と録音15秒を再試験しました。raw出力と配信出力の非ゼロsample列は3ケースとも完全一致し、24kHzの理想消費モデルの最大待ちは約0.50〜0.64秒でした。有声音データの初回受信は原音送信開始から約1.96〜3.35秒ですが、意味対応区間やイヤフォンの実出力を測った値ではありません。session.createdのexpires_atは今回約3,600秒でした。60分運転と期限前の扱いは別受入が必要です。

合成2ケースは `session.closed` を受信しましたが、ローカルWAVのケースは試験の5秒待機内に受信しませんでした。終了時の末尾音声のdrain完了も未受入です。退出後の出力を破棄する既存契約と、この合成試験で測る末尾完了は区別します。

終了処理修正後は、合成日英を各2回と実WAV15秒の計5ケースで `session.closed` と `outputDrained=true` を確認しました。close待ちは約3.5〜5.2秒で、従来の1秒では切り上げるケースです。bufferedAmountを使えないtransportのhealth updateも実APIで2〜4回ACKされ、target language・near_field・transcription=nullを維持しました。非ゼロsampleは全ケース保持され、理想消費モデルの最大待ちは約0.44〜0.78秒でした。

この再試験でも時刻・金額・否定の文字列判定に不一致があり、翻訳品質の合格は取り消しなく継続保留です。サーバーflushと音声サンプル保持の成功から意味精度を推定しません。session期限の安全停止は仮想時計で検証済みですが、無停止更新・2台での60分運転は未完了です。


### 設定更新heartbeatの比較試験

同じ合成音声で、`session.audio={}` の周期更新4ケースと `session={}` の周期更新2ケースでは、別モデルの意味抽出で時刻・金額・否定の少なくとも1つが欠落または曖昧でした。周期更新なしの2ケースは3事実とも一致しました。設定値が維持されることと、翻訳への無害性は別です。単純な文字列判定のfalse negativeも見つかり、同義表現・誤った数字/否定・事実省略の3対照例で意味抽出器の期待判定を確認しています。評価モデルの判定は人による品質合格の代用にしません。

周期設定更新を廃止し、Nodeのnative ping/pongと観測できる送信バッファを実通訳の条件にしました。受信進行だけの案も長い無音で誤停止したため採用していません。APIのelapsed_msをinput ACKやdurationとして扱いません。Cloudflare例のtransportは条件を満たすまで実通訳不可です。

native ping/pongを使う修正後の合成4ケースと実WAV15秒では、すべて `outputDrained=true`、非ゼロsampleの完全保持、初期設定以外の `session.update` なしを確認しました。pingと対応pongはケースごと2〜4回で一致しました。理想消費モデルの最大待ちは約0.51〜0.60秒、初回有声音データは原音送信開始から約1.38〜3.08秒、close待ちは約3.37〜5.31秒でした。実機の意味対応latencyではありません。

合成4ケース中3ケースは意味抽出器上で3事実とも一致し、英→日の1ケースは時刻が異なる判定でした。金額と駐車場の否定は4ケースとも一致しました。周期更新の廃止だけで全誤訳を解消したとは扱わず、時刻の再現性と人による確認を残します。実機・全体認可/予算・60分の受入は未完了です。
