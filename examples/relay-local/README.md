# Node relay（v1の実通訳経路）

mockとreal modeを持つ、単一processのreference relayです。Node 24以上で、リポジトリrootで依存をinstallしてから起動します。

```sh
npm -C examples/relay-local start
```

既定はmock、`127.0.0.1:8787`だけにbindします。無資格のmockを外部へ公開しないでください。

## Real mode

配備側が次の環境変数を秘密管理からprocessへ渡します。秘密をファイル・引数・ログに残さないでください。

- `RELAY_MODE=real`
- `AUTHORITY_URL`（HTTPS）、`RELAY_SERVICE_TOKEN`
- `TICKET_ISSUER`、`AUDIENCE`、`JWKS_URL`、`TICKET_ALGORITHM`（EdDSAまたはRS256）
- `OPENAI_API_KEY`
- 任意の`PORT`（既定8787）

real modeもloopbackへbindします。TLS終端proxyを前に置き、iPhoneの固定WSS URLから同じprocessへrouteします。ホストはscoped ticketの発行・認可・費用leaseを保持し、OpenAI keyを端末へ渡しません。room registryはmemory上の単一process専用です。水平分散・再起動復帰にはroom placementとprivate Authorityの永続境界が別途必要です。

providerの送信量はnative `bufferedAmount`で上限を検証します。native ping/pongは5秒間隔・5秒期限で固有payloadを照合し、無音中も翻訳設定を変えません。音声・字幕・APIレスポンス本文をログへ出しません。

providerの既定はGPT-Live（`gpt-live-1`、固定の`wss://api.openai.com/v1/live/sessions`、`packages/provider-openai-live`）です（2026-10-29の[比較評価](../../docs/translation-quality-eval-2026-10-28.md)で確定）。`TRANSLATE_PROVIDER=translate`で現行の`gpt-realtime-translate`（`packages/provider-openai`）へ戻せます。`TRANSLATE_LIVE_PRESET`（`plain`・`plain-q`〔既定〕・`domain-glossary`・`domain-glossary-q`）と`TRANSLATE_LIVE_VOICE`（既定`marin`）は起動時に検証します。GPT-Liveは無音も含む連続音声を100 ms単位で返します。現行と同じく完全無音だけを短縮し（最初の発声前は捨て、以降は200 msまで）、低レベルの非ゼロ音は削らずに配信します。原文字幕（`session.input_transcript.delta`）は止める設定がなく常に届き、relayの現行契約どおり話者本人へsource言語の`caption.delta`として送られます。費用の公示は$0.05/分（translateは$0.034/分）で、予算の正本はホスト側leaseです。製品adapterで確認済みなのはfake transportの自動テストと合成音声1回の実API smokeまでです。同じAPI・同じ指示文の研究ハーネスでは60分連続運転と主要5窓の品質判定を済ませましたが、2台・イヤフォン・60分の実機受入は未完了です。

この構成の実環境配備、NIHOの接続先変更、2台・イヤフォン・60分の受入は別作業です。sourceの存在やprovider単体の実API試験だけで製品合格とは扱いません。
