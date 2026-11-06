# TweetbotでXの通知を受け取る

Tweetbotの本番通知に、自分のX開発者アプリとCloudflare Workerを接続します。既定では自分宛てのメンションと直接返信を受け取ります。Xの利用料は自分のXアカウントにかかります。始める前に[Xのイベント料金](https://docs.x.com/x-api/activity/event-pricing)と[Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[Queues](https://developers.cloudflare.com/queues/platform/pricing/)の利用枠と現在の使用量を確認してください。

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

[CloudflareのWorker secret](https://developers.cloudflare.com/workers/configuration/secrets/)に、`RELAY_TOKEN`、`X_OAUTH2_CLIENT_SECRET`、署名鍵と独立に生成した `X_EVENT_ID_SECRET` を保存します。初回の無効配置を確認してから、WorkerのSettingsにあるVariables and Secretsで、種類をSecretにして保存します。本人 OAuth token は手元の保護領域に置きます。App-only Bearer Token は、[通知プレビューの照会](setup.md#通知プレビュー)を使う場合だけ自分の Worker の secret にも保存します。テスト専用の `PUBLIC_RELAY_TRIAL_TOKEN` や期限付きの上書き設定は不要です。

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

プレビュー用の鍵を設定できるアプリを使う場合、各ルートの `dm_preview_key` は端末とアカウントごとに異なる32バイトの乱数を Base64URL（余白なし）で表した値です。鍵は Cloudflare の `X_RELAY_ROUTES` secret にだけ設定し、リポジトリやログに載せません。この鍵を含む JSON 全体が5,000文字を超える場合は、Worker を分けてください。鍵の削除や交換の際は、アプリ側でも古い鍵を削除します。 鍵が無効な形式または複数ルートで重複している場合、そのルートは定型通知を使います。

プレビューを有効にする前に、通知 API が暗号文を受けられる版か確認します。通知 API を旧版へ戻す前に、Worker の設定から全プレビュー鍵を外し、利用者 Worker と APNs 再送の Queue が空になったことを確認します。

保護付き配置 Workflow を使う場合は、従来の `X_USER_ID` と `RELAY_TOKEN` も残してください。Workflow は既存の設定を照合します。期限付きの公開中継試験は、試験専用の配送先を使います。

X アカウントごとに別の保護ディレクトリを作ります。各ディレクトリで手順3の本人認可を行い、手順4で購読します。本人のトークン、`activity-setup.json`、購読の記録はそのアカウントのディレクトリに保管します。同じ X アカウントに端末を増やすときは、既存の購読を使います。Webhook は同じ X 開発者アプリのものを使います。X 側の購読数の上限も確認してください。[X の購読上限](https://docs.x.com/x-api/activity/introduction#subscription-limits)

確認時は別の X アカウントをアプリで開いた状態にし、各端末で通知をタップして、対象の X アカウントに切り替わり投稿が開くことを確かめます。

端末を外すには、その端末の配送先を一覧から削除します。端末の中継資格情報を入れ替えた場合は、その端末を指すすべての項目を更新します。X アカウントの通知をすべて止める場合は、そのアカウントの購読を解除します。

複数配送先を設定する前に Queue に入った通知は、同じ X アカウント・中継先 URL・中継資格情報が残っていれば、元の端末に届きます。複数配送先に対応する前の Worker へ戻すときは、先に全 X アカウントの購読を解除し、現在の Worker で Queue を空にしてください。古い Worker は配送先 ID 付きの Queue メッセージを破棄します。

## 停止する

X 側の課金につながる配信を止めるには、各アカウントで購読 CLI の `stop` を実行してメンションと返信を停止し、手動で追加した種類は購読 ID で削除します。[X の購読一覧](https://docs.x.com/x-api/activity/get-x-activity-subscriptions)で対象 Webhook の購読がすべて消えたことを確認してください。その後に Worker の `ENABLE_X_ACTIVITY` を `"false"` に戻し、Queue の状態を確認します。端末で通知をオフにしても X の購読は続きます。[購読の停止・資格情報の更新](setup.md#継続する購読の作成延長解除)

## 通知の種類を選ぶ

各配送先の `X_RELAY_ROUTES` に `event_types` を指定します。値は `mention`、`reply`、`retweet`、`quote`、`like`、`follow`、`dm` です。省略時は `mention` と `reply` が有効です。空配列でその配送先の全種類がオフになります。設定変更後、Queue に残っていたオフの種類も中継を止めます。たとえば `"event_types": ["mention", "reply", "like", "dm"]` にすると、この4種類を受け取ります。単一配送先の旧形式では `X_NOTIFICATION_TYPES` にカンマ区切りで指定できます。DM にはアカウントを照合できる `X_RELAY_ROUTES` が必要です。

追加のイベントは、X の本人認可後に、既存 Webhook と同じ `webhook_id` へ種類ごとに購読します。既存の購読 CLI はメンション・返信を管理するため、新しい種類の購読は [X Activity API の作成操作](https://docs.x.com/x-api/activity/create-x-activity-subscription) を使い、`filter.user_id` に認可した本人を指定します。

| 通知         | `event_type`                     | 認可とフィルター                                         |
| ------------ | -------------------------------- | -------------------------------------------------------- |
| リツイート   | `post.repost.create`             | `tweet.read`                                             |
| 引用ツイート | `post.quote.create`              | `tweet.read`                                             |
| いいね       | `like.create`                    | `like.read`、`filter.qualifiers.direction` は `inbound`  |
| 新規フォロー | `follow.follow`                  | `tweet.read`、`filter.qualifiers.direction` は `inbound` |
| DM           | `dm.received` と `chat.received` | `dm.read`。従来 DM と暗号化 X Chat の受信を別々に購読    |

`scripts/x-oauth.mjs` の `--likes` と `--dm` で必要な権限だけを追加します。既存の本人認可とは別の保護ディレクトリを使い、本人トークンで `POST /2/activity/subscriptions` に `event_type`、`filter`、`webhook_id` を送ります。受理された購読 ID を控えます。端末配送だけを止める場合は配送先の `event_types` から種類を外します。X からの配信と課金も止めるには、どの配送先でも不要になった購読だけを [購読 ID で削除](https://docs.x.com/x-api/activity/delete-x-activity-subscription)します。

DM は受信を定型文で知らせ、通知をタップすると対象アカウントの受信箱を開きます。本文を端末だけで復号できる経路を用意するまでは、DM の本文や暗号文を APNs に渡しません。[Apple の通知ペイロードのガイド](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CreatingtheNotificationPayload.html)

DM の配送を試す前に、対応する運営 API とアプリに更新します。端末の共有・譲渡や X アカウントの削除時は、該当の配送先を外します。以前の Worker または運営 API へ戻す際は、追加の種類をオフにし、配送待ちが空になったことを確認します。

## Tweetbot から端末をペアリングする

X の Webhook と購読を設定した利用者 Worker に、SQLite の Durable Object を追加します。現在使用している Wrangler 設定に次の項目を足してください。既存の migration がある場合は、末尾に固有のタグで追加します。

```jsonc
"durable_objects": {
  "bindings": [{ "name": "PAIRING_ROUTES", "class_name": "PairingStore" }]
},
"migrations": [{ "tag": "pairing-v1", "new_sqlite_classes": ["PairingStore"] }]
```

新規のストレージを作成する配置は、Worker 所有者が対象と利用条件を確認し、承認した配置手順で実行します。既存の sandbox Workflow はこの新規リソースの初期作成には対応していません。32 バイトの乱数を Base64URL にし、先頭に `tpa_` を付けた管理用トークンを Worker の `PAIRING_ADMIN_TOKEN` secret と手元の保護領域に保存します。

1. 管理用トークンを保護領域から環境変数 `PAIRING_ADMIN_TOKEN` に読み込み、`node scripts/pair-device.mjs issue https://<worker-domain> <XユーザーID>` を実行します。出力は10分間有効な使い切りコードです。同じアカウント向けに新しいコードを発行すると前のコードは失効します。
2. Tweetbot で通知を登録して配送をオンにし、対象の X アカウントを選びます。プッシュ通知の設定に Worker の URL とコードを入力し、表示された接続先を確認します。コードを発行した Worker かを確認してから、端末が保管する中継資格情報を送ります。旧ビルドの端末に値がない場合は、この端末で資格情報を入れ替えてください。入れ替え前の値を使う手動ルートも更新が必要です。
3. 「Worker 経由のテスト通知を送信」を押し、通知センターで「新しい通知」を確認します。登録した端末には、その X アカウントで購読済みのメンションと返信が届きます。追加した端末の解除はアプリから行えます。アプリにアクセスできない場合は `node scripts/pair-device.mjs list https://<worker-domain>` で管理ルートを確認し、`node scripts/pair-device.mjs revoke https://<worker-domain> <配送先ID>` で解除できます。

手動ルートを設定していない新規 Worker でも使えます。その場合は `X_RELAY_ROUTES`、`X_USER_ID`、`RELAY_TOKEN`、`X_NOTIFICATION_TYPES` を設定しません。既存の手動ルートも使えます。同じアカウントで同じ中継資格情報をすでに手動設定している端末は、二重配送を防ぐため追加できません。ペアリングは既存の購読を使うので、X の購読管理は上記の手順で行います。
