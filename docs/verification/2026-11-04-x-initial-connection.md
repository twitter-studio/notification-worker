# X Webhook 初期接続の検証記録

2026-11-04。関連: [RELEASE-001](https://github.com/twitter-studio/notification-docs/issues/3)。配置したコードは `1f15b7e7ebb2085ad931d880f39c8fa7b6bf0d8c`。X の受信処理は PR #5、本人認可 CLI は PR #7 でレビュー・検証済み。

## 承認と実行範囲

オーナーは、利用者側 Worker と Queue の作成、3つの secret の保存、CLI 初期配置、本人確認と Webhook 登録・CRC 検証を承認した。今回限り、保護した GitHub Environment 経由の配置規則の例外を承認した。上限は X API 10要求・既存クレジット1USD、自動検証100 HTTP要求・2時間。イベント購読・投稿取得・投稿操作・新しい D1・Cloudflare プラン変更は対象外。

旧ポータルでは課金条件を確認できず、一旦停止した。その後、追加承認に基づき新 Console に `Tweetbot Notification Sandbox` を作成した。既存の `Tweetbot Studio` が表示され、オーナーが従来の Free プロジェクトから Pay Per Use の Development へ移動した。Console はキー・token・アプリ ID が変わらないと表示した。新しいアプリは作成していない。

追加承認に基づき請求サイクル支出上限を1USDに設定し、保存成功と画面の `$1.00` を確認した。最小購入額は5USDだったため、オーナーが購入した。購入後の残高5USD、当時のサイクル支出0USD、自動チャージ利用不可を確認した。検証後の最終利用額は、ブラウザの手動操作と競合して再確認できていない。購入額と API の支出上限は別の設定。

## 作成した構成

| 項目             | 設定                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| 利用者 Worker    | `notification-worker`                                                       |
| Worker URL       | `https://notification-worker.zunda-dev.workers.dev`                         |
| Queue            | `notification-x-events`                                                     |
| Queue の保持期間 | 作成時に `86400` 秒を指定                                                   |
| consumer         | batch 1、待ち1秒、並列1、再試行5回                                          |
| 中継先           | 既存 sandbox の `notification-service.zunda-dev.workers.dev`                |
| secrets          | `X_OAUTH2_CLIENT_SECRET`、`RELAY_TOKEN`、独立した乱数の `X_EVENT_ID_SECRET` |
| 最終状態         | `ENABLE_X_ACTIVITY=false`、`ENABLE_MOCK_EVENTS=false`                       |
| 観測設定         | query を秘匿、invocation logs と traces は無効                              |

Queue の作成と `wrangler queues info notification-x-events` が成功し、producer・consumer がいずれも `notification-worker` 1件であることを確認した。secret の bulk 保存は3件成功。本人 token と App-only Bearer Token は Mac の所有者限定ファイルに保持し、Worker や運営 D1 に保存していない。中継の資格情報はオーナーがアプリで入れ替えたものを使用した。

観測設定は配置した構成の値。Cloudflare が実際に付けるログ metadata の確認は未実施。資格情報・本人の ID・認可コード・CRC token・Webhook ID・応答本文はこの記録に含めない。

## 実行結果

X API は以下の3要求だけ。各要求を送る前に、秘密を含まないローカルの要求数記録へ加算した。リダイレクトと自動再試行は無効。応答本文は64KiBまで、token はコマンド引数に渡さずメモリから HTTP header に設定した。

| 要求               | 結果                                      |
| ------------------ | ----------------------------------------- |
| `GET /2/users/me`  | 200。認可した本人アカウントとの一致を確認 |
| `GET /2/webhooks`  | 200。既存件数0                            |
| `POST /2/webhooks` | 200。登録先 URL が一致し、`valid: true`   |

登録先は `/webhooks/x`。CRC 時だけ入口を有効化し、実際の X の CRC を受け付けた。これで、今回の X の CRC token とサービスの文字種制限が適合することを確認した。すべての将来の token 形式への適合を証明したものではない。

配置と確認の順序:

1. 専用構成で `wrangler deploy --dry-run` を実行し、成功した。
2. 両入口を無効にして初期配置した。version は `f2979d1e-fb41-4282-b305-234ef5c3c3df`。
3. 3つの secret を保存した。
4. `/health` は200、`/webhooks/x` と `/webhooks/mock` は404だった。
5. X 入口だけを有効化した。version は `5a821329-d09e-4c16-8b6f-c9c4ebbca514`。
6. X に Webhook を1件登録し、`valid: true` を確認した。
7. `finally` で入口を無効に戻して再配置した。最終 version は `97ed5a2e-a7f5-4281-a09f-480a3b383448`。
8. 再び `/health` は200、両入口は404であることを確認した。

アプリへの直接の HTTP 確認は計6要求。X の API 要求3件と合わせて9要求で、Cloudflare 管理 API の CLI 操作は別途行った。初期接続は2時間以内に終了した。イベント購読は作成しておらず、Queue の実イベント処理や APNs 到達を今回確認したとはしない。

## 保持状態と次の確認

Worker、Queue、secrets、登録した Webhook を次の検証用に保持する。運営 API、D1、端末登録は変更していない。

X 入口を無効にしているため、将来の定期 CRC には404を返す。登録時の `valid: true` が維持されるとは限らない。次の承認済み検証では、入口を有効化して Webhook の状態を読み、必要なら再検証してから購読する。

残る確認は次のとおり。

- 最終利用額、残高、支出上限と自動チャージ状態の再確認。
- 本人 token の期限確認。今回の認可は `tweet.read users.read` のみで refresh token はない。
- 本人の mention・direct reply だけを対象とする期限付き購読について、費用・有効期間・解除を含めた追加承認。
- 実イベントの署名、Queue 経由の中継、APNs 到達、通知タップ。
- Queue の停滞・破棄の監視と、購読解除・失効・秘密の入れ替え・リソース削除の実運用。
- production の App Attest / APNs、招待制、公開リリースの判断。

## リポジトリの検証

記録を追加したブランチで `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`git diff --check` が成功した。workerd の58テストと OAuth CLI の19テストが通った。`build` は配置を伴わない dry-run。最初の lint は Markdown 表の整形で失敗し、Biome で整形後に再実行して成功した。

今回の PR は文書だけで、既存コードと配置したコードは同じ。リポジトリ規則上、文書のみの変更はレビュワーエージェントによるコードレビューの対象外。

## 根拠

- [Webhook API](https://docs.x.com/x-api/webhooks/introduction): 管理は App-only Bearer Token、署名と CRC は Client Secret。
- [Webhook 登録](https://docs.x.com/x-api/webhooks/create-webhook): 登録先と応答の `valid`。
- [X の料金とクレジット](https://docs.x.com/x-api/getting-started/pricing): 残高・支出上限・自動チャージ。
- [Queue の料金](https://developers.cloudflare.com/queues/platform/pricing/): 無料枠と保持期間、再試行で増える操作数。
