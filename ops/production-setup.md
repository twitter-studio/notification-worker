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

X の Webhook と購読を設定した利用者 Worker に、SQLite の Durable Object を追加します。現在使用している Wrangler 設定で `main` を切り替え、次の項目を設定してください。既存の migration がある場合は、末尾に固有のタグで追加します。

```jsonc
"main": "src/pairing-worker.ts",
"durable_objects": {
  "bindings": [{ "name": "PAIRING_ROUTES", "class_name": "PairingStore" }]
},
"migrations": [{ "tag": "pairing-v1", "new_sqlite_classes": ["PairingStore"] }]
```

新規のストレージを作成する配置は、Worker 所有者が対象と利用条件を確認し、承認した配置手順で実行します。既存の sandbox Workflow はこの新規リソースの初期作成には対応していません。32 バイトの乱数を Base64URL にし、先頭に `tpa_` を付けた管理用トークンを Worker の `PAIRING_ADMIN_TOKEN` secret と手元の保護領域に保存します。

1. 管理用トークンを保護領域から環境変数 `PAIRING_ADMIN_TOKEN` に読み込み、`node scripts/pair-device.mjs issue https://<worker-domain> <XユーザーID>` を実行します。出力は10分間有効な使い切りコードです。同じアカウント向けに新しいコードを発行すると前のコードは失効します (下の X でログインして出したコードは、別に数えます)。
2. Tweetbot で通知を登録して配送をオンにし、対象の X アカウントを選びます。プッシュ通知の設定に Worker の URL とコードを入力し、表示された接続先を確認します。コードを発行した Worker かを確認してから、端末が保管する中継資格情報を送ります。旧ビルドの端末に値がない場合は、この端末で資格情報を入れ替えてください。入れ替え前の値を使う手動ルートも更新が必要です。
3. 「Worker 経由のテスト通知を送信」を押し、通知センターで「新しい通知」を確認します。登録した端末には、その X アカウントで購読済みのメンションと返信が届きます (種類は下のとおり端末から変えられます)。追加した端末の解除はアプリから行えます。アプリにアクセスできない場合は `node scripts/pair-device.mjs list https://<worker-domain>` で管理ルートを確認し、`node scripts/pair-device.mjs revoke https://<worker-domain> <配送先ID>` で解除できます。

接続した端末の配送先は、Worker の `X_RELAY_ROUTES` を書き換えずに変えられます。端末は、接続のときに作った管理キーで `POST /v1/pairing/settings` を呼び、通知の種類 (`event_types`)、DM プレビューの鍵 (`dm_preview_key`。`null` で外す)、中継資格情報 (`relay_token`) を変えます。変える項目を省くと、今の種類と DM プレビューの有無を返します。鍵の値は返しません。種類を変えていない配送先には、メンションと返信が届きます。選んだ種類は、その X アカウントに同じ種類の購読があるときだけ届きます。同じアカウントの別の配送先と同じ中継資格情報は 409 で断ります。ほかの配送先と同じ DM プレビューの鍵も 409 で断ります。手動の配送先とあとから重なった鍵は、どちらの配送先でも使わず、定型の通知にします。書き換えは、配送先ごとに 10 分で 30 回までです。鍵を外す変更と、種類を減らすだけの変更は数えないので、上限に達した後でも受け取るものを絞れます。アプリからの操作は Tweetbot の対応版で使えます ([tweetbot#420](https://github.com/twitter-studio/tweetbot/issues/420))。Worker が設定の API に対応しているかは、`GET /v1/pairing` の `version` が 2 以上かで分かります。

接続した端末は、管理者に断らずに、その X アカウントの DM の通知と DM の抜粋を有効にでき、中継資格情報を差し替えて届け先の端末も変えられます。管理キーは、解除とテスト通知だけでなく、配送先を決める鍵になります。コードは、その X アカウントの通知を受け取ってよい人の端末にだけ渡してください。`node scripts/pair-device.mjs list https://<worker-domain>` は、配送先ごとに X ユーザー ID、配送先 ID、通知の種類、DM プレビューの有無 (`dm-preview` か `-`) を出します。意図しない配送先は `revoke` で外します。

DM プレビューの鍵を外すか入れ替えると、Queue に残った DM は定型の通知になります。種類を外すと、Queue に残ったその種類の通知も送りません。中継資格情報を変えると、前の値で Queue に入った通知は送りません。

### X でログインして接続する

接続コードを CLI で出す代わりに、Tweetbot から X でログインして接続できます ([ADR-0008](https://github.com/twitter-studio/notification-docs/blob/main/docs/adr/0008-app-driven-notification-setup.md) の段 3)。上の接続の設定 (`PAIRING_ROUTES` と `PAIRING_ADMIN_TOKEN`) に加えて、次の設定を足します。どれかが欠けているか、`ENABLE_X_ACTIVITY` が `"true"` でなければ、`/connect` は 404 になり、上の接続コードの流れだけを使えます。`GET /v1/pairing` の `x_login` で、使えるかが分かります。

| 設定                     | 種類                     | 値                                                                                                                                                       |
| ------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X_OAUTH2_CLIENT_ID`     | vars                     | 自分の X アプリの OAuth 2.0 の Client ID                                                                                                                 |
| `X_OAUTH2_CLIENT_SECRET` | secret                   | 今の Webhook の CRC にも使っている Client Secret (32 文字以上)                                                                                           |
| `ALLOWED_X_USER_IDS`     | vars                     | 接続を許す X ユーザーの数値 ID。カンマ区切り                                                                                                             |
| `X_WEBHOOK_ID`           | vars                     | 購読を付ける Webhook の ID                                                                                                                               |
| `X_APP_BEARER_TOKEN`     | secret                   | 同じ X アプリの App-only の Bearer Token。購読の一覧と削除に使う                                                                                         |
| `CONNECT_LIMITER`        | Rate Limiting の binding | 接続元ごとの回数の上限。例: `"ratelimits": [{ "name": "CONNECT_LIMITER", "namespace_id": "<自分で決める数>", "simple": { "limit": 10, "period": 60 } }]` |

X アプリの Callback URL に `https://<worker-domain>/oauth/callback` を足します (完全一致)。Tweetbot で URL と通知の種類を選んで接続すると、Worker は次のことを行います。

1. 接続元ごとに回数を絞ります。`ALLOWED_X_USER_IDS` にない X アカウントは、持ち主の X アプリの同意画面に進めず断ります。どの ID が許可されているかは、この応答の違いから外に分かります。本人かどうかの守りは、ログインの後の確かめです。
2. ログインを始めたブラウザに Cookie を置き、X から戻ったときに照らし合わせます。他人が始めたログインの URL を開かされて同意しても、購読もコードも作りません。
3. X の OAuth 2.0 (PKCE) で本人を確かめ、アプリで選んでいたアカウントと違えば断ります。トークンは保存せず、`offline.access` も求めません。
4. 選んだ種類の購読のうち、まだないものを本人のトークンで期限なしに作り、作ったらすぐ記録します。`tag` は `tweetbot-worker-connect-<Worker の印>-<試みの印>` です (Worker の印は、その Worker の Durable Object に初めて置く乱数)。持ち主が手で作った購読はそのまま使い、記録しません。同じ Worker のほかの接続が作った購読も、そのまま使って記録します。作った結果が分からなかった (応答がない、読めない、5xx) ときは一覧し直して確かめ、同じ購読があると言われた (409) ときは一覧の購読を使います。途中で失敗したら、今回作ったものを消して、アプリに失敗を返します。購読を作ってコードを出すまでは、4 分で打ち切ります。
5. そのアカウントの接続コードを出してアプリへ戻します。このコードは、ログインを始めたアプリの管理キーでしか使えません。同じアプリが同じアカウントで出し直すと、前のコードは使えなくなります (別の端末のコードは残ります。アカウントごとに 4 つまでで、超えると古いものから使えなくなります)。選んだ種類が、つないだ配送先の種類になります。接続し直したときは、前の種類を置き換えます (足すのではありません)。Tweetbot は、受け取る種類をすべて送ります。

そのアカウントの接続した配送先、使われていない有効なコード、本人を確かめて処理中のログインがどれもなくなると、Worker は自分で作った購読を App-only の Bearer で消します (ログインを始めただけ、X から戻っただけのものは数えません)。同じアカウントに手動の配送先があれば消しません。消せなかった購読と、つながないまま残った購読は、定期の処理 (`triggers.crons`) で消し直します。消し直しが続けて失敗したアカウントは、試す間を 5 分から倍にし、1 日まで延ばします。購読を作り始めたアカウントは、作る途中で処理が打ち切られても残った購読を見つけられるよう、片付けのときにこの Worker の tag の購読を一覧で探して記録に取り込みます。探すときは Webhook で絞らないので、Webhook を付け替えた後も前の購読を拾います。同じ X アプリを使うほかの Worker の購読は、Worker の印が違うので触りません。X の一覧に出るのが遅れることがあるので、この探し直しは、作り始めてから 1 時間たつまで続けます。端末を外したときの片付けは、外す要求を待たせないよう 20 秒で打ち切り、残りは定期の処理で消します。片付けがそのアカウントの購読を消している間や、同じアカウントのほかの端末の接続を処理している間に接続すると、アプリには少し待ってやり直すよう返します (`busy`)。同じアカウントの接続は 1 つずつ処理します (後の接続が使い始めた購読を、先の接続が失敗して戻すときに消さないため)。端末で通知の種類を増やしても購読は増えないので、新しい種類を受け取るには、その種類を選んで接続し直します。

気をつけること:

- 同じ種類の購読が期限付きであれば (購読の CLI の `start` は期限を付けられます)、Worker は新しく作らずにそれを使います。期限が来ると、その種類は届かなくなります。期限のない購読に切り替えるか、期限の前に `renew` します。
- `CONNECT_LIMITER` の `namespace_id` は、同じ Cloudflare のアカウントのほかの Worker と重ねないでください (同じ値の binding は回数を分け合います)。回数は Cloudflare の拠点ごとに数えるので、全体での正確な上限ではありません。
- 同じブラウザで続けて接続を始めると、前の接続の Cookie が上書きされ、前の接続は失敗します。

確かめていないこと:

- Workers の Free プランで Rate Limiting の binding を使えるか。
- 本人の認可で作った購読を、App-only の Bearer で消せるか。消せない場合は、一覧で消えたと分かるまで記録に残し、定期の処理で試し続けます。
- いいねと新しいフォロワーの購読の向き (`inbound`) は、X の OpenAPI に合わせて `filter.direction` で送ります。概要は `filter.qualifiers.direction` と同じものとしています。
- X の Callback URL に workers.dev のホストを登録できるか、新しいフォロワーの購読に要る scope、ASWebAuthenticationSession の中で Cookie が保たれるか。
- 使った後のトークンを取り消すと、本人の認可で作った購読も消えるか (消えないと分かるまで、取り消さない)。
- 購読の `tag` の長さの上限。Worker の tag は 49 文字です。

手動ルートを設定していない新規 Worker でも使えます。その場合は `X_RELAY_ROUTES`、`X_USER_ID`、`RELAY_TOKEN`、`X_NOTIFICATION_TYPES` を設定しません。既存の手動ルートも使えます。同じアカウントで同じ中継資格情報をすでに手動設定している端末は、二重配送を防ぐため追加できません。ペアリングは既存の購読を使うので、X の購読管理は上記の手順で行います。
