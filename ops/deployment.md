# 利用者sandboxを承認付きで更新する

対象は停止中の既存sandbox。`.github/workflows/deploy-sandbox.yml` はmainの手動実行専用で、リソース作成・secret登録・X API操作・productionへの切替は行わない。

## 有効化前の設定

実Environment・限定token・有効化・配置は所有者が対象と費用を確認して承認する。リポジトリを公開しただけでは配置を開始しない。公開前のFree/privateでは必要な保護を使えなかったため、実設定とEnvironment経由の配置検証は未完。

1. `sandbox` Environmentを作る。
2. Required reviewersは承認する本人のUserを1人だけにする。repo variable `DEPLOY_REVIEWER` に同じloginを設定する。mainのbranchルールだけを1件登録し、tagや追加branchを許可しない。
3. 管理者の保護ルールbypassを無効にする。本人が起動と承認を行う場合はPrevent self-reviewをオフにする。実操作前に当該runの本人承認履歴も検査する。
4. repo variable `SANDBOX_DEPLOY_ENABLED` は未設定またはfalseで準備し、保護と資格情報を確認してから所有者が有効化する。秘密はEnvironment secretへだけ保存する。

## Environment variablesと資格情報

| Variable                | 内容                                                |
| ----------------------- | --------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | 承認したアカウントID、32桁hex                       |
| `WORKER_NAME`           | 対象の既存Worker名                                  |
| `CF_WORKER_SUBDOMAIN`   | workers.devのアカウント部分。独自ドメインは対象外   |
| `CF_QUEUE_ID`           | 既存Queueの32桁hex ID。名前とbindingも照合する      |
| `X_USER_ID`             | OAuth認可した本人ID。通常更新で取り替えない         |
| `RELAY_URL`             | 既存の中継APIのhttps origin。通常更新で取り替えない |

Queue名は `notification-x-events`。tokenは対象アカウント・WorkerのEditorと既存Queue consumer更新に必要な権限へ絞る。個別リソースへのscopeが使える場合は限定し、実際の発行画面で確認する。

Cloudflare tokenだけを `CLOUDFLARE_API_TOKEN` というEnvironment secretに保存する。運営と利用者、配置とmigrationで共有しない。APNs鍵・Xの資格情報・中継資格情報・暗号鍵はCloudflare側に保持し、GitHubへ複製しない。権限不足やプラン変更が必要なら止め、勝手に範囲を広げない。

## 通常更新

mainの対象SHAのpush CI成功を待ち、購読解除・送信停止・Queue件数とbytesが0を確認する。purgeで空にしない。mainから手動実行し、`target_sha` に完全SHA、`confirmation` に `deploy:完全SHA` を指定し、保守確認にチェックする。本人が対象SHAと設定・停止範囲を確認してEnvironmentを承認する。

成功時は `sandbox_deployed` と稼働版が出る。Workflowはvars・secret名・binding、稼働版100%、Queue空、Cron、healthを確認する。XのGET/POSTとmockのPOSTは404も確認する。再有効化・購読は別承認の手順で行う。別途、heartbeatと警報の保持を確認する。healthを通知到達の証明にしない。

失敗runのRe-run jobsは拒否する。実際の稼働版・設定・Queueを確認し、新しい手動runと承認で行う。失敗しても未配置とは限らない。自動rollbackはしない。

## 追加の運用資料

詳細な障害・鍵更新・削除の運営用手順は [notification-docs](https://github.com/twitter-studio/notification-docs/blob/main/docs/operations/recovery.md) にある。非公開資料のため、アクセスできる管理者だけが参照する。利用者の接続・停止・鍵更新・削除は、このrepoの [セットアップ手順](setup.md) も参照する。公開コードの提供と、実際の運営サービスの利用登録・公開運用の承認は分ける。

仕様の根拠: [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)、[Cloudflare権限](https://developers.cloudflare.com/workers/authorization/workers/)。
