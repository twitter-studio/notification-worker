# notification-worker — エージェントの規則

この前半は、組織の共通の規則 (`twitter-studio/.github/AGENTS.md`、commit 47af325) の写し。後半の「このリポジトリ」が、このリポジトリ固有の規則。

この規則の正本は `twitter-studio/.github/AGENTS.md`。各リポジトリの `AGENTS.md` には、この規則の写しと、そのリポジトリ固有の規則と検証のコマンドを置く (下の「各リポジトリに写すもの」)。リンクだけで引き継いだとみなさない。リポジトリ固有の規則がこの規則と違うときは、リポジトリ固有の規則に、違う理由と一緒に書く。

## 目的と構成

- `tweetbot`: iOS のアプリ。裏の WKWebView で x.com を動かし、取ったデータを SwiftUI で出す (公式の X の API は使わない)。アプリ固有の規則は `tweetbot/AGENTS.md`。
- `notification-service`: 運営の通知の中継 API (Hono / Cloudflare Workers / D1 / APNs)。
- `notification-worker`: 利用者が自分の Cloudflare に置く Worker のひな形。X のイベントを中継の API へ送る。
- `notification-docs`: ADR、設計書、セットアップと運用の手順書。

通知の仕組みの設計は `notification-docs/docs/design/` の設計書が正本。運営は X の API の資格情報を集めず、X の契約も持たない。

## 実装の流れ

1. Issue の受け入れ条件、依存関係、関連する PR と ADR を読み、重なりと妨げを確かめる。
2. 外部のサービス (Cloudflare、Apple の APNs、X、パッケージ) の振る舞いは、推測せず、今の公式の文書で確かめる。確かめられないものは、確かめていないと書く。
3. 実装する。実装したら、別のコンテキストのレビュー担当 (エージェント) にレビューさせる。実装者が読み直すだけで済ませない。
4. 認証、トークン、APNs、Webhook、個人情報に関わる変更は、セキュリティのレビューも別に受ける。
5. 指摘はコードで確かめてから直す。採らない指摘は理由を残す。実際にビルドとテストを動かす。AI のレビューだけで合格にしない。
6. 設計を変えたら、ADR、OpenAPI、手順書、Issue の依存関係も一緒に直す。
7. PR に、変えたこと、実行したコマンドと結果、レビューの結果、届いていないゲート、残るリスクを書く。動かしていないチェックを通ったと書かない。

## 記述の責務

- **コードには How**: 実装の方法を、コードの構造、名前、処理で表す。
- **テストコードには What**: 期待する振る舞いと、保証する結果を書く。
- **コミットログには Why**: 変更が要る理由と、解決する問題を書く。
- **コードコメントには Why not**: ほかの案を採らない理由と、守る制約を書く。

## ワークアラウンドの追跡

OS、ライブラリ、外部のサービスの不具合や制約をワークアラウンドで避けたときは、Issue に残す (何を避けたか、どう避けたか、外せる条件)。コードのコメントにも Issue の番号を書く。恒久的な設計や妥当な設定を、ワークアラウンドとして扱わない。

## セキュリティ

- 秘密を、コード、設定のファイル (`wrangler.jsonc`、`.dev.vars` など)、ドキュメント、URL、GitHub Pages、ログ、Issue、PR、テストのフィクスチャ、スクリーンショットに残さない。値を出力しない。秘密には、APNs の `.p8` の鍵、X の資格情報と Webhook の署名の秘密、中継の資格情報、セッションのトークン、デバイストークン、D1 のデータを暗号化する鍵、Cloudflare の API トークンなどがある (この一覧に限らない)。
- 運営の DB に、X の OAuth のトークン、X の API の鍵、DM の本文、ツイートの本文、要らない X の識別子を置かない。
- 次のことは、オーナーの明示の承認を得てから行う: 課金の発生するリソースを作る、本番やプレビューへデプロイする、本番の DB に migration を当てる、権限を広げる (GitHub、Cloudflare、Apple の権限やトークンの範囲)、X の API のクレジットを買う、X の API を実際のアカウントで使う。実際の X のアカウントで X に残る操作は、各リポジトリの `AGENTS.md` が許した範囲だけで行う (tweetbot ではテスト用の @tacos_sin だけ)。
- デプロイは、保護した GitHub の Environments と、範囲を絞った Cloudflare の資格情報で行う。CodeQL と secret scanning は、使えるリポジトリで有効にする (非公開のリポジトリでは、Free プランでは使えない)。

## GitHub Actions

- 外部の Action と Docker のイメージは、完全な hash で固定し、`# v1.2.3` のように版をコメントに書く。CI の zizmor が、固定、本家の履歴にない commit、版のコメントのずれを調べる。
- `permissions` は最小にし、`actions/checkout` の資格情報を残さない (`persist-credentials: false`)。
- PR の信頼できないコードを `pull_request_target` で動かさない。`${{ github.event.* }}` などの外から入る値を `run:` に直に書かず、`env:` で渡す。`secrets: inherit` を使わない。
- 再利用の Workflow を呼ぶときは、default branch の履歴にある commit の SHA で呼ぶ。
- ツールは版で固定し、中身を確かめられる方法で入れる (`go install …@vX`、PyPI の版の固定など)。

## GitHub の運用

- ブランチは中身に合わせて `feature/`、`fix/`、`chore/`、`docs/` などで切り、`main` へ PR を出す。`main` へ直接 push しない (新しいリポジトリを作ったときの最初の README だけは、GitHub の自動の初期化を使ってよい)。
- PR は squash merge する。PR のタイトルと本文がそのまま `main` のコミットになるので、変更を足したら本文も直す。
- 文書、Issue、PR、コミットは日本語で書く。
- 設計書から作る Issue は、タイトルの頭に設計書の ID を付ける (`[API-001] …`)。どの Issue にも、受け入れ条件と依存関係 (GitHub の issue dependencies) を書く。
- Issue は、`zunda-pixel` の個人の GitHub Project (Project 8) で管理する。組織の Project は作らない。Project の番号や URL は推測せず、実際の Project を確かめてから触る。
- 共通のラベル: `type:feature`、`type:security`、`type:docs`、`type:chore`、`bug`、`status:blocked`、`needs:owner` (オーナーの判断や作業が要る。自動では進めない)、`priority:p0`、`priority:p1`。リポジトリ固有のラベル (tweetbot の `workaround` など) は、そのリポジトリの決まりで使う。
- 非公開のリポジトリでは、Free プランの Rulesets、ブランチの保護、CODEOWNERS によるレビューの依頼が効かない。上の決まりは運用で守る。

## GitHub の Codex のレビュー

- 組織に入れた Codex は、PR を開いたとき、Draft から Ready にしたとき、`@codex review` とコメントしたときにレビューする。push では走り直さない。
- レビューが付いたかを確かめ、指摘はコードで確かめてから直し、スレッドに直したコミットか、直さない理由を返す。直したあとに見てもらうときは `@codex review` とコメントし、どの commit を見たかを PR に残す。
- 使用量の上限、未設定、実行の失敗でレビューが付かないときは、指摘なしとみなさず、そのことを PR に書く。この場合は、別のコンテキストのレビュー担当のレビューと、実際のビルドとテストで判断する。

## 各リポジトリに写すもの

組織の `.github` から自動で引き継がれるのは、公開にしたときの Issue と PR のテンプレート、`CONTRIBUTING.md`、`SECURITY.md` などの community health files だけ。次のものは、各リポジトリに写して置く。

- `AGENTS.md`: この規則の写し (写した元の commit を書く) と、リポジトリ固有の規則と検証のコマンド。
- `.github/CODEOWNERS`、`.github/pull_request_template.md`。
- CI (`.github/workflows/`) と `zizmor.yml`、`.github/dependabot.yml` (cooldown をつける)。
- `LICENSE`: Apache License 2.0 (tweetbot と同じ。オーナーの判断)。

共通の規則を変えたら、各リポジトリに追従の PR を出し、写した元の commit を書く。

---

## このリポジトリ (notification-worker)

利用者が自分の Cloudflare に置く Worker のひな形。設計書の §6、§7 が対象。Issue は USER-001、X-001。約束事は `docs/adr/` (ADR-0001: 模擬の Webhook と、中継の API へ送る流れ)。中継の API との約束は、notification-service の ADR-0009。

### 検証のコマンド

Node.js と pnpm は `mise.toml` で固定している (`mise exec -- pnpm …`、または mise を有効にしたシェル)。

```sh
pnpm install --frozen-lockfile
pnpm lint        # Biome
pnpm typecheck   # wrangler types --check と tsc (本番のコードとテストで tsconfig を分けている)
pnpm test        # Vitest。workerd の上で動かす
pnpm build       # wrangler deploy --dry-run。デプロイはしない
```

### 決まり

- 道具 (Node.js、pnpm、TypeScript、Biome、Vitest、wrangler、`@cloudflare/vitest-plugin`) の版と設定は、notification-service とそろえる (notification-service の ADR-0001〜0003)。上げるときは、両方のリポジトリで上げる。
- 依存は、公開から 3 日たった版を選ぶ (`pnpm-workspace.yaml` の `minimumReleaseAge`)。インストール時のスクリプトは動かさない (`allowBuilds` で false)。
- 設定の正本は `wrangler.example.jsonc`。利用者は `wrangler.jsonc` に写して使う (コミットしない)。テスト、型、`build` は `wrangler.example.jsonc` を使う。
- 秘密 (`RELAY_TOKEN`、`MOCK_WEBHOOK_SECRET`) は、名前だけを `.dev.vars.example` に書き、値は置かない。型 (`worker-configuration.d.ts`) は `pnpm types` で作る (vars は `--strict-vars=false` で文字列の型にする。テストで値を変えるため)。`wrangler.example.jsonc` か `.dev.vars.example` を変えたら作り直す (CI が `--check` で調べる)。
- 送り先 (`RELAY_URL`) は設定だけで決め、要求の値で変えさせない。中継の API の本文で、アカウント、X の ID、トークン、文、URL を送らない (notification-service の ADR-0009)。
- Webhook の署名は、生の本文を解析する前に確かめる。時刻の幅でやり直しを拒む。
- ログには、答えの数、設定の名前、エラーの名前だけを出す。資格情報、鍵、イベントの中身、中継の API のエラーの本文を出さない。
- `ENABLE_X_ACTIVITY` は既定で `"false"`。X の規約の判断 (LEGAL-001) が通るまで、X の連携を作らない。実際の X のアカウントや X の API を使わない。
- `wrangler deploy` を `--dry-run` なしで動かさない。利用者の Cloudflare へのデプロイは、利用者が自分で行う (README の手順)。
- 名前付きの export を `src/index.ts` に置かない (Workers の別の入口として呼べてしまうため)。テストは `src/app.ts` の `handle` を、外へ送る処理を差し替えて呼ぶ。
