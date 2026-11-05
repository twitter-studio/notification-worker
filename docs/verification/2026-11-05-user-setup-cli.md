# USER-003: 初回セットアップCLIの実接続と停止

対象: [USER-003 #20](https://github.com/twitter-studio/notification-worker/issues/20)。実装は [PR #19](https://github.com/twitter-studio/notification-worker/pull/19)、実行したソースは `3af479797dc627e306cc198217bc94b63c36aa0f`。2026-11-05、所有者の範囲承認後に既存sandboxで実施した。

## 承認と前提

既存のTweetbot Studio・認可した本人・利用者Worker・Queue・Webhookに限定した。新しいリソース・秘密の発行・権限・プラン変更、追加購入、自動チャージ、投稿、合成イベント送信は行っていない。本人tokenは同じ `tweet.read users.read` で取り直し、Macの今回用0700ディレクトリへ0600で保存した。従来のtokenファイルを上書きしていない。

料金ページは再読み込み後も空白だったため、所有者が別画面で残高9.97USD・請求サイクル上限1USD・自動チャージOFFを確認した。CLIも購読前に残高1USD以上を確認した。この記録は料金設定と接続試験の確認であり、実際の請求額を確定するものではない。

今回に限るCLI配置の例外は、既存Workerの一時有効化と無効への復帰を含む。配置前に対象アカウント、Worker、ソースHEAD、作業ツリー、送り先、本人、Queue、Cron、公開fetch、preview無効と既存構成の一致を確認した。実行用の補助スクリプトは独立コード・セキュリティレビューを受けた。復帰前の記録保存失敗で無効化を省略しないよう修正し、再レビューで指摘なしを確認してから実行した。

## 実行結果

開始は10:38（日本時間）。作成した購読の期限は11:08だったが、作成確認後に早期終了し、不在確認まで完了した。

| 確認          | 結果                                                                 |
| ------------- | -------------------------------------------------------------------- |
| plan          | 通信0、実操作なし                                                    |
| OAuth         | token交換1要求、最小scope、Client IDを含む保存成功                   |
| 本人確認      | IDとユーザー名が設定と一致                                           |
| 既存Webhook   | ID・URL・CRC有効状態が設定と一致                                     |
| 購読作成前    | 対象本人の購読なし、ページ続きなし                                   |
| 購読作成      | mention/reply各1つ、今回のtag・本人・Webhook・30分期限を照合         |
| 早期終了      | CLIのreadyを受けてSIGINT。2購読を削除し、一覧で不在確認              |
| CLI台帳       | finished / cleaned、削除済み2、累積12要求                            |
| 実X APIの合計 | OAuth交換1 + CLI12 = 13要求（承認上限21以内）                        |
| Worker復帰    | X/mockの設定false、health200、XのGET/POST・mockのPOSTとも404         |
| Queue         | 件数0・bytes0                                                        |
| 保持設定      | 5分Cron、既存3secretの名前、既存の対象警報1本のenabledを確認         |
| 監視集計      | 試験前15分を含む期間でheartbeat3、attention0。新規enqueuedの記録なし |

有効化・無効化の配置は各1回。直接のCloudflare管理API確認は13要求（全て200）、公開入口確認は5要求（healthと両パスのGET、X/mockのPOST）。Wrangler内部の配置用管理要求はこの13要求の台帳には含めていない。2時間以内に完了した。無効復帰後の稼働版は `678c32b3-edce-4391-ab5e-621f4bb3c50b`（100%）。

実XのGET/POST/DELETEと、期限付き購読を作成してSIGINTで解除する経路を確認した。復帰はrollbackだけに頼らず無効構成を明示して配置し、管理設定と公開入口を照合した。既存の監視・Queue・Webhook・秘密は保持している。

## 実施していないこと

- CRCが無効な場合のPUTによる再検証。今回は既存登録が有効だった。
- 新規投稿による配信とAPNs受理・OS表示・通知タップ。この試験で手動投稿やAPNs送信操作は行っていない。
- 30分経過による自然終了、強制終了・電源断、実API障害、実接続でのrecover。これらの回復ロジックは合成テストの結果と区別する。
- 別利用者の初回Cloudflare配置、GitHub Environmentの配置workflow、無期限の購読、production APNs/App Attest、通常負荷の費用確定。

秘密・本人ID・Webhook ID・購読ID・tag・API応答本文はこの記録に含めない。個別の台帳と資格情報はMacの保護領域に保持する。[セットアップ手順](../../ops/setup.md) と [ADR-0005](../adr/0005-bounded-user-setup.md) を参照。
