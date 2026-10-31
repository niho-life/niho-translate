# NIHO Translate SDK

対面の日英通訳をホストアプリへ組み込むための公開SDKです。v1はホスト1名とゲスト1名の2人、iPhone（iOS 15.5+）、24 kHz mono PCM16、話者ごとのprovider接続、相手への翻訳audio/captionを扱います。最大4人・同時発話時の受信言語単位優先と字幕補完はv2の計画です。

ホストアプリがログイン、招待、固定WSS URL、短命scoped ticket、room/participant ID、role、固定のsource/target languageを用意します。SDKはNIHOの非公開APIやログイン処理を含みません。

## Swift Package

リポジトリrootの `Package.swift` をremote Git dependencyとして指定し、`NIHOTranslate` productを追加します。ホスト画面ではadmission済みの値を渡して `TranslateView` を埋め込みます。

```swift
let config = try TranslateConnectionConfig(
    relayURL: URL(string: "wss://relay.example.invalid/translate")!,
    scopedTicket: ticket,
    roomId: roomId,
    participantId: participantId,
    role: .guest,
    sourceLanguage: .en,
    targetLanguage: .ja
)

TranslateView(config: config)
```

source/target languageはroom途中で変更しません。変更時はprivate authorityで再admitし、新しいroom/epochへ接続してください。

`TranslateSession`は接続試行1回に使います。退出、接続失敗、接続後の同意取消後は同じinstanceを再接続せず、ホスト側で新しいscoped ticketとSessionを用意して明示的に入り直します。回線の復帰やイヤフォンの再接続だけでは、マイクを自動再開しません。詳細は[統合手順](docs/integration.md)を確認してください。

## Reference relay

```sh
npm -C . run check
swift test --package-path ios
RELAY_MODE=mock npm -C examples/relay-local start
```

mock relayは `127.0.0.1:8787` だけでlistenします。WebSocketの `Authorization` headerには合成token `host-ja` または `guest-en` を指定します。hostは `client.ready` 後に `room.start` を送る必要があります。ticketをURL queryへ置きません。

reference relayは単一process用です。本番の水平分散では、同じ `roomId + roomEpoch` を必ず同じsingle-writerへrouteしてください。

ローカルだけでaudio byte経路を確認する場合は次を実行します。`--wav` は絶対pathだけを受け付け、最大60秒をffmpegで24 kHz mono PCM16へ変換します。省略時はメモリ上の非音声PCM fixtureを使います。外部APIへ接続せず、入力path・filename・PCM・字幕・音声を保存または表示せず、再生もしません。

```sh
npm --silent -C . run test:wav
npm --silent -C . run test:wav -- --wav /absolute/path/to/local.wav --seconds 10
```

WAV指定時はnpm自身が実行commandへ引数を表示しないよう`--silent`を付けてください。CLI自身の成功・失敗出力にはpathやfilenameを含めません。この検証はfake transportを注入したprovider adapterとreference mock relayのechoを使うため、providerでは無音正規化後の音声一致、relayでは完全byte一致とprotocol/ACKを確認します。providerは最初の発声前の完全無音を除き、発声後の完全無音を最大200msへ制限します。非ゼロsampleを含むchunkは小声も削りません。翻訳の意味精度、実OpenAI API、Swift `AVAudioConverter`、実iPhone、イヤフォンへ届くlatency、実機10秒受入、60分連続運転の成功を示しません。

protocol v1は全server eventに接続単位で単調増加する `deliveryId` を付け、clientはdecode直後に `client.ack` を返します。relayは未ACKのwire bytesを512 KiB、event数を128に制限し、clientからのserial処理待ちは接続ごとに32件へ制限します。上限超過、未来のACK、ACKしないlistenerはfail closedで切断します。初回の認証失敗だけは `deliveryId` のないerrorを許容します。

- [アーキテクチャ](docs/architecture.md)
- [統合手順とAuthority契約](docs/integration.md)
- [セキュリティ](docs/security.md)
- [受入項目](docs/acceptance.md)
- [同時通訳の品質・遅延改善：調査と実装者向け実験仕様](docs/translation-quality-research.md)
- [日英同時通訳 比較評価 2026-10-28（現行 / gpt-live-1 / realtime VAD / cascade）](docs/translation-quality-eval-2026-10-28.md)・[比較評価ハーネス](research/eval/README.md)
- [日英同時通訳の設計に関する研究・製品の調査（2026-10）](docs/simultaneous-interpretation-landscape-2026.md)
- [ネイティブ日本語5分の音声通訳ストレス試験（2026-10-31）](docs/native-japanese-speech-translation-probe-2026-10-31.md)

実通訳のtransportは送信バッファを観測できるNode版relayを使います。現在のCloudflare例は未観測のためprovider設定前に安全停止します。翻訳中の設定更新をheartbeatに使わず、Nodeのnative ping/pongで生存を確認します。詳しくは [Node版の運用条件](examples/relay-local/README.md) を参照してください。

## 未完了の受入

provider単体では実OpenAI APIから日英両方向の訳音声・字幕を受信しました。合成音声の時刻・金額・否定は初回両方向で一致し、繰り返しの1回では金額の自動判定が不一致でした。意味精度の人による確認、実iPhone・ホスト認可/予算を含むroom全体、Node版relayを使うホスト側の配備・接続先更新と実回線watchdog、iPhone実機10秒受入は未完了です。自動テストはfake transport、protocol、room/relay lifecycle、Swift coreとiOS 15.5 compileを対象にし、実API・実機成功の代用にはしません。2026-10-29の比較評価（[評価文書](docs/translation-quality-eval-2026-10-28.md)）で主経路をGPT-Live（`gpt-live-1`・通訳指示`plain-q`・声`marin`）に確定し、Node版relayの既定を`TRANSLATE_PROVIDER=live`にしました。現行の`gpt-realtime-translate`は`TRANSLATE_PROVIDER=translate`で選べます。GPT-Live adapter（`packages/provider-openai-live`）自体はfake transportの自動テストと合成音声1回の実API smoke（訳音声・訳字幕・原文字幕の受信と`session.closed`までのdrain）までで、同じAPI・同じ指示文の研究ハーネスでは60分連続運転と主要5窓の品質判定を済ませましたが、adapterの実iPhone・room全体・60分連続運転は未確認です。

## 権利

Copyright © 2026 NIHO. All rights reserved.

ソースコードの公開は、一般的な再利用・改変・再配布の許諾を意味しません。このリポジトリ独自のコードにOSSライセンスは付与していません。依存ライブラリの権利・ライセンスはそれぞれの権利者に従います。
