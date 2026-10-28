# アーキテクチャ

v1はマイク付きイヤフォン用のnear-field noise reductionを指定し、追加のsource transcriptionを明示的に無効化します。字幕は相手向けの翻訳済みoutput transcriptを使い、原文/本人の発言を表示するために別のASRを動かしません。

`packages/protocol` はJSON protocol v1とruntime validationの正本です。client入力は24 kHz mono PCM16の20 ms frame整数倍・最大200 msです。provider出力はdelta境界がframeと一致しないため、even-byte PCMとして検証し、relay/client間では最大200 msへ分割します。字幕は改行・tabを許可し、その他のcontrol文字と4,096文字超を拒否します。

`packages/provider-openai` はinjected WebSocket factory/clockを使います。接続中の最初の音声は5秒分（240,000 bytes）までqueueし、`session.created` 後の初期設定に対する `session.updated` を待ってから順番にflushします。5秒のconnect/config timeoutはこのACKまで有効です。transport bufferは有限・非負の観測値を必須にし、192,000 bytesでfail closedします。未観測を0と仮定せず、現在のCloudflare transportは実通訳に使いません。native ping/pongがあるtransportでは5秒間隔で固有payloadのpingを送り、同じpayloadのpongが5秒以内に返らなければ停止します。翻訳中に設定更新を送るheartbeatは廃止しました。既知media eventとoptional PCM metadataを厳格に検証し、`rate_limits.updated` とboundedな未知non-media controlだけを無視します。出力は `session.output_audio.delta.delta` ごとにeven-byte PCMを検証し、各deltaを最大4,800 bytesへ順序どおり分割して端数も直ちに通知します。次deltaやcloseを待つ出力bufferは持ちません。最初の非ゼロPCMより前の完全無音は配信せず、その後の連続した完全無音chunkは最大200msへ制限します。非ゼロsampleを1つでも含むchunkは小声を含め全byteを維持し、energy閾値や推測によるcodec変更は使いません。長い完全無音の間隔は短縮されます。watchdogはtransport livenessだけを示し、翻訳成功は示しません。`packages/provider-openai-live` は同じtransport・pre-open queue・送信上限・無音規則・ping/pong・期限監視・drainの規則でGPT-Live（`gpt-live-1`）を使う差し替え候補で、`session.start` から `session.started` までを5秒のconnect timeoutに含め、noise reductionの指定はなく、設定で止められない原文字幕を `onInputTranscript` へ渡します（relay-localの `TRANSLATE_PROVIDER=live`）。

`packages/room-core` は外部I/Oを持たないroom state machineです。v1はhost 1席 + guest 1席で、切断後2分の席予約、generation、明示host control、最大90分、字幕2分を管理します。`client.ready` は開始ではなく、相手言語のready listenerがいなければcaptureできません。v1は出力言語ごとに話者が1人のため、音声の配信条件は有効なcapture・相手listener・現行providerです。端末energy/focusは推定時刻だけに使い、小声や10秒を超えた有効な翻訳音声を捨てません。room-coreのfocus policyはv2の検討基盤として保持しています。

provider単体の `close()` は既定15秒まで `session.closed` を待ち、待機中の末尾音声と遅い設定ACKを受け取ります。`outputDrained` がtrueになるのは、送信待ちinputを捨てずにサーバーのflush ACKまで受信した場合だけです。timeoutや単なるsocket closeは成功にしません。これは端末での再生完了とは異なります。relayの退出・認可失効・muteは先にcallback世代を無効化し、明示1秒の停止期限を維持します。

予期せぬsocket closeまたは `session.closed` は一度だけfatal通知します。providerが公表する `expires_at` を監視し、期限超過後のinputを拒否します。relayはsourceをpauseし、利用者の明示resumeでAuthorityのfresh acquireから再開します。roomの90分上限はprovider接続の寿命保証ではありません。期限をまたぐ無停止のsession更新は未実装で、約60分時点の停止・再開を実機受入に含めます。

`packages/relay-core` は同じ `roomId + roomEpoch` の状態変更をsingle-writerで直列化し、検証済みclient操作の待ちを接続ごとに32件へ制限します。全server eventは接続単位の `deliveryId` を持ち、未ACKを実wire bytes 512 KiB/128 event以内に保ちます。Authorityへの定常的なusage報告、5秒ごとのpresence同期、lease renewはserial境界の外でsingle-flight実行し、結果だけを同じ境界へ戻します。commit時にroom、admission、generation、provider token、leaseと期限を再照合するため、停止・再接続・revocation・破棄後の遅い応答は新sourceを停止・再開しません。

usageはleaseごとにpendingとin-flight snapshotを分離します。報告中の新規音声はpendingへ継続加算され、成功応答を得たsnapshotだけを確定します。usage reportとrenewはそれぞれsingle-flightで並行でき、stop時はその時点まで、別IDへのrenew時は旧leaseへ到着した分までを、閾値未満でもlease ID別にfinal drainします。このためAuthorityは、renewで新IDをgrantした後も、旧leaseで予約済みのusageを旧ID付きで受理する契約です。同一lease IDで更新されても累積使用量とpacingを初期化しません。Authorityのusage APIは加算型でidempotency keyを持たないためexact-onceは保証しません。失敗・timeoutとなったin-flight snapshotは、Authority側で加算済みか不明な結果不明snapshotとして再送せず、そのlease IDをquarantineします。明示 `capture.resume` 後もfresh Authorityが同じlease IDを返した場合はfail closedを維持し、新しいlease IDでのみ再開します。leaseは最大15秒、`maxInputAudioMs`、200 ms token-bucket burstを強制します。rateの経過時間はclient申告時刻ではなくrelayが検証済みmessageを受信した時刻で計算し、actor内待機をburstと誤認せず、実際の同時audio floodは拒否します。client pingの15秒timeoutもserver clockで判定します。

`ios` はSwift Packageです。`TranslateSession` がhost注入config、明示同意、OS permission、WebSocket、route、capture、話者generation別playback、2分・最大100件のcaption memoryを結線します。字幕deltaは同じspeaker/generation/language/captionOnlyかつ2秒以内なら空白を足さずに4,096文字まで結合します。readinessはtransport、検証済みidentity、同意、マイク許可が揃って初めて1回送ります。マイクmuteと翻訳再生は独立です。接続試行は約15秒で打ち切り、接続後は従来の5秒間隔`client.ping`に加えてNative WebSocket pingをsingle-flightで送り、pongを最大約10秒待ちます。これらの期限はDispatchの単調deadlineで扱い、timeout、queue上限、send/receive失敗は同じcleanupでtimer・in-flight・queueを破棄します。watchdogが確認するのはtransportの生存だけで、翻訳成功を示しません。

`TranslateSession.leave()` は冪等なterminal操作です。退出後のsocket、permission、audio、send完了はlifecycle fenceで破棄し、消費済みscoped ticketを同じSessionから再試行しません。通信復帰はホスト側がfresh scoped ticketで新しい`TranslateSession`を生成する操作です。route喪失またはinterruptionではcapture/playbackを停止してmute/listening pauseを保持し、private input/outputを再検証する利用者の明示操作だけが再開できます。

翻訳PCM再生はCoreの`PlaybackScheduler`が未再生（queued + scheduled）を2段の上限で扱い、そのうち最大19,200 bytes（0.4秒）を先行予約します。`AVAudioPlayerNode`の`.dataConsumed`で予約枠を補充するため、100 ms片ごとに`.dataPlayedBack`を待たず、前片の再生終了前に次片をscheduleできます。未再生がsoft上限（既定96,000 bytes = 2.0秒）を超えると`PLAYBACK_BACKPRESSURE_SOFT`を区間ごとに1回だけ観測イベントとして出し、拒否も破棄もせず再生を続けます。区間は未再生がsoft上限の半分以下へ戻ると終わります。新しい片でhard上限（既定240,000 bytes = 5.0秒）を超える場合は、まだ予約していない片のうち完全無音（全ゼロ）の片を古い順に捨て、足りなければ新しい片が完全無音ならそれを捨て、それでも足りなければ最も古い片を捨てます。捨てた量を無音/音声に分けて`PLAYBACK_BACKPRESSURE_DROP`を出し、再生を続けます。overflowはterminal停止にしません。予約済み・再生中の片、再生速度、片の結合・分割・並べ替え、providerの完全無音200 ms上限、PCM変換とAVAudioの経路は変えません。上限は`TranslateConnectionConfig.playbackQueueLimits`で変更できます（softは0.4秒以上、hardはsoft以上・0.8秒以上・10秒以下）。既定値は、2026-10-28のoffline比較で現行providerが発話の切れ目で約5秒分の訳音声を2秒以内に届け、理想再生queueが3.3秒に達した例をdropなしで受けるための仮の値です。iPhone実機では未検証で、実機計測で見直します。上限を上げて遅延を隠すことはしません。

AudioEngineは観測イベントをplayback generation付きでSessionへ渡し、SessionはMainActor上でlifecycleとgenerationを再検証して、現行generationのものだけを`playbackPressure`へ反映します。`errorCode`と接続状態は変えません。`playbackDiagnostics()`は本文・音声・識別子を含まないcounters（現在と最大の深さのbyte/ms、受け取った量、soft超過の区間数と超過中に再生した累計ms、drop回数と無音/音声別のchunk・byte・ms、queueが空になったunderflow回数）を返し、countersはgeneration更新と退出の後も保持します。underflowには訳音声の自然な終わりも含みます。pause、exit、private route喪失、stopはqueueと予約を破棄してgenerationを更新し、旧generation/tokenのcompletionと観測callbackは現Sessionを変更しません。Bluetooth HFP・有線headsetのprivate route制約とiOS 15.5互換を維持します。

## Latencyの測定区間

次の値は混ぜずに別々に記録します。

- 初回接続・準備時間: 明示開始操作から、両端末のidentity、ready、private route、lease、provider設定が揃い最初の入力を受けられるまで。
- 翻訳音声latency: 意味の対応する原文区間の発話時点から、受信側イヤフォンでその対応音声を実際に聞ける時点まで。relay/providerのaudio first byteは補助時刻であり、耳に届いた時点の代用にしません。
- 字幕latency: 同じ原文区間から、意味の対応する字幕が受信画面に描画されるまで。
- 発話終了後の残り再生: 原文発話終了から、その発話に対応する翻訳音声全体（終了後に生成・受信される分を含む）をイヤフォンで聞き終わるまで。
- 遅れの蓄積: 60分の連続運転で、上記の音声latencyと残り再生が時間とともに増加するか。

中央値2秒・P95 4秒は低遅延化の**仮の最適化目標**です。達成済み、公式保証、または既存の「実機で10秒以内」という公開前DoDの置換を意味しません。端末時計を同期していないclient `Date.now()`とrelay `Date.now()`の単純減算は測定値にしません。

## Room placement

同じ `roomId + roomEpoch` は、必ず同じsingle-writer actorへrouteしてください。reference registryは単一process専用です。Cloudflare例は検証済みclaimsからDurable Object IDを導出し、DO内でもJWTとIDを再検証します。v1の2席、admit、generation、control、lease停止、provider callbackを同じ直列境界へ入れます。

ended tombstoneはroom最大寿命90分 + ticket最大TTL 60秒以上保持します。TTL後もprivate Authorityがended epochを正本として拒否する必要があります。同一epochを再作成してはいけません。新しい会話は新しいepochにします。

## 推定値

- clientの `atMs` は表示・診断用で、relayの `Date.now()` と比較しません。
- speech boundaryは端末energyによる推定で、話者identityやcontent alignmentを保証しません。
- latencyは `unknown` または `estimated` だけです。
- provider final eventやprovider発話境界へ依存しません。
- SDKは実会話の音声・字幕を保存しません。性能評価には合成音声または利用承認済み評価素材だけを使います。
- provider単体の実API音声・字幕受信は確認済みです。room全体、iPhone実機10秒受入、仮目標（中央値2秒・P95 4秒）の達成確認は未完了です。
