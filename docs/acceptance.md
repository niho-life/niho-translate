# 受入項目

## 自動テスト

- provider fake transport: 5秒/240,000-byte connect前queue、`session.created`、初期設定ACK待ち、bufferedAmount未観測時の直列health ACK/timeout/cleanup、input append、audio metadata一致、分割delta、短い末尾PCM、unknown control、backpressure、connect/close timeout
- protocol: client入力frame alignment、provider出力even-byte alignment、canonical base64、exact schema、host room control、identity、strict error enum、deliveryId/client.ack、初回unauthorized例外
- room: host 1 + guest 1、第三者拒否、2分席予約、generation、readyとstartの分離、guest control拒否、90分寿命、opposite listener必須、mic mute中のlistening
- room-core focus policy: 推定時刻・idle解放の単体検証（v1 relayは音声配信のゲートに使わない。4人overlap優先はv2 TODO）
- relay: 小声などspeech.startなしの翻訳音声・字幕の配信、日英2人の相互翻訳、client時刻非依存、provider token invalidation、admission replacement/revocation、同participant reconnect/old close競合、接続ごと32件のreceiver操作上限（Authority待ちを含む）
- delivery: 全media/non-mediaの単調deliveryId、未ACK 512 KiB/128 event、ACKなしlistener停止、未来ACK拒否、duplicate/old connection ACK fence、listener喪失時provider停止
- presence: 接続/ready/切断/5秒同期、current admission照合、sync失敗fail-closed、明示resume、15秒client ping timeout、restart後の旧grant拒否
- lease:最大15秒、`maxInputAudioMs`、200 ms burst/rate、expiry中renew拒否、blocked後の明示resume、lease単位usage aggregate
- Swift core: input/output PCM、captionOnly、room/identity/ping/ACK encoding、delivery順序/reset、bounded outgoing/inflight、self/speaker generation gate、connection/task callback fence、private route no-auto-resume
- SwiftPM macOS build/testとiOS 15.5 simulator SDK source/example typecheck

## 公開前に手動で残る項目

1. 実OpenAI APIで10秒以上の音声を流し、実audioが端末speakerではなくprivate headsetへ届くこと
2. iPhone実機のpermission、interruption、background、Bluetooth HFP、有線headset、route切断、network切替
3. capture resampling、voice processing、energy speech boundaryの推定精度、長時間の音質/latency
4. private Authorityのatomic durable jti consume/current admission更新、hostLastSeen/lastAnySeen、30秒pause/120秒end/90分寿命、budget reservation、usage照合、ended epoch非復活
5. 実OpenAI APIで、初期設定ACK後の空の部分 `session.update`（`session.audio = {}`）を5秒ごとに繰り返してもtarget language、noise reduction、transcription設定を変えず無害であり、各回5秒以内に `session.updated` が返ること。これはtransport livenessの受入で、実translation成功とは別に確認する
6. production single-writer routing、process restart/alarm復帰、bounded tombstone cleanup
7. アクセシビリティ、日英文言、host/guestの実操作

上記が完了するまで、実API接続・課金・iPhone実機10秒受入を成功とは報告しません。構文checkやmock成功も実通信成功の代用にしません。
