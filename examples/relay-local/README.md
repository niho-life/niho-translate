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

この構成の実環境配備、NIHOの接続先変更、2台・イヤフォン・60分の受入は別作業です。sourceの存在やprovider単体の実API試験だけで製品合格とは扱いません。
