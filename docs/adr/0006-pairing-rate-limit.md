# ADR-0006: 接続の API を Durable Object の前で制限する

Status: Accepted / 2026-11-16。対象: #93。

## 背景

未認証の `/v1/pairing/challenge` が、存在しない接続コードでも配送と共有の Durable Object のトランザクションを呼んでいた。ほかの管理 API も、形だけ合う管理資格情報から保存先へ届く可能性がある。

## 決定

既存の `CONNECT_LIMITER` を `/v1/pairing` 配下の全要求に適用する。GET の版確認も保存先を読むため対象とする。`pairing:` と接続元の IP をキーに、全 API を合わせて 10 回/60 秒に制限する。IPv6 は既存の `sourceKey` で /64 にまとめる。`/connect`・`/setup`・OAuth とはキーを分ける。超過は 429 と `Retry-After: 60`、binding 未設定は 503 とし、保存先のメソッドを呼ばない。

## 採らなかった案

プロセス内の Map では別の isolate から制限を避けられる。新しい Durable Object で制限すると、保護する前にストレージ処理が増える。既存の Rate Limiting binding を再利用する。

## 影響と残る確認

[Cloudflare の仕様](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) を 2026-11-16 に確認した。拠点ごとの近似制限で、分散した接続元を含む総要求数・費用の厳密な上限ではない。共有 IP の利用者も枠を分け合う。手動の配置設定にも `CONNECT_LIMITER` が必要になる。新しい課金リソースは作らない。利用者のプランでの利用可否、稼働版の binding・namespace と WAF の有無は、実配置前に #93 / notification-docs#66 で照合する。ローカルの dry-run だけでは稼働確認にならない。
