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

protocol v1は全server eventに接続単位で単調増加する `deliveryId` を付け、clientはdecode直後に `client.ack` を返します。relayは未ACKのwire bytesを512 KiB、event数を128に制限し、clientからのserial処理待ちは接続ごとに32件へ制限します。上限超過、未来のACK、ACKしないlistenerはfail closedで切断します。初回の認証失敗だけは `deliveryId` のないerrorを許容します。

- [アーキテクチャ](docs/architecture.md)
- [統合手順とAuthority契約](docs/integration.md)
- [セキュリティ](docs/security.md)
- [受入項目](docs/acceptance.md)

## 未完了の受入

実OpenAI APIによる音声成功、5秒間隔の空の部分 `session.update` が実APIで無害であること、iPhone実機10秒受入は未完了です。自動テストはfake transport、protocol、room/relay lifecycle、Swift coreとiOS 15.5 compileを対象にし、実API・実機成功の代用にはしません。

## 権利

Copyright © 2026 NIHO. All rights reserved.

ソースコードの公開は、一般的な再利用・改変・再配布の許諾を意味しません。このリポジトリ独自のコードにOSSライセンスは付与していません。依存ライブラリの権利・ライセンスはそれぞれの権利者に従います。
