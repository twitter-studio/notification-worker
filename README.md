# notification-worker

利用者が自分の Cloudflare に置く Worker のひな形です。イベントを受けて正規化し、運営の通知の中継 API (notification-service) へ、自分の中継の資格情報で送ります。中継の API が、tweetbot のアプリへ通知を送ります。

- 運営は、X の API の資格情報を集めません。X の連携 (X-001) は、X の規約の判断 (LEGAL-001) が通るまで作らず、既定で無効 (`ENABLE_X_ACTIVITY=false`) です。
- 今は、試すための模擬のイベント (`POST /webhooks/mock`) を送れます。
- 決まりごとは `docs/adr/0001-mock-webhook-and-relay.md`、開発の決まりは `AGENTS.md` にあります。

## 入口

| 入口                  | 内容                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `GET /health`         | `{"status":"ok"}` を返す。設定は返さない                                                |
| `POST /webhooks/mock` | 署名した模擬のイベントを受け、中継の API へ送る。`ENABLE_MOCK_EVENTS="true"` のときだけ |
| `POST /webhooks/x`    | X の Webhook (まだ作っていない)。既定では 404                                           |

## 用意するもの

- 自分の Cloudflare のアカウント (Workers の無料のプランで動きます)。
- tweetbot のアプリで通知を登録し、設定の画面に 1 回だけ出る中継の資格情報 (`tsr_` で始まる値) と、中継の API の URL。
- [mise](https://mise.jdx.dev) (Node.js と pnpm の版をそろえます)。

## デプロイの手順

```sh
mise install
pnpm install --frozen-lockfile
cp wrangler.example.jsonc wrangler.jsonc
```

1. `wrangler.jsonc` の `name` を自分の Worker の名前に、`RELAY_URL` をアプリに出た中継の API の URL (https、パスなし) に変えます。
2. Cloudflare にログインします。

   ```sh
   pnpm wrangler login
   ```

3. 中継の資格情報を、秘密として置きます (値は聞かれたときに貼ります。ファイルやコマンドの引数に書きません)。

   ```sh
   pnpm wrangler secret put RELAY_TOKEN --config wrangler.jsonc
   ```

4. デプロイします。

   ```sh
   pnpm wrangler deploy --config wrangler.jsonc
   ```

5. 動いているかを確かめます。

   ```sh
   curl https://<Worker の名前>.<アカウントのサブドメイン>.workers.dev/health
   ```

## 模擬のイベントで試す

1. 署名の鍵を作り、秘密として置きます。

   ```sh
   node -e 'console.log(crypto.randomBytes(32).toString("base64url"))'
   pnpm wrangler secret put MOCK_WEBHOOK_SECRET --config wrangler.jsonc
   ```

2. `wrangler.jsonc` の `ENABLE_MOCK_EVENTS` を `"true"` にして、デプロイし直します。
3. 模擬のイベントを送ります (鍵は環境の変数で渡します)。

   ```sh
   MOCK_WEBHOOK_SECRET=<鍵> node scripts/send-mock-event.mjs https://<Worker の URL> mention
   ```

   `200 {"counts":{"accepted":1}}` が返り、アプリに通知が届きます (端末の登録と確かめが済んでいるとき)。
4. 試し終えたら、`ENABLE_MOCK_EVENTS` を `"false"` に戻してデプロイし直します。

## 秘密の入れ替え

- **中継の資格情報**: アプリの設定の画面で入れ替えると、新しい値が 1 回だけ出て、前の値はすぐに使えなくなります。すぐに `pnpm wrangler secret put RELAY_TOKEN --config wrangler.jsonc` で新しい値を置きます (デプロイし直す必要はありません)。置くまでのあいだに届いたイベントは、中継の API が 401 で拒み、Worker は送り直しません (ログに `unauthorized` が出ます)。置いたら、模擬のイベントで確かめます。
- **漏れたかもしれないとき**: アプリで中継の資格情報を取り消すか入れ替えます。取り消すと、入れ替えるまで通知は届きません。
- **模擬の Webhook の鍵**: 新しい鍵を `pnpm wrangler secret put MOCK_WEBHOOK_SECRET --config wrangler.jsonc` で置き、送る側の鍵も変えます。

## やり直しの扱い

- 中継の API が混んでいるとき (409、429、5xx) は、5 秒までの待ちなら Worker の中で送り直します。長い待ちのときは、Webhook を送ってきた側へ 503 と `Retry-After` を返します。
- イベントの時刻から 1 日を過ぎたイベントは送りません (中継の API は、受け付けの記録を 7 日残し、古いイベントを拒みます)。
- 資格情報が使えない (401、403) ときと、形が違う (422 など) ときは、送り直しません。

## 開発

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build   # デプロイはしない (--dry-run)
```
