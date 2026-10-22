# NIHO Translate 作業ルール

- オーナー向け報告、仕様、Issue、PRは日本語。利用者の画面は日本語と英語。
- このリポジトリは公開。実データ、会話音声・字幕、利用者の本人情報、秘密鍵、内部資格情報、非公開リポのソース・履歴を持ち込まない。
- 合成fixtureと秘密なしのGitHub-hosted CIを使う。外部PRを資格情報付きで実行せず、社内runnerへ接続しない。
- 独自コードの再利用許諾は付けない。勝手にOSSライセンスを追加しない。依存ライブラリの権利表示を維持する。
- 認可と予算の正本はホスト側。クライアントのrole、participant ID、残額の申告を信用せず、短命でscopeされた資格とleaseを検証する。
- 最大4人、初期は日英とiPhone。話者別の音声を保ち、必要な聞き手だけに翻訳を共有する。
- 音声・字幕をファイル、DB、ログ、crash reportへ保存しない。退出と世代更新後の遅着イベントを破棄する。
- 実装担当はimplementation-routingに従う。writerは1体、workerの再委任・commit・push・PRは禁止。メインがレビュー・検証・外部操作を担う。
- GitHub CLIはghNを使い、gh auth switchは使わない。ownerが指定した作成アカウントを別アカウントで代用しない。
- npmはpackage.jsonを確認しnpm -C <dir>で実行。Pythonはpython3を使う。対象限定の検証を行い、実機未検証を成功と報告しない。
