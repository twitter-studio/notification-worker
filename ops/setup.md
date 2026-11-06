# 自分のWorkerで通知を試す

対象は [USER-002 #13](https://github.com/twitter-studio/notification-worker/issues/13)。自分が所有する専用XアプリとCloudflareアカウントで、本人宛てのmention・直接replyを30分だけ購読する。DM・いいね・通常投稿は購読しない。運営へXの資格情報を渡さない。

この手順は招待制sandbox用。production APNs・App Attest、一般公開、無期限の購読は対象外。配置の自動化と保護したGitHub Environmentの実装は [OPS-003](https://github.com/twitter-studio/notification-docs/issues/11)、リリース条件は [RELEASE-001](https://github.com/twitter-studio/notification-docs/issues/3) で管理する。

## 実行前に確認する

- iPhoneのTweetbotでOS通知を許可し、中継への端末登録・所有確認を完了する。中継のURLと資格情報を手元の保護ファイルへ保存する。資格情報をチャットへ貼らない。
- Xアプリはこの試験専用にする。既存購読がなく、試験中に別のCLIやConsoleから購読を変更しない。既存アプリを流用する場合も、他の利用者や用途がないことを所有者が確認する。
- X Developer Consoleで現在の価格、クレジット残高1USD以上、請求サイクル上限1USD以下、自動チャージOFFを確認する。確認できなければ実行しない。CLIが読めるのは残高であり、上限・自動チャージの設定は本人が確認する。
- Cloudflareの現在のWorkers・Queues・Logs・Monitorsの料金と使用量を確認する。無料枠の残量をこのCLIは確認しない。新規リソース・秘密保存・配置・権限追加・実X API利用は、対象と上限を示して所有者が承認してから行う。プラン変更やクレジット購入はこの手順で自動実行しない。

2026-11-05時点のX Activity料金ではmention・replyは各0.005USD/配信イベント。購読数とAPI要求数を制限しても、第三者の投稿による配信件数を制限できない。残高の反映遅延もあるため、CLIは支出1USD以内を技術的に保証しない。Consoleの支出設定と期限付き購読を併用する。[イベント料金](https://docs.x.com/x-api/activity/event-pricing)、[クレジットAPI](https://docs.x.com/x-api/usage/get-usage-credits)。

CloudflareはWorkersの要求・CPU・ログ、Queueの書き込み・読み取り・削除に利用枠がある。Queue無料枠は現在1日10,000操作、保持は24時間。有料枠や既存使用量によって従量料金が発生する。Cronは5分ごと、1日288回。[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)、[Queues料金](https://developers.cloudflare.com/queues/platform/pricing/)。

## 1. ローカルの準備

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
cp wrangler.example.jsonc wrangler.jsonc
```

Gitの外に絶対パスのディレクトリを作り、0700にする。以下では `<保護ディレクトリ>` と表記する。ファイルは持ち主だけが読める0600で保存する。秘密をコマンド引数・環境変数・標準出力・シェル履歴に書かない。

| ファイル                              | 保存するもの                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `client-id.txt` / `client-secret.txt` | 同じ専用XアプリのOAuth 2.0 Client ID / Client Secret。値だけ                           |
| `app-bearer-token.txt`                | 同じアプリのApp-only Bearer Token。値だけ                                              |
| `relay-token.txt`                     | Tweetbotに1回だけ表示された中継資格情報。値だけ                                        |
| `event-id-secret.txt`                 | 署名秘密と独立した暗号学的乱数。32文字以上。通常の署名鍵更新では変更しない             |
| `activity-setup.json`                 | `activity-setup.example.json`をコピーし、本人ID・ユーザー名・既存Webhook ID・URLを設定 |

Client Secretを再発行すると既存接続に影響する。保存場所が不明でも、既存利用者を確認せずに再発行しない。本人IDはXアプリの所有者IDと同じとは限らない。後の `GET /2/users/me` と一致する本人を設定する。

URLはこのCLIでは `https://<Worker名>.<サブドメイン>.workers.dev/webhooks/x` のみ。クエリ・ポート・独自ドメインは受け付けない。初回のWebhook登録前は `activity-setup.json` の確定を待ち、登録後にIDを保存する。

## 2. 無効状態で配置・監視する

`wrangler.jsonc`でWorker名、アカウント、Queue名（producer/consumerの両方）、`RELAY_URL`、`X_USER_ID`を設定する。URLはアプリに出た運営APIのhttps originを正確に写す。中継資格情報が送られる先なので、第三者のURLを入力しない。X/mockの両入口はfalseに保つ。公開fetch・Cron・ログの秘匿設定・preview無効も設定例から引き継ぐ。

所有者の承認後、対象アカウントにQueueを1つ作る。保持24時間・並列1・再試行5回は設定例の範囲を維持する。新規D1は不要。Queue作成の操作例は次のとおり。アカウントと名前を確認した、範囲を絞った資格情報で実行する。

```sh
mise exec -- pnpm exec wrangler queues create notification-x-events --message-retention-period-secs 86400
```

配置は保護したGitHub Environmentと対象アカウントに限定したCloudflare資格情報で行う。保護を検査する[配置workflow](deployment.md)はあるが、実Environmentと資格情報は未設定のため、[OPS-003](https://github.com/twitter-studio/notification-docs/issues/11)が完了するまではここがゲートになる。CLI例外を使うなら、その回のQueue作成・秘密保存・初回無効配置・一時有効化・無効への復帰を所有者が明示承認する必要がある。

承認した配置経路で `RELAY_TOKEN`、`X_OAUTH2_CLIENT_SECRET`、`X_EVENT_ID_SECRET` をsecretとして保存する。各保護ファイルを標準入力から送る。Client ID と本人 token は手元に置く。App-only Bearer Token を Worker に置くのは、下の通知プレビューの照会を使う場合に限る。ログ取り込みや配置の戻り値に秘密を含めない。

無効版の稼働後に `/health` が200、X/mock入口が404、Queue件数とbytesが0を確認する。[監視手順](README.md)に従い、10分以内のheartbeat、対象Worker限定の警報と本人へのテストメール受信を確認する。通知先変更・新しい監視権限も承認範囲に含める。

## 3. Webhookを登録し、本人を認可する

XアプリをRead・Confidential clientとし、Callback URIを `http://127.0.0.1:8788/callback` にする。新しい権限・規約同意・秘密発行の最終操作は本人が行う。

配置承認に含まれる一時有効化を行い、X入口だけtrue、mockはfalseにする。X Developer Consoleでこの専用アプリのWebhookを1つ登録する。URLは自分のWorkerの `/webhooks/x`。既存登録がある場合は再利用し、他用途のWebhookを削除しない。CRCを確認してWebhook IDとURLを保護した `activity-setup.json` へ保存する。CLIはWebhookを新規登録・削除せず、既存登録の照合と必要時のCRC再検証だけを行う。[Webhook登録](https://docs.x.com/x-api/webhooks/create-webhook)、[一覧](https://docs.x.com/x-api/webhooks/get-webhook)、[CRC再検証](https://docs.x.com/x-api/webhooks/validate-webhook)。

```sh
mise exec -- node scripts/x-oauth.mjs '<保護ディレクトリの絶対パス>'
```

出力されたローカルHTMLを開き、本人アカウント・`tweet.read users.read`を確認して認可する。DM・書き込み・`offline.access`は要求しない。得たtokenは同じアプリのClient IDと一緒に `user-token.json` へ0600で保存する。既存ファイルは上書きしない。期限切れなら旧プロセスの終了を確認し、保護ディレクトリ内に退避してから認可し直す。旧CLIのClient IDなしの保存形式は使わず、現行CLIで認可し直す。tokenをCloudflareや運営へ渡さない。

## 4. 計画を確認し、30分だけ購読する

```sh
mise exec -- node scripts/x-activity-session.mjs plan '<保護ディレクトリの絶対パス>'
```

`plan`は設定とファイル権限だけを読み、通信せず、秘密も要求しない。費用の見積り・承認・Cloudflareの状態確認は行わない。

本人が実X操作を承認した後、`activity-approval.example.json`を保護ディレクトリの `activity-approval.json` へコピーする。`live_x_api` と `dedicated_app` をtrueにし、料金設定を確認した時刻を `billing_checked_at`、実行許可の期限を `expires_at` にUTCのISO8601で保存する。確認時刻は15分以内、許可期限は実行時点から45分以上2時間以内にする。これは本人の承認記録であり、権限を自動で付与する仕組みではない。本人tokenにも45分以上の残りが必要。通常要求の直前にも承認・token期限を確認し、30分の購読期限がその範囲を超える場合は作成しない。期限後の解除・不在確認は継続する。

```sh
mise exec -- node scripts/x-activity-session.mjs run '<保護ディレクトリの絶対パス>'
```

CLIは残高→本人→Webhook→既存購読を確認し、本人宛てmention/replyを各1つ作る。対象本人の既存購読が1つでもあれば作らず終了する。ページ続きがある応答も実行不可。購読には固有tagと30分の明示期限を付ける。同じ購読の再作成は既存の期限を更新し、期限省略は無期限になるため、試験中は他の管理操作を行わない。[購読作成](https://docs.x.com/x-api/activity/create-x-activity-subscription)、[購読一覧](https://docs.x.com/x-api/activity/get-x-activity-subscriptions)。

標準出力は状態、件数、期限、累積要求数のみ。`ready`の後、必要なら本人が別の公開アカウントからメンション1件、続いて本人の公開投稿への直接返信1件を投稿する。投稿とOS通知のタップは本人操作。サーバー集計・APNs受理・OS表示・タップ先を別々に記録する。同じ投稿がmention/replyの両方で配信されても通知は1件にまとめる。通知文だけでは種類を判別できない。

通常操作は最大12要求、解除も含め累積20要求。OAuth交換やConsoleでの操作はこの上限に含まれない。API要求は15秒でtimeout、応答は64KiBまで、送信先は `https://api.x.com` 固定でリダイレクトしない。エラー詳細・ID・tokenを標準出力へ出さない。

## 5. 終了・失敗時の回復

30分経過、Ctrl-C、通常エラーで今回のtag・本人・Webhook・種類が一致する購読だけを削除し、一覧で不在を確認する。応答を失った作成も一覧から発見する。`cleaned`は今回の購読不在を確認した結果であり、Worker停止や通知到達の証明ではない。[削除API](https://docs.x.com/x-api/activity/deletes-x-activity-subscription)。

`failed`では `activity-session.json` のphase・要求数・cleanedを保護ディレクトリ内で確認する。API応答本文は保存しない。再実行は新規購読を作らず、同じ台帳から解除だけを続ける。

```sh
mise exec -- node scripts/x-activity-session.mjs recover '<保護ディレクトリの絶対パス>'
```

`recover`は本人token・承認の期限切れ後もApp-only Bearer Tokenを使う。設定を入れ替えず、同じアプリ・台帳で行う。保存済みの20要求を使い切ったら追加要求をしない。Consoleで今回のtagを確認して手動解除する。削除結果が不明、一覧に続きがある、通信・認証に失敗した場合は解除済みと扱わない。期限の経過だけでも不在確認の代わりにはしない。

強制終了・電源断ではlockと台帳が残る。lock内のPIDのプロセスと、このディレクトリを使う全CLIが停止していることを確認してから、lockだけを除いて `recover` する。稼働中のlockを消さない。台帳・tag・秘密をチャットやIssueへ貼らない。台帳を消して要求数をリセットしない。次の試験は解除完了後に台帳を保護領域へ退避し、新たな承認で行う。

購読不在を確認したら、承認した配置経路でX/mockをfalseに戻す。稼働版・管理API設定・X/mock入口404・health200・Queue件数とbytesが0を確認する。停止を急ぐ場合は、先に無効化して新規受信を止める。無効中の既存jobは破棄されうる。Cloudflareへの配置ができない場合でもX購読の解除を優先する。rollback成功だけを停止の証明にしない。Cronと警報を保持するならheartbeatも確認する。

## 鍵の更新と完全な削除

| 対象                        | 計画的な更新・削除                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 中継資格情報                | 購読解除・Queue空を確認し、アプリで入れ替え、新しい値をWorker secretへ反映。本人・中継URL・資格情報が変わると旧jobは破棄される                         |
| OAuth Client Secret         | 購読解除・Queue空・入口無効にし、専用アプリで再発行。保護ファイルとWorkerを更新してCRC確認。`X_EVENT_ID_SECRET`は維持                                  |
| App-only Bearer / 本人token | X側で失効・認可取消し後、保護ファイルを更新。新しい本人tokenは最小scopeで認可し直す。token期限切れが購読解除になるとは仮定しない                       |
| イベントID鍵                | 重複判定に影響する。通常更新では変更しない。漏えい時は別の切替計画を作り、過去イベントをreplayしない                                                   |
| 全体の削除                  | 購読解除・不在確認→入口無効→Queue空→専用Webhook削除→X認可取消し→対象警報/Cron停止→専用Worker/Queue削除→不要なCloudflare資格情報取消し→ローカル秘密削除 |

漏えい時はQueueが空になるのを待たず、該当資格情報を先に失効させる。通知欠落・旧job破棄を許容して停止し、秘密の値を記録せず影響と再開条件を記録する。完全削除で共有のXアプリ、Webhook、Queue、警報、Cloudflare資格情報を消さない。リソース名・アカウント・共有有無と削除承認を確認する。iPhone側の通知登録削除はアプリで行う。

## 検証範囲

CLIはNodeの合成HTTP応答と保護ファイルで、正常終了、作成応答の喪失、期限・権限・本人・既存購読の拒否、回復・要求上限を検証する。Workerの署名・重複・Queueはworkerdで検証する。新CLIの実X接続・SIGINTによる早期解除・停止確認は [USER-003の記録](../docs/verification/2026-11-05-user-setup-cli.md) を参照。別アカウントでの初回配置・一般公開、実障害からのrecoverは未検証。過去のQA-002成功を新CLIの実接続成功として扱わない。

## 継続する購読の作成・延長・解除

自分の専用Xアプリ、本人認可、Webhookを用意し、上の手順と同じ保護ディレクトリに `activity-setup.json`、`client-id.txt`、`app-bearer-token.txt`、`user-token.json` を置く。先に利用するイベント、Xの従量料金、Cloudflareの利用量、Workerと中継先を確認する。購読の管理操作は同じXアプリに対して一度に1つずつ実行する。[Xのイベント料金](https://docs.x.com/x-api/activity/event-pricing)

```sh
mise exec -- node scripts/x-activity-subscriptions.mjs start '<保護ディレクトリの絶対パス>' --confirm '<UTCの期限>'
mise exec -- node scripts/x-activity-subscriptions.mjs status '<保護ディレクトリの絶対パス>'
mise exec -- node scripts/x-activity-subscriptions.mjs renew '<保護ディレクトリの絶対パス>' --confirm '<現在より後のUTCの期限>'
mise exec -- node scripts/x-activity-subscriptions.mjs stop '<保護ディレクトリの絶対パス>' --confirm
```

- 期限は `2026-12-01T00:00:00Z` の形式で指定する。期限を設けず開始する場合は、`start` の最後の引数を `--no-expiry` にする。
- `start` と `renew` は本人認可を使う。認可が切れたら同じアプリ・同じ本人で再認可する。延長は購読が有効なうちに実行する。[Xの購読期限と更新](https://docs.x.com/x-api/activity/introduction#subscription-expiration)
- 応答が失われたら、`status` で件数を確認し、同じ操作と期限で再実行する。途中でやめる場合は `stop` を実行する。作成・更新結果を一覧で確認できない場合、CLIは操作を保留する。期限付きなら期限到達後に停止を再確認する。無期限の場合は同じXアプリで購読が一覧に現れたかを確認する。`activity-subscriptions.json` は作成前の記録と購読IDを保存するので、完了まで保持する。プロセスが強制終了してロックが残った場合は、同じディレクトリで実行中のプロセスがないことを確認してから `activity-session.lock` を取り除く。
- `stop` が `subscriptions: 0` を返したら、記録した購読の不在を確認できた。続けてWorkerのX入口を無効にし、Queueの状態とXの利用量を確認する。Webhookを外す操作は購読解除の後に行う。すでに外した場合でも、同じApp-only Bearerで解除を続けられる。Bearerも変更済みの場合は、同じXアプリのコンソールで購読の残りを確認する。

## 通知プレビュー

1. プレビューに対応した運営 API が稼働していることを確認する。利用者 Worker を対応版へ更新し、自分の Wrangler 設定の `vars` に `ENABLE_X_NOTIFICATION_PREVIEW="true"` を追加する。共有の sandbox Workflow では未設定のままなので、プレビューは有効にならない。
2. イベントに公開投稿者の情報がない場合も表示するには、同じ X アプリの App-only Bearer Token を利用者 Worker の `X_PREVIEW_BEARER_TOKEN` secret に置く。X の利用料を確認してから設定する。Worker は情報が欠けているイベントでだけユーザー照会を1回試す。運営や GitHub にトークンを渡さない。[X の User Lookup](https://docs.x.com/x-api/users/get-user-by-id)
3. メンションと直接返信を1件ずつ送り、各端末の通知に @ユーザー名と抜粋が出ること、タップで対象の投稿が開くことを確認する。投稿者を確認できない場合は定型文で届く。

プレビュー非対応の版に戻す場合は、まず対応版のまま `ENABLE_X_NOTIFICATION_PREVIEW="false"` を反映する。利用者 Worker と運営 API の両 Queue で待機中・遅延中のジョブがなくなったことを確認してから旧版へ戻す。旧版はプレビュー付きの要求や待機ジョブを受け付けない。
