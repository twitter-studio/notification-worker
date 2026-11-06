# TweetbotでXの通知を受け取る

Tweetbotの本番通知に、自分のX開発者アプリとCloudflare Workerを接続します。受け取るのは自分宛てのメンションと直接返信です。Xの利用料は自分のXアカウントにかかります。始める前に[Xのイベント料金](https://docs.x.com/x-api/activity/event-pricing)と[Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[Queues](https://developers.cloudflare.com/queues/platform/pricing/)の利用枠と現在の使用量を確認してください。

## 1. iPhoneを登録する

1. Tweetbotの「設定 → プッシュ通知」で、招待コードを空欄にして登録します。iOSの通知を許可し、「配信」がオンになるまで待ちます。
2. 「テスト通知の送信」を1回押します。iPhoneに1件届けば、Tweetbotから運営の中継までの設定は完了です。Xとの接続は手順4で確認します。
3. 登録時の中継資格情報を手元の保護領域に保存します。手順2で自分のWorkerの `RELAY_TOKEN` に使います。すでに表示を閉じていて、値を保存していなければ「中継の資格情報を入れ替える」で再発行します。入れ替えると前の値は無効になります。資格情報はチャットやGitに貼らないでください。

## 2. 自分のWorkerを用意する

[ローカルの準備](setup.md#1-ローカルの準備)に従い、設定例から `wrangler.jsonc` を作ります。Worker名とCloudflareアカウントを自分のものにします。Queue名はproducerとconsumerの両方で `notification-x-events` を使います。後で配置Workflowがこの名前を照合します。この名前を別の用途で使っている場合は、既存Queueを流用せずに作業を止めてください。D1は不要です。Cloudflareの無料プランではQueueの保持期間は24時間固定です。[Queueの上限](https://developers.cloudflare.com/queues/platform/limits/)

| 設定                 | 値                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------- |
| `RELAY_URL`          | `https://notification-service-production.zunda-dev.workers.dev`。パスは付けません。 |
| `X_USER_ID`          | 通知を受け取る本人の数値ID。後で本人のOAuth認可と一致することを照合します。         |
| `ENABLE_X_ACTIVITY`  | 最初は文字列の `"false"`。                                                          |
| `ENABLE_MOCK_EVENTS` | 文字列の `"false"`。                                                                |
| `preview_urls`       | `false`。Xには通常のworkers.dev URLを登録します。                                   |

配置前に、次のコマンドで利用者の設定を使ってビルドします。Cloudflareへの配置は行いません。

```sh
mise exec -- pnpm exec wrangler deploy --config wrangler.jsonc --dry-run
```

自分のアカウントでWorkerを用意し、X入口を無効のまま初回配置します。対象名が既存Workerと重複していないことを確認してください。[保護された配置Workflow](deployment.md)は既存WorkerとQueueの更新用です。使う場合は、自分が管理するリポジトリにEnvironmentを設定します。初回作成にCLIを使う場合は、アカウントの所有者が対象と権限を確認してから、次を実行します。既にこの用途専用のQueueを作成済みなら、最初のコマンドは不要です。

```sh
mise exec -- pnpm exec wrangler queues create notification-x-events --config wrangler.jsonc
mise exec -- pnpm exec wrangler deploy --config wrangler.jsonc
```

[CloudflareのWorker secret](https://developers.cloudflare.com/workers/configuration/secrets/)に、`RELAY_TOKEN`、`X_OAUTH2_CLIENT_SECRET`、署名鍵と独立に生成した `X_EVENT_ID_SECRET` を保存します。初回の無効配置を確認してから、WorkerのSettingsにあるVariables and Secretsで、種類をSecretにして保存します。本人OAuth tokenやApp-only Bearer Tokenは手元の保護領域に置きます。運営へ送る必要はありません。テスト専用の `PUBLIC_RELAY_TRIAL_TOKEN` や期限付きの上書き設定は不要です。

## 3. XのWebhookを登録する

自分のX開発者アプリでRead権限、OAuth 2.0のConfidential client、戻り先 `http://127.0.0.1:8788/callback` を設定します。使用中のアプリを流用する場合は、既存用途や資格情報に影響しないことを先に確認してください。

1. Workerの `/health` が200、X入口と模擬入口が404であることを確認します。
2. `ENABLE_X_ACTIVITY` だけを `"true"` にして承認済みの方法で更新します。XでWebhook URLとして `https://<自分のWorker名>.<自分のサブドメイン>.workers.dev/webhooks/x` を登録し、CRC検証が成功したことを確認します。[XのWebhook登録](https://docs.x.com/x-api/webhooks/create-webhook)
3. [本人認可と設定ファイルの手順](setup.md#3-webhookを登録し本人を認可する)に従って、`tweet.read` と `users.read` で本人を認可します。Webhook IDとURLを `activity-setup.json` に記録します。CLIはOAuth本人IDと設定したID、Webhook IDとURLを照合します。

## 4. 通知の到達を確認する

[購読の作成・延長・解除](setup.md#継続する購読の作成延長解除)の `start` で、メンションと直接返信を購読します。初回は短い期限を選ぶと、検証中の利用時間を区切れます。

別の公開アカウントから本人へのメンションを1件送り、iPhoneに1件表示され、タップで対象の投稿が開くことを確認します。続けて本人の公開投稿へ直接返信を1件送り、同じように確認します。届かないときは、WebhookのCRC、購読件数、WorkerのQueue、iPhoneの「配信」の順に確認します。アプリ内テスト通知だけが届く場合、XからWorkerを経由する経路はまだ確認できていません。

## 停止する

X側の課金につながる配信を止めるには、購読CLIの `stop` で `subscriptions: 0` を確認します。続けてWorkerの `ENABLE_X_ACTIVITY` を `"false"` に戻し、Queueの状態を確認します。iPhoneで通知をオフにするだけでは、Xの購読は解除されません。[購読の停止・資格情報の更新](setup.md#継続する購読の作成延長解除)
