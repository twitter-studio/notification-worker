# TweetbotでXの通知を受け取る

Tweetbotの本番通知に、自分のX開発者アプリとCloudflare Workerを接続します。受け取るのは自分宛てのメンションと直接返信です。Xの利用料は自分のXアカウントにかかります。始める前に[Xのイベント料金](https://docs.x.com/x-api/activity/event-pricing)と[Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[Queues](https://developers.cloudflare.com/queues/platform/pricing/)の利用枠と現在の使用量を確認してください。

## 1. iPhoneを登録する

1. Tweetbotの「設定 → プッシュ通知」で、招待コードを空欄にして登録します。iOSの通知を許可し、「配信」がオンになるまで待ちます。
2. 「テスト通知の送信」を1回押します。iPhoneに1件届けば、Tweetbotから運営の中継までの設定は完了です。Xとの接続は手順4で確認します。
3. 登録時の中継資格情報を手元の保護領域に保存します。手順2で自分のWorkerの `RELAY_TOKEN` に使います。すでに表示を閉じていて、値を保存していなければ「中継の資格情報を入れ替える」で再発行します。入れ替えると前の値は無効になります。資格情報はチャットやGitに貼らないでください。

## 2. 自分のWorkerを用意する

[ローカルの準備](setup.md#1-ローカルの準備)に従い、設定例から `wrangler.jsonc` を作ります。Worker名とCloudflareアカウントを自分のものにします。Queue名はproducerとconsumerの両方でそろえます。保護付き配置Workflowを使う場合は `notification-x-events` にします。既に別の用途で使われている場合、そのQueueを流用しないでください。所有者が初回配置・更新・停止にCLIを使うと承認した場合は、両方の名前を新しい専用Queue名に変えます。別名のQueueは現在の配置Workflowでは更新できません。D1は不要です。Cloudflareの無料プランではQueueの保持期間は24時間固定です。[Queueの上限](https://developers.cloudflare.com/queues/platform/limits/)

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

自分のアカウントでWorkerを用意し、X入口を無効のまま初回配置します。対象名が既存Workerと重複していないことを確認してください。[保護された配置Workflow](deployment.md)は既存WorkerとQueueの更新用です。使う場合は、自分が管理するリポジトリにEnvironmentを設定します。初回作成にCLIを使う場合は、アカウントの所有者が対象と権限を確認してから、次を実行します。下のQueue名は設定ファイルとそろえます。この用途専用のQueueを作成済みなら、最初のコマンドは不要です。

```sh
mise exec -- pnpm exec wrangler queues create notification-x-events --config wrangler.jsonc
mise exec -- pnpm exec wrangler deploy --config wrangler.jsonc
```

[CloudflareのWorker secret](https://developers.cloudflare.com/workers/configuration/secrets/)に、`RELAY_TOKEN`、`X_OAUTH2_CLIENT_SECRET`、署名鍵と独立に生成した `X_EVENT_ID_SECRET` を保存します。初回の無効配置を確認してから、WorkerのSettingsにあるVariables and Secretsで、種類をSecretにして保存します。本人OAuth tokenやApp-only Bearer Tokenは手元の保護領域に置きます。運営へ送る必要はありません。テスト専用の `PUBLIC_RELAY_TRIAL_TOKEN` や期限付きの上書き設定は不要です。

## 3. XのWebhookを登録する

自分のX開発者アプリでRead権限、OAuth 2.0のConfidential client、戻り先 `http://127.0.0.1:8788/callback` を設定します。使用中のアプリを流用する場合は、既存用途や資格情報に影響しないことを先に確認してください。同じアプリに、本人宛てのメンションまたは直接返信の購読がすでにあり、このCLIで管理していない場合は新規購読を開始できません。既存の接続を変えずに、別の専用アプリを用意できるか確認してください。

1. Workerの `/health` が200、X入口と模擬入口が404であることを確認します。
2. `ENABLE_X_ACTIVITY` だけを `"true"` にして承認済みの方法で更新します。XでWebhook URLとして `https://<自分のWorker名>.<自分のサブドメイン>.workers.dev/webhooks/x` を登録し、CRC検証が成功したことを確認します。[XのWebhook登録](https://docs.x.com/x-api/webhooks/create-webhook)
3. [本人認可と設定ファイルの手順](setup.md#3-webhookを登録し本人を認可する)に従って、`tweet.read` と `users.read` で本人を認可します。Webhook IDとURLを `activity-setup.json` に記録します。CLIはOAuth本人IDと設定したID、Webhook IDとURLを照合します。

## 4. 通知の到達を確認する

[購読の作成・延長・解除](setup.md#継続する購読の作成延長解除)の `start` で、メンションと直接返信を購読します。初回は短い期限を選ぶと、検証中の利用時間を区切れます。

別の公開アカウントから本人へのメンションを1件送り、iPhoneに1件表示され、タップで対象の投稿が開くことを確認します。続けて本人の公開投稿へ直接返信を1件送り、同じように確認します。届かないときは、WebhookのCRC、購読件数、WorkerのQueue、iPhoneの「配信」の順に確認します。アプリ内テスト通知だけが届く場合、XからWorkerを経由する経路はまだ確認できていません。

## 複数の X アカウントや端末に届ける

配送先 ID に対応する本番通知 API と Tweetbot が使えるようになってから設定します。通知の受信先として使う iPhone と iPad を、それぞれ手順1で登録します。各端末で対象の X アカウントに切り替え、プッシュ通知の設定に表示される配送先 ID と、その端末の中継資格情報を控えます。配送先 ID はアプリ内の X アカウントと端末の組み合わせを識別します。

Cloudflare の Worker secret に `X_RELAY_ROUTES` を作り、X ユーザーの数値 ID ごとに端末を配列で並べます。次はアカウント `123` を2台に、アカウント `456` を1台に届ける設定の形です。アプリが表示した ID と資格情報でプレースホルダーを置き換えてください。

```json
{
  "123": [
    { "relay_token": "<iPhoneの資格情報>", "route_id": "<iPhoneで123に表示された配送先ID>" },
    { "relay_token": "<iPadの資格情報>", "route_id": "<iPadで123に表示された配送先ID>" }
  ],
  "456": [{ "relay_token": "<iPhoneの資格情報>", "route_id": "<iPhoneで456に表示された配送先ID>" }]
}
```

`X_RELAY_ROUTES` がある場合、通常の X 通知はこの一覧から送ります。移行するときは既存アカウントの配送先も一覧に入れてください。上限は8アカウント、1アカウントあたり4台です。配送先 ID は一覧で重複させず、同じ X ユーザーの配列に同じ端末を2回入れないでください。すべての配送先で手順2の `RELAY_URL` を使います。

保護付き配置 Workflow を使う場合は、従来の `X_USER_ID` と `RELAY_TOKEN` も残してください。Workflow は既存の設定を照合します。期限付きの公開中継試験は、試験専用の配送先を使います。

X アカウントごとに別の保護ディレクトリを作ります。各ディレクトリで手順3の本人認可を行い、手順4で購読します。本人のトークン、`activity-setup.json`、購読の記録はそのアカウントのディレクトリに保管します。同じ X アカウントに端末を増やすときは、既存の購読を使います。Webhook は同じ X 開発者アプリのものを使います。X 側の購読数の上限も確認してください。[X の購読上限](https://docs.x.com/x-api/activity/introduction#subscription-limits)

確認時は別の X アカウントをアプリで開いた状態にし、各端末で通知をタップして、対象の X アカウントに切り替わり投稿が開くことを確かめます。

端末を外すには、その端末の配送先を一覧から削除します。端末の中継資格情報を入れ替えた場合は、その端末を指すすべての項目を更新します。X アカウントの通知をすべて止める場合は、そのアカウントの購読を解除します。

複数配送先を設定する前に Queue に入った通知は、同じ X アカウント・中継先 URL・中継資格情報が残っていれば、元の端末に届きます。複数配送先に対応する前の Worker へ戻すときは、先に全 X アカウントの購読を解除し、現在の Worker で Queue を空にしてください。古い Worker は配送先 ID 付きの Queue メッセージを破棄します。

## 停止する

X 側の課金につながる配信を止めるには、購読している X アカウントそれぞれの保護ディレクトリで購読 CLI の `stop` を実行します。すべてのアカウントで `subscriptions: 0` を確認してください。その後に Worker の `ENABLE_X_ACTIVITY` を `"false"` に戻し、Queue の状態を確認します。端末で通知をオフにしても X の購読は続きます。[購読の停止・資格情報の更新](setup.md#継続する購読の作成延長解除)
