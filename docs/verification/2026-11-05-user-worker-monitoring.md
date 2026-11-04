# OPS-002 利用者Workerの監視検証（2026-11-05 JST）

対象: [OPS-002 #12](https://github.com/twitter-studio/notification-worker/issues/12)、実装 [PR #14](https://github.com/twitter-studio/notification-worker/pull/14)。以下の時刻はUTC。

## 承認と範囲

オーナーが、既存 `notification-worker` の更新、既存Queueの5分Cron監視、対象Workerだけの警報1本と承認済み宛先へのテストメール1件、成功した構成の保持を承認した。今回のCLI配置はGitHub Environment経由規則への例外。自動HTTP検証は最大100要求・2時間以内。新しいDB・Queue・秘密・権限、プラン変更、X API・購読・投稿、APNs送信は含めない。

失敗時は今回の警報とCronを削除し、直前の無効構成へ復帰する。直前のWorker設定・Cron・稼働版をMacの保護ファイルへ保存した。秘密や個人情報をこの記録へ写していない。

## 配置前

- 実装のmain: `327ce7766a10c402201e2b3da0eace3015212819`。ローカル変更なしを確認して配置した。
- 直前の稼働版: `0c240696-7da6-424c-8b37-ab8cb3cd832e`。Cronなし、X/mock入口とも無効。
- Workersの `usage_model: standard` は変更しない。既存の秘密3つとvarsを維持した。
- Cloudflareの利用可能なalert typesに `custom_analytics` / `sql_api` を確認。既存custom monitorは4本。同名の利用者Worker用警報はなかった。
- 公式料金表はWorkersの要求・CPU・ログ課金、Queuesのメッセージ操作課金を確認した。追加のCronは1日288回。新しいメッセージを送らず、管理トークンをWorkerに入れない。既存使用量による従量課金の可能性は承認に含む。請求情報APIは既存権限では403だったため、権限を増やさず、請求総額や残枠を取得済みとは扱わない。代わりに同じアカウントのGraphQL Analyticsで11月1日以降を集計し、339要求・CPU合計2,856,547μsを確認した。これは概数で、請求台帳ではない。

## 配置後

14:59:18に版 `95ef5c05-28bd-49d8-bb35-7652077b0ebd` を配置した。

| 確認             | 結果                                                             |
| ---------------- | ---------------------------------------------------------------- |
| Cron             | `*/5 * * * *` が1つ登録された                                    |
| Queue            | backlog count 0、bytes 0                                         |
| 秘密             | 既存3つを維持                                                    |
| `/health`        | 200                                                              |
| `/webhooks/x`    | 404                                                              |
| `/webhooks/mock` | 404                                                              |
| observability    | query redaction有効、sampling 1、invocation logs無効、traces無効 |

警報はまず無効で作成し、初回heartbeatの確認前には有効化しない。SQLはアカウント・Worker・eventで対象を限定する。滞留15分・年齢不明・保存/中継/metricsの失敗・破棄のattention、10分間のheartbeat欠落を検知する。評価間隔5分、再通知間隔1時間。

## Cron・警報の確認

15:11:27までにSQL集計へ `queue_state` のheartbeatが現れ、heartbeat 1、attention 0、backlog 0を確認した。集計値はsampling等による概数として扱う。警報と同じSQLは `value: 0`（正常）を返した。

警報「Tweetbot user worker critical」を有効にし、SQL・閾値・窓・通知先が準備した構成と一致することをAPIで確認した。評価間隔5分、窓10分、再通知1時間。15:12:57までに承認されたテスト送信1件のAPIが成功した。その後、オーナーが当該メールの受信を確認した。送信履歴APIは直後の取得では該当0件だったため、履歴への記録まで確認したとは扱わない。追加送信は行っていない。

最終の稼働版・Cron・入口無効を再確認した。既存の警報5本は削除・変更なし、新しい警報は今回の1本だけ。今後の配置でCronを失わないよう、Macの保護した配置設定にも検証済みの構成を反映し、元の設定を別名で保存した。

## 未確認

テストメールは本人が受信を確認したが、実障害の注入による自動警報は試していない。今回の成功を、X配信・APNs到達・障害時の実警報・productionのリリースゲートの成功として扱わない。元の未特定通知も [QA-002 #11](https://github.com/twitter-studio/notification-worker/issues/11) で未確定を維持する。

## 参照

- [Workersの料金](https://developers.cloudflare.com/workers/platform/pricing/)
- [Queuesの料金](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cronの反映には最大15分かかる](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [MonitorsのSQLとsampling](https://developers.cloudflare.com/notifications/monitors/)
