# セキュリティ要点

同じ有効leaseが再発行されても、capture pause/resumeで音声消費量やpacingをリセットしません。接続内の短命な台帳を期限で回収し、source/providerの再作成と予算枠を分離します。

- room/participant IDは仮名にし、音声、字幕、private credential、本人情報をファイル、DB、通常ログ、crash reportへ保存しません。字幕はmemory内で最大2分・4,096 deltaです。
- ticket署名algはserver configの `EdDSA`/`RS256` allowlistに固定し、issuer、audience、期限、not-before、room scopeを検証します。ticket残存時間は最大60秒、jti cacheはroom数/件数をboundedにします。
- restart跨ぎreplayはprivate Authorityのdurable jti consumeで拒否します。memory cacheだけを正本にしません。
- Authorityだけがrole、固定language pair、admission、room state、budgetを決定します。すべての呼出しはtimeout・response size・runtime shapeを検証します。
- v1はhost 1席 + guest 1席です。2分の予約席により別guestの無断入替を防ぎ、同一participant再接続だけgenerationを進めます。第3参加者はcore/relayの両方で拒否します。
- room操作とprovider callbackを含む全イベントをroom単位で直列化します。source停止はprovider tokenを先に無効化し、close drainや旧providerのlate audio/captionを捨てます。
- client入力はruntime schema検証後にだけserial queueへ入れ、接続ごとの処理待ちを32件に制限します。超過時は同期的に後続入力を停止してpeerを閉じ、受理済み処理をdrainしてproviderをcleanupします。`client.ack` とpingはserial media queueへ積みません。
- relay出力は全media/non-media eventを接続単位の `deliveryId` で数え、未ACKの実wire bytesを512 KiB、event数を128に制限します。未来のACKは接続を閉じ、old/duplicate ACKでは新しいeventを解放しません。Nodeはnative `bufferedAmount` にもhard capを置き、値を観測できないCloudflareではdelivery ACKを送信境界にします。
- hostの明示start前とopposite-language listener不在時はcapture不可です。Authorityはdurableなserver clockのpresenceからhost不在30秒でpause、2分でend、room作成後90分でendを判定します。socket closeとclient時計は正本にせず、ended tombstoneは91分以上保持して同一epochを復活させません。
- leaseは最大15秒、音声量上限、200 ms burst、wall-clock rateを強制します。usageはlease単位でaggregateし、失敗後は明示resumeまで再取得しません。
- clientのepoch timestampをserver clockと比較しません。speech boundaryは推定表示にだけ使い、v1の配信をenergy/focusで遮断しません。10秒目標は実機で測定し、遅着音声の破棄で達成扱いにしません。
- client/provider JSON size、field、enum、base64 canonical encoding、PCM alignmentを検証します。provider未知media、binary、過大JSON、backpressureはsession停止です。未知non-media controlだけをboundedに無視します。
- provider transportの `bufferedAmount` は有限・非負の観測値を必須とし、192,000 bytes超過を停止します。未観測を0と扱わず、現在のCloudflare provider transportは実通訳に使えません。Nodeはnative ping/pongを5秒間隔・5秒期限で照合します。古い/別payloadのpongは期限を延長しません。接続確認のための `session.update` は翻訳を途切れさせるため廃止しました。APIの `elapsed_ms` は音声やinputの配送ACKではなく、無音中のliveness判定にも使いません。
- OpenAI keyはrelayだけに置き、固定の `wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate`、またはrelay設定 `TRANSLATE_PROVIDER=live` 時の固定 `wss://api.openai.com/v1/live/sessions` 以外へ接続せず、接続先をclient入力で選びません。
- local mockだけが無資格で動作し、loopback以外へbindしません。標準tokenは `host-ja` と `guest-en` です。

reference memory registryは単一process専用です。本番の複数process構成は同一 `roomId + roomEpoch` のsingle-writer routingを保証してください。
