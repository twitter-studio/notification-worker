# 利用者WorkerをEnvironment経由で更新する

通常配置の定義は `.github/workflows/deploy-sandbox.yml`。対象は停止中の既存sandboxだけで、既定では配置できない。GitHub Environmentの保護、限定token、有効化の承認が必要。

[Environment設定と通常配置・D1 migration](https://github.com/twitter-studio/notification-docs/blob/main/docs/operations/deployment.md) に、変数名・権限・承認・確認文字列・実行順をまとめている。[障害・鍵更新・削除](https://github.com/twitter-studio/notification-docs/blob/main/docs/operations/recovery.md) と [ADR-0003](https://github.com/twitter-studio/notification-docs/blob/main/docs/adr/0003-protected-sandbox-deployment.md) も参照する。

現在のFree・非公開repoでは必要な承認ルールを満たせず、実Environment・secret・有効化は未設定。コードのマージを、配置承認や保護設定完了と扱わない。実際の有効化と配置確認は [OPS-003](https://github.com/twitter-studio/notification-docs/issues/11) で追跡する。

Workflowは本人単独reviewer、main限定、同じSHAのCI成功、当該runの本人承認履歴を確認し、異なるrun attemptは拒否する。Wranglerの生ログを公開せず、失敗時は実際の設定・稼働版・DBを別に確認する。自動rollbackやリソース作成・秘密登録は行わない。
