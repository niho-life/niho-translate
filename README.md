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

## 未完了の受入

provider単体では実OpenAI APIから日英両方向の訳音声・字幕を受信しました。合成音声の時刻・金額・否定は初回両方向で一致し、繰り返しの1回では金額の自動判定が不一致でした。意味精度の人による確認、実iPhone・ホスト認可/予算を含むroom全体、5秒間隔の空の部分 `session.update` が実APIで無害であること、iPhone実機10秒受入は未完了です。自動テストはfake transport、protocol、room/relay lifecycle、Swift coreとiOS 15.5 compileを対象にし、実API・実機成功の代用にはしません。

## 権利

Copyright © 2026 NIHO. All rights reserved.

ソースコードの公開は、一般的な再利用・改変・再配布の許諾を意味しません。このリポジトリ独自のコードにOSSライセンスは付与していません。依存ライブラリの権利・ライセンスはそれぞれの権利者に従います。
