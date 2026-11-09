# notification-worker

利用者が自分の Cloudflare に置く Worker のひな形です。イベントを受けて正規化し、運営の通知の中継 API (notification-service) へ、自分の中継の資格情報で送ります。中継の API が、tweetbot のアプリへ通知を送ります。

- 運営は、X の API の資格情報を集めません。XAA のメンション、直接返信、リツイート、引用ツイート、いいね、新規フォロー、DM 受信に対応します。既定で無効 (`ENABLE_X_ACTIVITY=false`) です。種類ごとの選択は[本番セットアップ](ops/production-setup.md#通知の種類を選ぶ)を参照してください。
- 今は、試すための模擬のイベント (`POST /webhooks/mock`) を送れます。
- 決まりごとは `docs/adr/0001-mock-webhook-and-relay.md`、開発の決まりは `AGENTS.md` にあります。

## 入口

| 入口                                      | 内容                                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                             | `{"status":"ok"}` を返す。設定は返さない                                                                                                                                    |
| `POST /webhooks/mock`                     | 署名した模擬のイベントを受け、中継の API へ送る。`ENABLE_MOCK_EVENTS="true"` のときだけ                                                                                     |
| `GET /webhooks/x`                         | XのCRC。既定では404                                                                                                                                                         |
| `POST /webhooks/x`                        | XAA の署名を確認して、本人宛てで有効にした通知だけを Queue へ保存。既定では404                                                                                              |
| `GET /setup`, `POST /setup`               | 許可した X アカウントでログインし、この Worker の Webhook を登録・確かめる ([手順](ops/production-setup.md#setup-で-webhook-を用意する))。X でのログインの設定がなければ404 |
| `GET /connect`, `POST /connect`           | Tweetbot から X でログインして接続する。X でのログインの設定がなければ404                                                                                                   |
| `GET /oauth/callback`                     | `/setup` と `/connect` の X のログインの戻り先                                                                                                                              |
| `GET /v1/pairing`, `POST /v1/pairing/...` | 接続の版の確かめと、接続・設定の API。接続の設定がなければ404                                                                                                               |

## 用意するもの

- 自分の Cloudflare アカウント。Workers と Queues の利用枠は、初回セットアップで確認します。
- Tweetbot の通知を登録した iPhone と、登録時に 1 回だけ表示される中継の資格情報。
- X 通知を受ける場合は、自分の X 開発者アプリ。
- [mise](https://mise.jdx.dev) (Node.js と pnpm の版をそろえます)。

## デプロイの手順

### Deploy to Cloudflare のボタンで配置する

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/twitter-studio/notification-worker)

ボタンを押すと、Cloudflare がこのリポジトリを自分の GitHub アカウントに写し、設定 (`wrangler.jsonc`) のとおりに、Worker、Queue、Durable Object を作って配置します ([ADR-0008](https://github.com/twitter-studio/notification-docs/blob/main/docs/adr/0008-app-driven-notification-setup.md) の段 5)。X の通知を Tweetbot から接続して受け取るときは、次のように進めます。

1. 自分の X の開発者アプリを用意し、OAuth 2.0 の Client ID と Client Secret、App-only の Bearer Token を手元に用意します。
2. `PAIRING_ADMIN_TOKEN` を作ります。Worker にだけ置く管理用の値で、Tweetbot には入れません。接続の一覧と解除の CLI でも使うので、パスワードの管理アプリなどに保存します。画面にもログにも出さずにクリップボードへ写すには、macOS では次のようにします。

   ```sh
   node -e 'process.stdout.write("tpa_" + require("node:crypto").randomBytes(32).toString("base64url"))' | pbcopy
   ```

   `X_EVENT_ID_SECRET` も、同じように画面に出さずに作れます (`randomBytes(32).toString("base64url")`。`tpa_` は付けません)。クリップボードは履歴やほかの機器との共有に残ることがあるので、配置の画面に貼ったら、ほかの文字を写して消します。

3. ボタンを押し、配置の画面で次の値を入れます (どの値にも、画面に説明が出ます。値は引用符を付けずに入れます)。
   - 写すリポジトリは、非公開にします (配置の画面で変えた値が、写したリポジトリに書き込まれることがあるため)。
   - 変数: `ENABLE_X_ACTIVITY` を `true`、`X_OAUTH2_CLIENT_ID`、`ALLOWED_X_USER_IDS` (自分の X ユーザーの数値 ID)、`RELAY_URL` (既定は運営の中継です。Tweetbot の設定の画面に出る URL と同じかを確かめます。ほかの URL を入れると、端末の中継の資格情報がそこへ送られます)。変数の欄は平文で残るので、秘密を入れません。
   - 秘密: `X_OAUTH2_CLIENT_SECRET`、`X_APP_BEARER_TOKEN`、`X_EVENT_ID_SECRET`、`PAIRING_ADMIN_TOKEN`。ボタンは、ここに並べた秘密をどれも必須の欄として求めます。任意の秘密 (`RELAY_TOKEN`、`MOCK_WEBHOOK_SECRET`、`X_PREVIEW_BEARER_TOKEN`) は求めないので、要るときは配置の後に置きます。
   - Queue の名前は、同じ Cloudflare のアカウントでほかの用途に使っているものと重ねません。
4. 配置が終わったら、X の開発者アプリの Callback URL に `https://<Worker のドメイン>/oauth/callback` を足します。
5. ブラウザで `https://<Worker のドメイン>/setup` を開き、X でログインして Webhook を用意します ([手順](ops/production-setup.md#setup-で-webhook-を用意する))。
6. Tweetbot の設定から、Worker の URL を入れて接続します。

ボタンでは、`/setup` を使うために、最初から `ENABLE_X_ACTIVITY` を `true` にします (下の「XAAの有効化前に確認すること」の、準備を終えてから有効にする手順の例外です)。X の購読は、`/setup` で Webhook を用意し、Tweetbot から接続するまで作りません。

まだ確かめていないこと: ボタンが Queue の producer と consumer の両方を用意するか (文書は、自動で用意する資源に Queues を挙げています)、Rate Limiting の binding と Cron Triggers をそのまま配置するか、配置の画面で入れた変数が写したリポジトリの `wrangler.jsonc` に書き込まれるか (書き込まれなければ、写したリポジトリへの次の push で既定の値に戻ります。`true` が文字でなく真偽値として書き込まれると、入口は閉じたままになります)、Node 26 の Workers Builds で pnpm を用意できるか (Node 25 から Corepack が同梱されていません)。`CONNECT_LIMITER` の `namespace_id` は、同じ Cloudflare のアカウントのほかの Worker と重なるなら変えます。

### 自分で配置する

前の手順で、git で無視していた `wrangler.jsonc` を手元に作っていた場合は、この版を取り込む前に `wrangler.local.jsonc` へ名前を変えてください。`wrangler.jsonc` はコミットしたボタンの設定になったので、取り込むと、手元のものは警告なしに上書きされます。以後の `wrangler` のコマンドには、`--config wrangler.local.jsonc` を付けます。

Tweetbotの本番通知を使う場合は、[利用者向けの初回セットアップ](ops/production-setup.md)から始めてください。招待制sandboxの試験と資格情報の回復は[試験用の手順](ops/setup.md)、既存Workerの承認付き更新は[配置Workflow](ops/deployment.md)を参照してください。

## 模擬のイベントで試す

鍵は、コミットしない `.dev.vars` にだけ置きます。画面に出したり、命令の行 (`MOCK_WEBHOOK_SECRET=… node …` のような形も) に書いたりしません。シェルの履歴に残るためです。

1. 署名の鍵を作り、画面に出さずに `.dev.vars` へ書き込みます (前の行があれば置き換え、ファイルは持ち主だけが読める権限にします)。

   ```sh
   node scripts/new-mock-secret.mjs
   ```

2. 同じ鍵を、自分の Worker の秘密として置きます (送るスクリプトと同じ読み方で読み、標準入力から渡します)。

   ```sh
   node --env-file=.dev.vars -e 'process.stdout.write(process.env.MOCK_WEBHOOK_SECRET ?? "")' | pnpm wrangler secret put MOCK_WEBHOOK_SECRET --config wrangler.local.jsonc
   ```

3. `wrangler.local.jsonc` の `ENABLE_MOCK_EVENTS` を `"true"` にして、デプロイし直します。
4. 模擬のイベントを送ります (鍵は `.dev.vars` から読みます)。

   ```sh
   node --env-file=.dev.vars scripts/send-mock-event.mjs https://<Worker の URL> mention
   ```

   `200 {"counts":{"accepted":1}}` が返り、アプリに通知が届きます (端末の登録と確かめが済んでいるとき)。
5. 試し終えたら、`ENABLE_MOCK_EVENTS` を `"false"` に戻してデプロイし直し、秘密も消します。

   ```sh
   pnpm wrangler secret delete MOCK_WEBHOOK_SECRET --config wrangler.local.jsonc
   ```

   `wrangler.jsonc` と `wrangler.example.jsonc` は、版ごとの URL (`preview_urls`) を作らない設定です。模擬の入口を有効にした版が、版の URL で開いたまま残りません。

## XAAの有効化前に確認すること

[ADR-0002](docs/adr/0002-x-activity-webhook.md)に署名・本人の確認・再送・破棄の条件を記録しています。LEGAL-001はオーナー判断で完了しました。実API接続や課金を伴う操作、配置は別途承認を得てから行います。実接続の結果は[QA-002の記録](docs/verification/2026-11-05-qa002.md)を参照してください。補助CLIの実接続と停止は[USER-003の記録](docs/verification/2026-11-05-user-setup-cli.md)を参照してください。

有効化には次の構成が必要です。

- 本人が所有するX開発者アプリのOAuth 2.0 client secretを、利用者Workerの`X_OAUTH2_CLIENT_SECRET`へ保存します。API bearerやユーザーのアクセストークンで代用しません。
- 独立した32文字以上の乱数を`X_EVENT_ID_SECRET`へ保存します。署名秘密と共用せず、通常の署名鍵更新で変更しません。値をコマンド引数・チャット・ログへ出しません。
- 手で配送先を設定するときは、`X_USER_ID`を、XでOAuth認可した本人のIDにします (Tweetbot から接続するだけなら空のままにします)。mention・replyには本人によるOAuth 2.0の同意と`tweet.read`が必要です。OS通知許可やApp Attestで代用しません。
- 利用者側にQueue `notification-x-events`を1つ用意し、保持を1日にします。設定例のproducerとconsumerの名前をそろえます。既存の模擬イベントだけを使う場合は、`queues`設定を利用者の設定から外せます。
- 対象アカウント、アプリ、費用上限、Queue監視、削除と認可取り消しの手順を具体化し、承認後に配置・購読を行います。Xへの照会はオーナー判断により行いません。
- `ENABLE_X_NOTIFICATION_PREVIEW=true` で、メンション・直接返信・引用ツイート・リツイート・いいねの通知に、通知を起こした公開アカウントの @ユーザー名と公開ツイートの抜粋を表示できます。いいねとリツイートには元のツイートの本文を使います。Webhook に必要な情報がなければ、`X_PREVIEW_BEARER_TOKEN` を設定した場合に限り、X の User Lookup を行います。元のツイートの Post Lookup も使う場合は `ENABLE_X_POST_PREVIEW_LOOKUP=true` を設定します。照会には X の利用料がかかる場合があります。本文を確認できない場合は定型文で通知します。対応する中継 API を先に配置してください。
- 準備と検証を終えてから`ENABLE_X_ACTIVITY`を`"true"`にします。それまでは`"false"`のままです。生のWebhook本文や署名をログへ追加しません。

200の`queued`は保存の確認であり、APNs受理や実機表示の確認ではありません。Queue保存失敗は503です。consumerはaccepted/duplicateを受けてからackします。中継が資格情報を断った (401) ときは再試行せずに破棄し、そのほかの失敗は上限6回またはイベントの期限で破棄します。破棄理由・認証失敗・滞留を監視します。実環境の配信と監視の確認はリリース前のゲートです。

本人ID・送り先・中継資格情報のいずれかを変更すると、その前に保存したjobは`relay_changed`として破棄します。別の通知アカウントへ過去のjobを送らないためです。通常の計画的な入れ替えでは、Xの購読を止めてQueueを空にしてから更新し、同じアカウントで再開します。漏えい時は滞留の解消を待たず先に取り消します。

## 秘密の入れ替え

- **中継の資格情報**: アプリの設定の画面で入れ替えると、新しい値が 1 回だけ出て、前の値はすぐに使えなくなります。承認した配置経路でWorker secretを更新します。計画的な更新では先に購読を解除しQueueを空にします。XのQueue jobは資格情報変更後に破棄されるため、[更新と停止の手順](ops/setup.md)に従います。模擬イベントとXのQueue jobは、401を送り直しません。
- **漏れたかもしれないとき**: アプリで中継の資格情報を取り消すか入れ替えます。取り消すと、入れ替えるまで通知は届きません。
- **模擬の Webhook の鍵**: 上の手順 1 と 2 をやり直します (手順 1 が `.dev.vars` の行を置き換えます)。

## 模擬イベントのやり直しの扱い

- 中継の API が混んでいるとき (409、429、500、502、503、504) は、`Retry-After` が 5 秒までなら Worker の中で待って送り直します (今の中継の API は 30 秒以上を返すので、実際に Worker の中で送り直すのは、主につながらないときです)。長い待ちのときは、そこで送るのをやめ、Webhook を送ってきた側へ 503 と、中継の API が求めた `Retry-After` を返します。
- 資格情報が使えない (401、403) ときと、中継の API でない先の答え (リダイレクト、404、405。`RELAY_URL` の誤り) のときは、残りのイベントも送らずにやめ、ログに error を出します。
- 1 回の要求で外へ送るのは 45 回までです (Workers の無料のプランの上限 50 回の内側)。届いたら、残りを送らずに 503 を返します。
- 形が違う (422 など) イベントは送り直さず、次のイベントを送ります。
- イベントの時刻から 1 日を過ぎたイベントは送りません (中継の API は、受け付けの記録を 7 日残し、古いイベントを拒みます)。
- 模擬の署名した同じ要求が 5 分のうちに繰り返されたときは受けます。同じイベントは、中継の API が重複として除きます。

## 気をつけること

- Worker の URL は公開です。誰でも `GET /health` などを呼べ、自分の Workers の無料の枠 (1 日の要求の数、ログの数) を使えます。
- `RELAY_URL` は、アプリに出た URL を写します。ほかの URL を入れると、中継の資格情報がそこへ送られます。
- `wrangler login` は、手元に広い範囲の権限を残します。デプロイし終えたら `pnpm wrangler logout` するか、範囲を絞った API トークンを使います。

## 開発

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build   # デプロイはしない (--dry-run)
```

## 本人のOAuth認可をローカルで保存する

`scripts/x-oauth.mjs`は、XアプリのConfidential client用の認可を受けます。Xユーザーの認可、token交換、ローカル保存だけを行い、本人情報の取得・購読・課金・配置は行いません。

1. 自分だけが読めるディレクトリ（0700）へ、`client-id.txt`と`client-secret.txt`（各0600）を置きます。ファイルには値だけを保存し、コマンドの引数や環境変数に資格情報を書きません。
2. XアプリのCallback URIを`http://127.0.0.1:8788/callback`にします。OAuth 2.0の有効化と秘密の発行は、実行する前に承認を確認します。
3. ディレクトリのパスだけを渡して起動します。

   ```sh
   mise exec -- node scripts/x-oauth.mjs '<保護ディレクトリの絶対パス>'
   ```

4. 出力されたローカルHTMLファイルをブラウザで開き、リンクからXの認可画面へ進みます。アカウントと`tweet.read users.read`を確認し、承認します。`offline.access`・DM・書き込みの権限は求めません。PKCEはS256、stateとverifierは起動ごとに作ります。
5. 承認するとClient Secret・認可コード・verifierを`https://api.x.com/2/oauth2/token`へ送り、得たtokenと認可に使ったClient IDを同じディレクトリの`user-token.json`へ0600で保存します。callbackページ・標準出力・エラーには値を出しません。既存のtokenファイルは上書きしません。期限切れのファイルを残す場合は、保護ディレクトリ内で別名へ移してからやり直します。

待機は5分、token交換は10秒までです。拒否・timeout・SIGINT/SIGTERMでは、一時HTMLと予約した空ファイルを片付けます。強制終了や電源断では残る場合があります。再実行前に、前回プロセスの終了と空ファイルであることを確認します。通常の資格情報ファイルは削除しません。

認可後のAPI利用・購読・Cloudflareへの資格情報保存は別の実行範囲です。利用者のMacだけにtokenを置き、運営へ渡しません。実行環境が異なるため、OAuth CLIはNodeのテスト、Workerはworkerdのテストで検証します。

公式手順（2026-11-04確認）: [X OAuth 2.0 PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token)、[アプリ種別とloopback Callback](https://docs.x.com/fundamentals/developer-apps#callback-urls)。

## 利用者Workerの監視

[Queue滞留・中継失敗の監視手順](ops/README.md) を参照。5分のCronと個人情報を含まない種類別集計を用意している。配置と警報の有効化・通知先の設定は別途必要。


## セキュリティと運用資料

報告方法は [SECURITY.md](SECURITY.md)、承認付き配置の定義と必要な設定は [ops/deployment.md](ops/deployment.md) を参照してください。追加の運営用資料へのリンクには、非公開リポジトリへの参照を含みます。公開コードから実サービスの利用登録やproduction運用を開始できるという意味ではありません。
