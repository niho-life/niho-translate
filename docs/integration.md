# 統合手順とGeneric Authority契約

ホストアプリはログイン、invite/admission、room state、global budget、マイク権限文言、background audio modeの正本です。SDKへprivate bearer/cookie/user IDを渡さず、固定WSS URL、短命scoped ticket、仮名room/participant ID、admit済みrole/source/targetだけを渡します。

接続順は次のとおりです。

1. 利用者がSDK画面で明示同意する。
2. iOSの録音permissionを別状態として取得する。
3. WSSへticketを `Authorization: Bearer` headerで送り、transport接続と検証済み `session.identity` の両方を待つ（到着順は不問）。
4. transport接続、identity、自分のgeneration、明示同意、録音permissionがすべて揃った時だけSDKが `client.ready` を1回送る。
5. hostだけが `room.start` を送る。
6. relayの `route.canCapture=true` 後、private headset routeを検証してcaptureを開始する。

`capture.pause/resume` は本人のマイクだけを制御し、受信audioを止めません。`room.start/pause/resume/end` はhost専用です。source/target変更は途中操作ではなく、新しいadmission/roomで行います。

翻訳providerの切断やsession期限超過は `PROVIDER_ERROR` とsource pauseになります。同一roomの有効な接続では、利用者の明示 `capture.resume` 後にAuthorityのfresh acquireを通してproviderを作り直します。公表されたprovider期限をSDKが延長することはなく、期限をまたぐ自動更新は未実装です。約60分の会話では、この停止と再開も確認してください。

接続試行、Native pong期限、send/receive、queue上限の失敗後に、SDKは同じ`TranslateSession`とticketで自動再接続しません。ホストアプリへ戻る導線を使い、Authorityからfresh scoped ticketを取得して、新しい`TranslateSession`を生成してください。SDKへNIHOログイン情報やrefresh grantを渡してはいけません。接続後のNative ping/pong watchdogはtransportの生存確認であり、無音中も有効ですが、翻訳処理の成功確認ではありません。

`leave()`、接続喪失、接続後の`setExplicitConsent(false)`はそのSessionの終端です。送受信・再生・収録を止め、字幕を破棄し、同じinstanceへ同意を入れ直しても再接続しません。接続前の同意選択とOS許可の確認は、ticketを実際に試行するまでは行えます。

## Ticket

relayはissuer、audience、`exp/nbf/jti/roomId/participantId/roomEpoch`、config固定の `EdDSA` または `RS256` allowlistを検証します。ticketの残存時間は検証時点から最大60秒です。process内jti cacheに加え、private Authorityの `admit` がjti consumeとcurrent admission grant更新をdurableかつ原子的に行い、relay restartをまたぐreplayを拒否してください。relay内generationはrestartで1へ戻り得るため、単独では認可根拠にしません。

## HTTPS Authority API

すべて `POST`、`Authorization: Bearer <RELAY_SERVICE_TOKEN>`、JSON、5秒以内、redirectなしです。固定 `AUTHORITY_URL` と同じoriginだけを使います。responseはstream読込中から16 KiB上限を強制します。

- `admit`: ticket claimsを受け、`{admissionId,role,sourceLanguage,targetLanguage,roomEpoch,roomState}` を返します。`admissionId` は1〜128文字のopaqueなcurrent connection grantです。role/language/room stateはAuthorityだけが決定し、jti consumeとgrant更新を同じ原子操作にします。
- `rooms/presence`: `{roomId,roomEpoch,participants:[{participantId,admissionId,generation,ready}]}` を受け、`{roomEpoch,state,allowedAdmissionIds}` を返します。接続、admission、ready、切断、および5秒ごとに呼ばれます。Authorityはcurrent grantを照合し、未許可grantを返しません。
- `rooms/control`: `{roomId,roomEpoch,participantId,admissionId,generation,action,cause}` を受け、`{roomEpoch,state}` を返します。actionは `start|pause|resume|end`、causeは `host|lifecycle` です。current grantとgenerationを再検証し、状態遷移を原子的に保存します。
- `leases/acquire`: `{roomId,roomEpoch,participantId,admissionId,generation}` を受け、`{leaseId,expiresAtMs,maxInputAudioMs}` を返します。
- `leases/renew`: acquireの値と `leaseId` を受け、同じshapeを返します。
- `usage`: `{roomId,roomEpoch,participantId,admissionId,generation,leaseId,inputAudioSeconds,atMs}`。音声・字幕本文を含めません。

Authorityは自分のserver clockで `hostLastSeen` と `lastAnySeen` をdurable保持し、host不在30秒でpaused、120秒でended、作成後90分でendedを返します。client時刻やsocket closeの到着を正本にしません。pausedからの復帰にはcurrent hostの明示 `room.resume` が必要で、endedは復帰不可です。service bearerだけを根拠に任意participantの旧grant/generation操作を通してはいけません。

lease expiryは取得時刻より後かつ最大15秒、`maxInputAudioMs` は20〜15,000 msです。relayは入力audio量、最大200 ms burst、wall-clock rateを強制します。renew中に旧lease expiryを越えた場合はrenew responseを採用しません。usageはleaseごとにaggregateされ、renew前後で別leaseへ混ぜません。

usage報告とrenewはそれぞれsingle-flightで並行します。Authorityはrenewで新しいleaseを返した後も、旧leaseが有効な間に受け付けた入力分のusageを旧IDで集計できる必要があります。renewだけを理由に旧IDの報告を拒否せず、各IDの予約済み`maxInputAudioMs`を独立して検証してください。

lease拒否・失効・usage失敗後はsourceをblockedにし、audio packetごとの自動acquireを行いません。利用者の明示 `capture.resume` 後にのみfresh Authority acquireを試します。usageは加算APIのため、応答喪失時はAuthorityで既に計上されたかを判定できません。結果不明のsnapshotは再送せず、そのlease IDを隔離します。同一接続でそのIDを再取得しても再開せず、新しいlease IDのgrantを要求します。これはexact-once配送の保証ではなく、二重計上を避ける安全停止です。

## Relay real mode

- `AUTHORITY_URL`
- `RELAY_SERVICE_TOKEN`
- `TICKET_ISSUER`
- `AUDIENCE`
- `JWKS_URL`
- `TICKET_ALGORITHM`（`EdDSA` または `RS256`）
- `OPENAI_API_KEY`

すべてrelayだけに置きます。priceは変化するためSDKへ固定せず、private Authority側の既定budgetはzeroにしてください。

## iOS host app

`NSMicrophoneUsageDescription`、Audio background mode、認証・invite UIはhost appが定義します。Bluetooth HFPまたは有線headsetはplayback準備時にinputとoutputの両方を検証します。マイクmuteはcaptureだけを止め、翻訳再生を止めません。切断やroute喪失・interruption時はcapture/playbackを止めてaudio sessionをdeactivateし、speakerへ自動切替せず、route復帰後も利用者の明示操作までresumeしません。明示resume時にもprivate input/outputを再検証し、失敗時はmute/listening pauseを維持します。


## v1の実通訳relay

送信バッファを観測でき、native ping/pongを使う `examples/relay-local` のreal modeを選びます。名前はlocalですが、実API・JWT・外部Authorityの経路を持ちます。既定は`HOST=127.0.0.1`です。loopbackの前にTLS終端proxyを置くか、TLSを終端するコンテナ基盤で`HOST=0.0.0.0`と基盤の`PORT`を明示し、単一processへroutingしてください。`HOST`はこの2値以外を拒否します。複数processへそのまま増やしてはいけません。ホストの接続先と配備設定の反映は別途必要です。

現在の `examples/relay-cloudflare` は送信バッファを観測できず、provider設定前に停止します。周期 `session.update` による代替のhealth checkは意味欠落を再現したため廃止しました。未観測値を0にしたり、無音中に返らない翻訳を配送ACK扱いしたりして有効化しないでください。
