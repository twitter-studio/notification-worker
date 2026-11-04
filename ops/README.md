# 利用者Workerの監視を設定する

対象は `notification-worker` とその `X_EVENTS` Queue。運営の `notification-service` の監視とは別に設定する。Workerは5分ごとにQueue bindingの `metrics()` を呼び、管理APIトークンを持たずに滞留数・bytes・最古の年齢を記録する。Xの入口が無効でも監視は動く。

## 配置と警報の有効化

1. コードをレビュー・検証し、対象Cloudflareアカウントへの配置承認を得る。`wrangler.example.jsonc` の `triggers` と `observability` も配置構成へ反映する。ローカルの `wrangler.jsonc` は自動更新されない。
2. 配置後、Cronの登録と10分以内の `x_worker_observation` / `stage: queue_state` を確認する。最初のheartbeatを確認する前に警報を有効化すると、監視未起動として警報が出る。
3. `worker-monitor.json` を作業用ファイルへコピーする。`ACCOUNT_ID` を32桁の対象アカウントID、`WORKER_NAME` を自分のWorker名、`ALERT_EMAIL` を承認した受信先へ置き換える。SQL文字列に引用符などを含む値を入れず、クエリの対象が自分のWorkerだけであることを確認する。
4. Cloudflareの Alerts → Monitors でSQLを検証する。APIを使う場合は対象アカウントに限定した Notifications Edit と Account Analytics Read の資格情報を使う。資格情報をWorkerへ保存しない。利用可能なデータセット・監視枠・料金を確認し、プラン変更や枠超過が必要なら止める。
5. 検証結果と通知先を確認して `enabled` を有効にし、警報を登録する。テスト警報の受信も本人に確認する。テンプレートは安全のため無効で保存している。このリポジトリのテストやbuildでは警報の登録・送信をしない。

テンプレートは5分間隔で直近10分を調べ、次のいずれかで1を返す。閾値は1以上、通知間隔は1時間。

| 条件                                                          | 記録                                             |
| ------------------------------------------------------------- | ------------------------------------------------ |
| heartbeatが10分間ない                                         | `heartbeat_count` の合計が0、または対象ログが0件 |
| 滞留が15分以上、または滞留があるのに年齢不明                  | `queue_state` の `attention_count: 1`            |
| metrics取得失敗・10秒の時間切れ                               | `metrics_unavailable`                            |
| 中継結果がaccepted/duplicate以外                              | `delivery` の `attention_count: 1`               |
| Queue保存失敗、再送上限・期限切れ・無効化・宛先変更による破棄 | `enqueue_failed` / `discarded`                   |

件数またはbytesが正なら滞留ありと判定する。15分は初期の運用閾値で、配送時間の保証ではない。Cloudflareのmetricsは概数であり、Cron・ログ取り込み・警報評価にも遅延がある。意図した停止に伴う破棄も警報対象なので、停止期間は対象の警報をミュートする。X購読が存在するか、APNsが実機へ表示されたかは、この監視だけでは分からない。

## 種類別の件数を調べる

ログは固定のstage・結果名・理由名と数値だけを持つ。投稿ID、X利用者ID、本文、event ID、relay binding、資格情報、応答本文は記録しない。URLのクエリを伏せ、invocation logsとtracesを無効にする設定も配置に含める。プラットフォームが持つメタデータ全体の匿名性を保証するものではない。

SQL APIで、自分のアカウントとWorkerに限定して集計する。時刻範囲は検証の開始・終了に合わせる。

```sql
SELECT attributes['stage'] AS stage,
       attributes['outcome'] AS outcome,
       SUM(attributes['mention_count']) AS mention_count,
       SUM(attributes['reply_count']) AS reply_count,
       SUM(attributes['accepted_count']) AS accepted_count,
       SUM(attributes['duplicate_count']) AS duplicate_count
FROM logs.workersLogs
WHERE accountTag = 'ACCOUNT_ID'
  AND scriptName = 'WORKER_NAME'
  AND timestamp >= NOW() - INTERVAL '30' MINUTE
  AND attributes['event'] = 'x_worker_observation'
GROUP BY attributes['stage'], attributes['outcome']
LIMIT 30
```

受信保存は `enqueued`、中継結果は `delivery` と分けて読む。種類のカウントは各stageの処理回数で、受信の再送やQueue再試行でも増える。stageを合算して通知数と扱わない。SQL APIはadaptive samplingの重みをCOUNT/SUMへ適用するため、これも厳密な配送台帳ではない。再送上限の破棄は `discarded` の理由を集計する。

同じ投稿がmentionとreplyの両イベントになれば、現在の重複除去キーは種類を含むため別イベントになる。同じ種類・同じ投稿の再送は同じキーになる。この振る舞いは合成テストで確認する。最小限の集計には投稿の相関情報を残さないため、同じ投稿の重なりをログだけで証明できない。

元の実機試験の未特定の1件は、[QA-002 #11](https://github.com/twitter-studio/notification-worker/issues/11) で追跡する。今回の集計を過去の通知へ遡って適用することはできず、重複・いいね等とは断定しない。新しい実X試験は、API・配信イベント数・費用・購読期限・解除・本人の投稿とタップを別途承認してから行う。

## 未実施のゲート

警報SQLは、対象アカウント・Workerに限定した読み取り専用の実SQL APIでHTTP 200、value=1（新しいheartbeatなし）を確認した。新しいログがある場合の集計は未確認。この実装では実環境への配置、Cron起動、警報登録・メール到達、新しいX購読・投稿は行っていない。運営側の既存監視の成功を、利用者側の監視成功として扱わない。

## 公式資料（2026-11-04確認）

- [Queueのmetricsと概数の制約](https://developers.cloudflare.com/queues/observability/metrics/)
- [Queue bindingのJavaScript API](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
- [Cloudflare MonitorsのSQLとsampling](https://developers.cloudflare.com/notifications/monitors/)
