# ADR-0003: 利用者Workerの集計とQueue監視

Status: Accepted / 2026-11-04。対象: [OPS-002 #12](https://github.com/twitter-studio/notification-worker/issues/12)、[QA-002 #11](https://github.com/twitter-studio/notification-worker/issues/11)。

## 判断

5分のCronから既存の `X_EVENTS.metrics()` を呼ぶ。管理トークンや新しいDB・Queueを追加せず、滞留数、bytes、最古の年齢を記録する。滞留15分、滞留年齢不明、取得失敗を警報対象とする。監視自体の停止も、直近10分のheartbeat欠落として検知する。

Webhookの保存成功・失敗、Queueの中継結果・破棄を固定の分類と数値で記録する。mention/replyは数として残し、投稿IDやHMACの相関キーは残さない。現在の重複除去方式は変更しない。

警報はCloudflare MonitorsのSQLで1本にまとめる。対象アカウントとWorkerを限定し、受信先・利用枠・権限・費用を確認するまで無効にする。運営側の通知中継の監視とは分ける。

## 採らなかった案

WorkerにCloudflare管理トークンを置く案は、既存bindingだけでmetricsを取得できるため採らない。投稿を識別できるキーをログへ追加する案は、通知の追跡のために不要な個人情報を増やすため採らない。永続的な厳密台帳の新設は今回の障害検知に必要なく、ログ集計を台帳とみなさない。

## 検証と限界

workerd上のQueue bindingと合成データで数値・閾値・失敗・時間切れ・秘密の非出力を確認する。sampling、ログ遅延、Cron遅延のため厳密な配送件数や時間を保証しない。元の未特定通知は未確定のまま、新たな実X試験を別承認とする。実配置・警報・実機のゲートは [手順書](../../ops/README.md) に残す。
