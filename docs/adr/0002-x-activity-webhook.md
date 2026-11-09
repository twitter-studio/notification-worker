# ADR-0002: XAAの受信、本人宛ての正規化、永続Queue

Status: Accepted / 2026-11-04。規約判断: [notification-docs ADR-0002](https://github.com/twitter-studio/notification-docs/blob/main/docs/adr/0002-x-integration-eligibility.md)。

## 背景

オーナーがXへの照会なしで進めると判断し、LEGAL-001を完了した。Xから個別許可を取得した記録ではない。最初の実装は本人宛てのmention・直接replyに限り、実API接続・購読・課金・配置・有効化・公開は別承認とする。

XAAの署名とCRCは模擬Webhookの独自形式と異なる。XはWebhookに10秒以内の応答を求める一方、中継APIの送信は最大60秒、既存のクライアントは70秒まで待つ。この処理をHTTP受信中に完了させない。

## 決定

- `GET /webhooks/x`でCRC、`POST /webhooks/x`でXAAの1イベントを受ける。`ENABLE_X_ACTIVITY`が厳密に`"true"`のときだけ有効。既定はfalse、無効時は全メソッドで404。
- OAuth 2.0 client secretの公式ヘッダーだけをHMAC-SHA256で検証する。鍵は`X_OAUTH2_CLIENT_SECRET`。legacyヘッダーやbearerへのfallbackを設けない。正規Base64のMACを、生の本文に対してWebCryptoで検証してからUTF-8・JSONを解析する。本文は16 KiBまで。CRCは1つの非空`crc_token`を1024文字まで受け、HMACとno-storeを返す。サービスの入力制約としてASCII英数字と`_+/=-`だけを許可し、JSONの構造文字や空白を拒む。同じ鍵とHMAC形式を使うCRCが任意のJSON本文へPOST署名を発行することを防ぐため。公式文書はtokenの文字種を明示しておらず、これはサービス側の制約で、実際のXのchallengeとの互換性は実接続ゲートで確認する。秘密は32文字以上を必要とする。
- `data.event_type`が`post.mention.create`または`post.reply.create`のときだけ送る。設定`X_USER_ID`と`data.filter.user_id`が一致し、投稿者が本人以外で、mentionの宛先かreplyの`in_reply_to_user_id`が本人と一致することを必要とする。必要なフィールドが欠けたら422。知らない種類、別人宛て、自己発信は200で数えるだけにする。
- [旧 Account Activity API の資料にある再送完了通知](https://docs.x.com/x-api/account-activity/quickstart#job-completed-messages)の形式を、投稿イベントとは別に扱う。署名済みで、`replay_job_status` だけを持ち、状態が `Complete` または `Incomplete` のときは HTTP 200 を返す。Queue には送らず、状態だけを記録する。汎用 Webhook の再送でも同じ形式が届くかは [#35](https://github.com/twitter-studio/notification-worker/issues/35) で確認する。
- 追加の通知は配送先ごとに種類を指定する。Worker は署名済みイベントを本人に絞り、いいねとフォローでは宛先を payload でも確認する。Queue の再送時にも現行の設定を照合する。メンションと直接返信の既存の重複判定は維持し、追加の種類はイベントの種類と元イベントの識別子を使って同じアカウント内で重複を除く。
- DM には端末のアカウント経路を必須とする。従来 DM と X Chat の受信を定型文で知らせる。本文・暗号文・会話トークンは Queue や中継に含めない。通知を開いた端末で本人の受信箱を表示する。
- 時刻は署名対象内の`data.created_at`を使う。1日より古い、5分より先のイベントは送らない。Xに独自の時刻署名ヘッダーを要求しない。
- 重複除去IDは独立した`X_EVENT_ID_SECRET`によるHMACを正規Base64URLにした`x2_…`。入力に用途・本人・ツイートIDを結び付け、種類・配信UUIDと時刻は使わない。当初の`x1_`は種類を含めていたが、同じ投稿を二重に通知するため[ADR-0004](0004-post-notification-dedup.md)で変更した。同じ投稿作成の再送でもIDを変えない。中継のアカウント単位の重複除去と7日の保持期間に対して、送り手の再送期限は1日とする。署名鍵の入れ替えで重複除去IDを変えないため、2つの秘密は共用しない。
- 認証済みの最小イベントと、取得できた場合は公開投稿のプレビューを利用者側Queue `notification-x-events`へ保存する。投稿全文・数値のXユーザーID・X資格情報・Webhookの生データをQueueや運営へ入れない。資格情報の取り違えを防ぐため、本人・送り先・中継資格情報の用途別ハッシュをjobへ結び付ける。値をログに出さない。
- Queueの保存成功後だけHTTP 200を返す。保存が失敗するか8秒で終わらなければ503。タイムアウト後に保存が完了する場合も、同じIDで重複を除く。中継へのfetchやsleepをHTTP処理中に行わない。
- Queue consumerは1件・並列1で処理し、中継のaccepted/duplicateでackする。待機要求にはRetry-Afterを縮めず最大1日まで反映し、設定の失敗 (送り先の誤り、つながらない) にも再試行する。資格情報が使えない (401、403) ときは、再試行せずに破棄する (2026-11-09 に変更。当初は認証の失敗も再試行していたが、中継の約束 ([notification-service ADR-0007](https://github.com/twitter-studio/notification-service/blob/main/docs/adr/0007-relay-credentials.md)、[ADR-0009](https://github.com/twitter-studio/notification-service/blob/main/docs/adr/0009-relay-notifications.md)) に合わせた。#48)。中継が受けない答え (413、415、422) も ADR-0009 ではやり直さないものだが、今の分類では、やり直す一覧にない 5xx (501、52x など) と同じ `rejected` に入るので、再試行を続ける。最大6回の処理で破棄し、固定の理由だけをログに残す。無効化・不正job・期限切れはackして停止する。本人ID・中継資格情報・送り先のいずれかを変更したjobは別アカウントへ送らず破棄する。
- Queue保持は配置時に1日へ設定する。無料プランは1日固定。consumerにもイベント時刻の期限を置く。DLQは作らず、期限切れ・上限の破棄を記録する。無損失配送を保証する構成ではない。
- 中継へのglobal `fetch`は`global_fetch_strictly_public`を指定し、公開Internetと同じ経路で送る。同じアカウントのWorkerへ送る場合も、URLに対応するWorkerとCloudflareのセキュリティ設定を通す。送り先は引き続き`RELAY_URL`から決め、リダイレクトは追わない。利用者と運営が別アカウントになる構成を保つため、運営WorkerへのService bindingは要求しない。
- 型はWranglerで再生成する。新規Queueと秘密の発行・実配置は、この実装の検証には含めない。

## 採らなかった案

- 受信中に中継へ送り終える。10秒の応答要件と中継の最大待ち時間が合わない。
- `waitUntil`だけでHTTP 200を先に返す。応答後の失敗を永続的に再送できない。
- メモリだけで重複を除く。再起動と複数isolateで失われる。
- ツイートIDをそのままevent IDにする。ADR-0001の先回り重複登録への対策を満たさない。
- 配信UUIDを唯一の重複除去キーにする。配信IDが変わった場合も同じ作成イベントを重複として扱いたい。
- 旧AAAやlegacy署名にも対応する。今回の対象はXAAとOAuth 2.0に絞る。

## 影響と残る実環境ゲート

模擬の入口と再送方式は変えない。XAA用に利用者側Queueが1つ必要になる。実接続前に対象アカウント・Xアプリ・本人ID・OAuth同意・費用上限・監視・削除を確認する。Queueと秘密を用意し、フラグを入れるには別の実行承認が必要。今回の実署名は合成鍵を使い、Xによる配信や10秒以内の実環境応答は未確認。

## 公式資料（2026-11-04確認）

- [XAA envelope、mention・replyのpayload](https://docs.x.com/x-api/activity/event-payloads)
- [XAAのOAuth認可](https://docs.x.com/x-api/activity/introduction#event-privacy-and-authentication)
- [Webhookの応答要件と署名](https://docs.x.com/x-api/webhooks/introduction)
- [CRCと署名の手順](https://docs.x.com/x-api/webhooks/quickstart)
- [Cloudflare Queuesの設定](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Queueのack・retry](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
- [Queueの期限と遅延上限](https://developers.cloudflare.com/queues/platform/limits/)
- [Worker間のfetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [公開経路でのglobal fetch](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)

## アカウントと端末ごとの配送先

オーナーの複数アカウント・複数端末対応の要望を受け、通常配送では任意の秘密 `X_RELAY_ROUTES` を使えるようにする。署名済みの受信者に設定された配送先だけを選び、端末ごとに独立した Queue メッセージを作る。配送先の設定方法は[本番セットアップ](../../ops/production-setup.md#複数の-x-アカウントや端末に届ける)を参照する。

配送先 ID は端末内のアカウントに結び付く UUID。中継のイベントにはこの ID だけを追加し、X の受信者 ID と中継資格情報は Queue やイベント本文に入れない。Queue の照合値には配送先 ID も含める。配送先の変更や削除後に古いメッセージを別の端末へ送らないため。端末によって Queue の保存結果が分かれたときは Webhook の再送で補い、同じイベント ID で端末ごとに重複を除く。

複数配送先を設定しない構成と期限付きの公開試験では、従来の単一配送先と Queue の形式を使う。
従来形式のメッセージは、本人・URL・資格情報が一致する配送先が一つだけ残っていれば、その配送先 ID を付けて処理する。設定変更だけで配送待ちの通知を失わないようにする。古い Worker へ戻す場合は、購読を解除し、新形式のメッセージを処理して Queue を空にしてから戻す。
