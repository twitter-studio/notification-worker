# DM通知の本文表示を設定するAPI

接続APIのcapability `dm_preview_setup: true` があるWorkerで利用する。各APIはPOST、JSON、`Authorization: Bearer <接続済み端末の管理キー>` を要求する。応答は常に `Cache-Control: no-store`。運営APIへ送らない。

| パス                            | 本文                                                                                | 成功応答                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/v1/pairing/dm-preview/start`  | `route_id`（UUID）、`request_id`（UUID）、`app_state`（22〜128文字のBase64URL乱数） | 201 `{"url":"https://<このWorker>/dm-preview?state=<不透明な値>"}`                     |
| `/v1/pairing/dm-preview/finish` | 上記3項目と `key`（端末内で生成した32バイト一時鍵のBase64）                         | 200 `application/octet-stream` の暗号文（12バイトnonce + AES-GCM暗号文 + 16バイトtag） |
| `/v1/pairing/dm-preview/cancel` | 最初の3項目                                                                         | 204                                                                                    |

JSON本文は1KiB以下。PINや復元した秘密鍵は送らない。`request_id` と `app_state` は最初から最後まで同じ値を使う。Workerから受け取ったURLは、元のWorkerと同じHTTPS originで、`/dm-preview` のURLか確認してから開く。

アプリはASWebAuthenticationSessionでURLを開く。Workerが確認ページ・PKCE・ブラウザCookieを検証し、Twitterから戻った認可コードを短期間だけ保管する。戻り先は `tweetbot-worker://dm-preview?state=<app_state>`。失敗時は `error=denied` も付く。戻り先のスキーム・host・state・引数の重複を照合してから `/finish` を呼ぶ。カスタムURLに一時鍵や暗号文は載せない。

設定要求は10分で失効し、認可コードを受け取った後は20秒以内に `/finish` を呼ぶ。要求は使い切り。途中で接続解除された場合も無効。端末ごとの開始間隔は30秒以上、認証前の入口は既存の `CONNECT_LIMITER` でも制限する。

エラー: 400/422（不正な要求）、401（管理キーの形が不正）、403（読み取り認可・本人確認に失敗）、404（未対応/接続なし）、409（同アカウントの処理中）、410（期限切れ/取消/再利用）、413（サイズ超過）、429（上限）、503（上流の失敗）。アプリは機密情報を表示せず、再設定やWorker更新を案内する。

取得するのは本人のPIN復旧設定、署名公開鍵、最近20件の1対1の会話の暗号化された鍵変更。トークンや取得結果を永続保存しない。トークン交換後の本人照合を済ませてから読み取る。暗号文はTweetbotの既存 `twitter-studio/x-chat-setup/v1` の追加認証データ（本人、配送先UUID、要求UUID）に結び付く。

端末がPINで秘密鍵を復旧して公開鍵と照合した後、対象ルートのプレビュー鍵だけを設定する。通知種類と購読は変更せず、DM通知の購読はWorker接続時にDMを選択して用意する。グループ会話、新しい会話と鍵変更の自動追従は今回の対象外。新しい会話には再設定が必要。

[Xの会話一覧](https://docs.x.com/x-api/chat/get-chat-conversations)、[公開鍵](https://docs.x.com/x-api/chat/get-user-public-keys)、[会話イベント](https://docs.x.com/x-api/chat/get-chat-conversation-events)、[設計ADR-0009](https://github.com/twitter-studio/notification-docs/blob/main/docs/adr/0009-dm-preview-api-setup.md)。

会話一覧は空ページを含め最大5ページまで送り、外部要求は本人照合を含め50回以内に制限する。取得できた最近の会話を最大20件準備する。設定APIからXの購読を作成・削除しないため、途中の失敗やPIN入力のキャンセルで新しい購読は残らない。
