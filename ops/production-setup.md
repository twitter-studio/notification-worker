# Tweetbot から Worker に接続して通知を受け取る

配置は [README の Deploy to Cloudflare](../README.md#deploy-to-cloudflare-のボタンで配置する)、監視は [運用手順](README.md) を使います。設定の流れは [ADR-0008](https://github.com/twitter-studio/notification-docs/blob/main/docs/adr/0008-app-driven-notification-setup.md) に従います。

## 1. アプリの通知を登録する

1. iPhone または iPad の Tweetbot で通知を許可し、中継への登録と端末の所有確認を完了します。
2. 通常の「テスト通知の送信」で、その端末に届くことを確認します。
3. Worker の `RELAY_URL` を、アプリが使う中継の origin とそろえます。TestFlight の本番通知は `https://notification-service-production.zunda-dev.workers.dev`、通常の Debug アプリは sandbox の中継を使います。環境が違う資格情報は拒否されます。第三者の URL にすると資格情報がそこへ送られます。

## 2. Worker を配置する

X の開発者アプリを用意し、[Deploy to Cloudflare](../README.md#deploy-to-cloudflare-のボタンで配置する) で Worker、Queue、Durable Object、接続元の回数制限を用意します。実際の配置・リソース作成・X API 利用は所有者の承認を得て行います。

| 設定                     | 置き場所       | 内容                                                                   |
| ------------------------ | -------------- | ---------------------------------------------------------------------- |
| `RELAY_URL`              | vars           | アプリが登録した中継の HTTPS origin                                    |
| `ENABLE_X_ACTIVITY`      | vars           | `/setup` と通知受信を使うとき `true`                                   |
| `X_OAUTH2_CLIENT_ID`     | vars           | 自分の X アプリの Client ID                                            |
| `ALLOWED_X_USER_IDS`     | vars           | 接続を許す X ユーザーの数値 ID。カンマ区切り                           |
| `X_OAUTH2_CLIENT_SECRET` | secret         | 同じ X アプリの Client Secret。CRC と署名検証にも使用                  |
| `X_APP_BEARER_TOKEN`     | secret         | 同じ X アプリの App-only Bearer。購読の一覧・削除と Webhook 管理に使用 |
| `X_EVENT_ID_SECRET`      | secret         | 署名秘密と独立した32文字以上の乱数。重複除去に使用                     |
| `PAIRING_ADMIN_TOKEN`    | secret         | `tpa_` と32バイトの乱数の Base64URL。管理者の一覧・強制解除に使用      |
| `PAIRING_ROUTES`         | Durable Object | アプリが接続した配送先と Webhook の記録                                |
| `CONNECT_LIMITER`        | Rate Limiting  | 接続元の回数制限。ほかの Worker と namespace を分ける                  |

`PAIRING_ADMIN_TOKEN` と `X_EVENT_ID_SECRET` の作り方は [README](../README.md#deploy-to-cloudflare-のボタンで配置する) を参照します。秘密をログやチャットに出しません。`X_RELAY_ROUTES`、`X_USER_ID`、`RELAY_TOKEN`、`X_NOTIFICATION_TYPES` は新しい通知接続には設定しません。`X_WEBHOOK_ID` は既存 Webhook を明示する場合だけの任意の vars で、通常は `/setup` の記録を使います。

X アプリの Callback URL に `https://<worker-domain>/oauth/callback` を追加し、ブラウザで `https://<worker-domain>/setup` を開いて Webhook を用意します。

自分で CLI 配置する場合も、`wrangler.jsonc` を git で無視する `wrangler.local.jsonc` に写し、端末接続の binding・migration・Cron を保持します。既存の [sandbox 配置 Workflow](deployment.md) は端末接続を含まない開発用構成なので、この Worker の更新には使いません。

## 3. 各端末・アカウントを接続する

1. Tweetbot で対象の Twitter アカウントを選び、プッシュ通知設定を開きます。
2. Worker URL に `https://<worker-domain>` を入力します。通知の種類を選び、「Workerに接続」を押します。
3. 確かめのページで Worker と種類を確認し、Twitter で同じアカウントの利用に同意します。接続は必ず Tweetbot から始めます。
4. 接続後「Worker経由のテスト通知を送信」を押し、通知センターを確認します。
5. 実際のメンション・返信を受け取り、通知をタップすると対象ツイートの詳細が開くことを確認します。

端末が中継トークンを保存していない場合は、資格情報の入れ替えを求めます。古い資格情報は無効になるので、既存の配送先を確認し、所有者の承認を得て入れ替えます。アプリが接続済みの Worker に新しい値を送ります。資格情報や配送先 ID を手で写す必要はありません。

## 通知の種類を選ぶ

ほかの端末やアカウントも同じ手順で接続します。上限は8アカウント、1アカウント4台です。通知の種類と DM プレビューはアプリから変えます。新しい種類の X 購読を増やす場合は、その種類を選んで再接続します。種類をオフにする操作だけでは X の購読は削除されません。

## 接続を解除・停止する

端末のそのアカウントだけを外すときは、アプリの「Workerとの接続を解除」を使います。同じアカウントのほかの接続が残っていれば、その端末への配送は続きます。最後の接続を外すと、Worker は自分が作った購読の片付けを始めます。既存の手動購読や他の Worker の購読は削除しません。

すべて停止する場合は、各端末・各アカウントの接続を解除し、購読の片付けと Queue が空になったことを確認してから入口を無効にします。購読の削除完了前に Durable Object を消したり付け替えたりしません。Worker が作った購読の記録を失うためです。削除結果が不明な場合は停止完了と扱いません。X のコンソールなど所有者が承認した経路で購読を確認します。

アプリにアクセスできない場合は、管理者が次の CLI で接続を一覧し、対象だけを強制解除できます。`PAIRING_ADMIN_TOKEN` を保護領域から環境変数に読み込み、値を画面やログへ出さずに使います。一覧は X ユーザー ID と配送先 ID を含むため、公開の記録へ転載しません。

管理用 CLI を使う Mac では Git と [mise](https://mise.jdx.dev) を用意し、リポジトリを取得して Node.js を入れます。配置ボタンだけを使った場合も、この準備が必要です。

```sh
git clone https://github.com/twitter-studio/notification-worker.git
cd notification-worker
mise install
```

```sh
node scripts/pair-device.mjs list https://<worker-domain>
node scripts/pair-device.mjs revoke https://<worker-domain> <配送先ID>
```

## 旧設定から移す

旧 CLI と接続コード発行の案内は廃止しました。既存の手動配送先と接続済み端末を読む処理は残っているため、コードの更新だけで自動移行はしません。

1. 現在の設定を保護領域へ退避し、全端末とアカウントの移行範囲を決めます。新しい接続に、同じ配送先 ID や同一アカウントの同じ中継資格情報が重なると409になります。
2. 変更する手動設定と一時的な配送停止の範囲について所有者の承認を得ます。重複する手動配送先があれば、他の配送先を残してその項目を外し、アプリから接続します。
3. Worker 経由テスト通知と実イベントの到達を確かめます。既存の設定値を変える更新では、移行前の設定を再配置しないよう正本も更新します。
   最後の手動配送先を外すときは、`X_RELAY_ROUTES`、`X_USER_ID`、`RELAY_TOKEN`、`X_NOTIFICATION_TYPES` の4項目を、同じ本番更新ですべて未設定または空にします。`X_RELAY_ROUTES` に `{}` を残すと設定エラーになります。その秘密だけを消して旧単一配送の `X_USER_ID` と `RELAY_TOKEN` を残すと、旧配送が再び使われ、同じ資格情報での接続は409になります。ほかの手動配送先が残る間は、その配送先の有効な一覧を保持します。すべてアプリへ移した後は、4項目を復活させない構成を設定の正本にします。

手動で作った X 購読は自動削除されません。[手動購読の停止・回復手順](manual-subscription-cleanup.md)で対象を照合して削除します。期限付きのもの、使わない種類、別の用途が使う購読を所有者が確認します。アプリで通知を絞っても、その購読による X 側の配信や課金は止まりません。

## `/setup` で Webhook を用意する

`X_WEBHOOK_ID` を置かずに、Worker のページから Webhook を用意できます ([ADR-0008](https://github.com/twitter-studio/notification-docs/blob/main/docs/adr/0008-app-driven-notification-setup.md) の段 4)。必要な設定をそろえてから、ブラウザで `https://<worker-domain>/setup` を開き、「Twitterでログイン」を押して、`ALLOWED_X_USER_IDS` のアカウントでログインします。`ALLOWED_X_USER_IDS` のアカウントなら、持ち主でなくても設定できます (登録できないときに、開発者アプリのほかの Webhook の URL も見えます)。Worker は次のことを行います。

1. ページを開いただけでは、ログインを始めません。ボタンのフォームは、ページを開いたブラウザの Cookie (`SameSite=Strict`) と照らし合わせるので、外のページから直に送らせることはできません。ページは外のページの枠の中には出ません。ボタンを押したとき、X から戻ってトークンを求める前に、接続元ごとに回数を数えます (`/connect` と同じ `CONNECT_LIMITER` を、別の鍵で使います。そのため、接続元ごとの回数は `/connect` と合わせて 2 倍になります)。
2. X の OAuth 2.0 (PKCE) で、`tweet.read` と `users.read` だけを求めて本人を確かめます。ログインを始めたブラウザでないとき、`ALLOWED_X_USER_IDS` にないアカウントのときは、Webhook に触りません。トークンは保存しません。ログインの前にはアカウントが分からないので、`/connect` と違って、許可していないアカウントも X アプリの同意画面まで進み、Worker はトークンの交換と `GET /2/users/me` を 1 回ずつ呼びます。
3. App-only の Bearer で開発者アプリの Webhook を一覧し、`https://<worker-domain>/webhooks/x` のもの (URL の形を揃えて比べます) があれば、X に確かめ (CRC) を呼び直させます。なければ登録します (登録のときも X が確かめます)。
4. X が確かめた Webhook の ID だけを Durable Object に保存し、状態をページに出します。確かめられない Webhook に購読を付けても、イベントは届かず、課金だけが進むためです。前に保存した同じ Webhook を確かめ直して失敗したときは、保存した ID を外し、確かめ直せるまで接続を止めます。`X_WEBHOOK_ID` を置いていれば、接続ではそちらを使います。値が違うとき、ID の形でないときは、ページに出します。

開発者アプリの Webhook が上限に達していて登録できないときと、同じ URL の Webhook がすでにあると言われたときは、開発者アプリのほかの Webhook の URL をページに出します (2026-11-08 に、Pay Per Use のアプリで 2 つ目を作ろうとして `WebhookLimitExceeded` になりました)。使っていないものを開発者コンソールで削除してから、開き直します。削除すると、その Webhook への配送は止まります。同じ URL の Webhook が、この Worker がすでに使っているものなら、削除せずに、ページに出した ID を `X_WEBHOOK_ID` に入れます。Worker はほかの Webhook を消しません (ほかの Worker への配送を止めないため)。X が確かめられないときは、`X_OAUTH2_CLIENT_SECRET` が開発者アプリの Client Secret と合っているかを確かめます。確かめの呼び直しが混み合い (429) や 5xx などで失敗したときは、結果が分からないので、しばらくしてから開き直すよう出します。

`/setup` のログインは 10 分で切れ、待っているものは 16 までで、超えると古いものから置き換えます。外から何度もボタンを押されると、持ち主のログインが置き換えられて、X から戻ったときに初めからやり直すことになります (断ると、他人が枠を埋めるだけで持ち主が設定できなくなるため、置き換えます)。置き換えられたログインで戻ると、`/setup` のログインとは分からないので、接続の戻りとして扱い、`Not Found` か `Start again from Tweetbot.` と出ます。そのときは `/setup` を開き直します。同じブラウザの 2 つのタブで `/setup` を開くと、前のタブのボタンは使えなくなります。

## 接続時の処理

Tweetbot で URL と通知の種類を選んで接続すると、Worker は次のことを行います。

1. X へ送る前に、確かめのページを出します。つなぐ Worker と通知の種類 (DM は目立たせます) を見せ、Tweetbot から始めたときだけ続けるよう求めます。`/connect` の URL は誰でも作れるので、ほかの人の管理キーで始めたログインの URL を開かされても、本人が止められるようにするためです。「続ける」は、ページを開いたブラウザの Cookie (`SameSite=Strict`) とフォームの値を照らし合わせるので、外のページから直に送らせることはできません。ページは外のページの枠の中には出ません。
2. 接続元ごとに回数を絞ります (ページを開く、続ける、X から戻るのそれぞれで 1 回と数えます)。上限を超えたときと、引数が合わないとき (アプリと Worker の版が違い、Worker の知らない種類を求められたなど) は、X へは何も求めず、アプリへ戻して知らせます (`rate_limited`、`invalid_request`)。どのアプリが始めたか分からない要求は、文字のページで断ります。`ALLOWED_X_USER_IDS` にない X アカウントは、持ち主の X アプリの同意画面に進めず断ります。どの ID が許可されているかは、この応答の違いから外に分かります。本人かどうかの守りは、ログインの後の確かめです。
3. ログインを始めたブラウザに Cookie を置き、X から戻ったときに照らし合わせます。他人が始めたログインの URL を開かされて同意しても、購読もコードも作りません。
4. X の OAuth 2.0 (PKCE) で本人を確かめ、アプリで選んでいたアカウントと違えば断ります。トークンは保存せず、`offline.access` も求めません。
5. 選んだ種類の購読のうち、まだないものを本人のトークンで期限なしに作り、作ったらすぐ記録します。`tag` は `tweetbot-worker-connect-<Worker の印>-<試みの印>` です (Worker の印は、その Worker の Durable Object に初めて置く乱数。49 文字で、X の `tag` の上限の 200 文字に収まります)。持ち主が手で作った購読はそのまま使い、記録しません。同じ Worker のほかの接続が作った購読も、そのまま使って記録します。作った結果が分からなかった (応答がない、読めない、5xx) ときは一覧し直して確かめ、同じ購読があると言われた (409) ときは一覧の購読を使います。途中で失敗したら、今回作ったものを消して、アプリに失敗を返します。購読を作ってコードを出すまでは、4 分で打ち切ります。
6. そのアカウントの接続コードを出してアプリへ戻します。このコードは、ログインを始めたアプリの管理キーでしか使えません。同じアプリが同じアカウントで出し直すと、前のコードは使えなくなります (別の端末のコードは残ります。アカウントごとに 4 つまでで、超えると古いものから使えなくなります)。選んだ種類が、つないだ配送先の種類になります。接続し直したときは、前の種類を置き換えます (足すのではありません)。Tweetbot は、受け取る種類をすべて送ります。

そのアカウントの接続した配送先、使われていない有効なコード、本人を確かめて処理中のログインがどれもなくなると、Worker は自分で作った購読を App-only の Bearer で消します (ログインを始めただけ、X から戻っただけのものは数えません)。同じアカウントに手動の配送先があれば消しません。消せなかった購読と、つながないまま残った購読は、定期の処理 (`triggers.crons`) で消し直します。消し直しが続けて失敗したアカウントは、試す間を 5 分から倍にし、1 日まで延ばします。購読を作り始めたアカウントは、作る途中で処理が打ち切られても残った購読を見つけられるよう、片付けのときにこの Worker の tag の購読を一覧で探して記録に取り込みます。探すときは Webhook で絞らないので、Webhook を付け替えた後も前の購読を拾います。同じ X アプリを使うほかの Worker の購読は、Worker の印が違うので触りません。X の一覧に出るのが遅れることがあるので、この探し直しは、作り始めてから 1 時間たつまで続けます。端末を外したときの片付けは、外す要求を待たせないよう 20 秒で打ち切り、残りは定期の処理で消します。片付けがそのアカウントの購読を消している間や、同じアカウントのほかの端末の接続を処理している間に接続すると、アプリには少し待ってやり直すよう返します (`busy`)。同じアカウントの接続は 1 つずつ処理します (後の接続が使い始めた購読を、先の接続が失敗して戻すときに消さないため)。端末で通知の種類を増やしても購読は増えないので、新しい種類を受け取るには、その種類を選んで接続し直します。

気をつけること:

- 同じ種類の既存購読が期限付きなら、Worker は新しく作らずにそれを使います。期限が来ると届かなくなるため、所有者が既存購読を確認します。期限切れ後はアプリから再接続し、必要な購読を作ります。
- `CONNECT_LIMITER` の `namespace_id` は、同じ Cloudflare のアカウントのほかの Worker と重ねないでください (同じ値の binding は回数を分け合います)。回数は Cloudflare の拠点ごとに数えるので、全体での正確な上限ではありません。
- 同じブラウザで続けて接続を始めると、前の接続の Cookie が上書きされ、前の接続は失敗します。

確かめていないこと:

- Workers の Free プランで Rate Limiting の binding を使えるか。
- 本人の認可で作った購読を、App-only の Bearer で消せるか。消せない場合は、一覧で消えたと分かるまで記録に残し、定期の処理で試し続けます。
- いいねと新しいフォロワーの購読の向き (`inbound`) は、X の OpenAPI に合わせて `filter.direction` で送ります。概要は `filter.qualifiers.direction` と同じものとしています。
- 新しいフォロワーの購読に要る scope。X の Callback URL に workers.dev のホストを登録できること、ASWebAuthenticationSession の中で Cookie が保たれること (Worker は Cookie の合わない戻りを断るので、接続できたことから分かります) は、実機で確かめました ([記録](https://github.com/twitter-studio/notification-docs/blob/main/docs/operations/2026-11-08-worker-x-login-device-test.md))。
- 使った後のトークンを取り消すと、本人の認可で作った購読も消えるか (消えないと分かるまで、取り消さない)。
- `/setup` の確かめの呼び直し (`PUT /2/webhooks/:id`) の答えの `valid` が、確かめの結果か、確かめを始めたことか (X の文書の書き方が 2 通りある)。Worker は確かめの結果として扱います。失敗の答えの状態コードと本文の形も文書にないので、エラーの名前 (`WebhookLimitExceeded`、`CrcValidationFailed`、`UrlValidationFailed`、`DuplicateUrlFailed`) が本文にあるかだけを見ます。2026-11-09 に、上限のときの本文に `WebhookLimitExceeded` があることを、本物の X で確かめました。ほかの名前は確かめていません。
- X が Webhook の URL を整えて保存するか。Worker は URL の形を揃えて比べます。
- 許可していないアカウントの `/setup` のログインで呼ぶ `GET /2/users/me` が、X の課金の対象になるか。
