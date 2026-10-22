# アーキテクチャ

v1はマイク付きイヤフォン用のnear-field noise reductionを指定し、追加のsource transcriptionを明示的に無効化します。字幕は相手向けの翻訳済みoutput transcriptを使い、原文/本人の発言を表示するために別のASRを動かしません。

`packages/protocol` はJSON protocol v1とruntime validationの正本です。client入力は24 kHz mono PCM16の20 ms frame整数倍・最大200 msです。provider出力はdelta境界がframeと一致しないため、even-byte PCMとして検証し、relay/client間では最大200 msへ分割します。字幕は改行・tabを許可し、その他のcontrol文字と4,096文字超を拒否します。

`packages/provider-openai` はinjected WebSocket factory/clockを使います。接続中の最初の音声は5秒分（240,000 bytes）までqueueし、`session.created` 後の初期設定に対する `session.updated` を待ってから順番にflushします。5秒のconnect/config timeoutはこのACKまで有効です。transport bufferを観測できる場合は192,000 bytesでfail closedし、観測できない場合は同時に1件だけ空の部分 `session.update` を5秒間隔で送るcontrol ACK watchdogを使います。既知media eventとoptional PCM metadataを厳格に検証し、`rate_limits.updated` とboundedな未知non-media controlだけを無視します。出力は `session.output_audio.delta.delta` を読み、4,800-byte chunkへまとめ、close時のeven-byte末尾も短いPCMとして通知します。watchdogはtransport livenessだけを示し、翻訳成功は示しません。

`packages/room-core` は外部I/Oを持たないroom state machineです。v1はhost 1席 + guest 1席で、切断後2分の席予約、generation、明示host control、最大90分、字幕2分を管理します。`client.ready` は開始ではなく、相手言語のready listenerがいなければcaptureできません。v1は出力言語ごとに話者が1人のため、音声の配信条件は有効なcapture・相手listener・現行providerです。端末energy/focusは推定時刻だけに使い、小声や10秒を超えた有効な翻訳音声を捨てません。room-coreのfocus policyはv2の検討基盤として保持しています。10秒は実機で測る受入目標です。

`packages/relay-core` は同じ `roomId + roomEpoch` のconnect/receive/close/tick/provider callbackを直列化し、検証済みclient操作の待ちを接続ごとに32件へ制限します。全server eventは接続単位の `deliveryId` を持ち、未ACKを実wire bytes 512 KiB/128 event以内に保ちます。5秒ごとのpresence同期とclient ping（15秒timeout）をserver clockで判定し、Authority失敗時は全sourceをfail closedにして、明示 `capture.resume` とfresh sync成功まで再開しません。provider tokenをclose前に無効化し、旧admission・旧generation・旧providerのlate callbackを破棄します。leaseは最大15秒に加えて `maxInputAudioMs`、200 ms token-bucket burst、wall-clock pacingを強制します。

`ios` はSwift Packageです。`TranslateSession` がhost注入config、明示同意、OS permission、WebSocket、route、capture、話者generation別playback、2分・最大100件のcaption memoryを結線します。字幕deltaは同じspeaker/generation/language/captionOnlyかつ2秒以内なら空白を足さずに4,096文字まで結合します。readinessはtransport、検証済みidentity、同意、マイク許可が揃って初めて1回送ります。マイクmuteと翻訳再生は独立です。

## Room placement

同じ `roomId + roomEpoch` は、必ず同じsingle-writer actorへrouteしてください。reference registryは単一process専用です。Cloudflare例は検証済みclaimsからDurable Object IDを導出し、DO内でもJWTとIDを再検証します。v1の2席、admit、generation、control、lease停止、provider callbackを同じ直列境界へ入れます。

ended tombstoneはroom最大寿命90分 + ticket最大TTL 60秒以上保持します。TTL後もprivate Authorityがended epochを正本として拒否する必要があります。同一epochを再作成してはいけません。新しい会話は新しいepochにします。

## 推定値

- clientの `atMs` は表示・診断用で、relayの `Date.now()` と比較しません。
- speech boundaryは端末energyによる推定で、話者identityやcontent alignmentを保証しません。
- latencyは `unknown` または `estimated` だけです。
- provider final eventやprovider発話境界へ依存しません。
- 実API audio成功とiPhone実機10秒受入は未完了です。
