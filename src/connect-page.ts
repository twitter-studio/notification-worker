import type { X_NOTIFICATION_TYPES } from "./normalize";

type NotificationType = (typeof X_NOTIFICATION_TYPES)[number];

/** 名前は Tweetbot の画面に合わせる (Twitter の頃の呼び方)。 */
const names: Record<NotificationType, { en: string; ja: string }> = {
  mention: { en: "Mentions", ja: "メンション" },
  reply: { en: "Replies", ja: "返信" },
  quote: { en: "Quote Tweets", ja: "引用ツイート" },
  retweet: { en: "Retweets", ja: "リツイート" },
  like: { en: "Likes", ja: "いいね" },
  follow: { en: "New followers", ja: "新しいフォロワー" },
  dm: { en: "DMs", ja: "DM" },
};

const text = {
  en: {
    lang: "en",
    title: "Connect Tweetbot Notifications",
    warning:
      "Continue only if you tapped Connect to Worker in Tweetbot to get here. If you opened this page from another app, a website, or a message, close it.",
    worker: "Worker",
    types: "Notifications",
    dm: "DM notifications will also go through this Worker.",
    next: "Continuing opens the Twitter login. Log in with the account you are connecting.",
    continue: "Continue",
  },
  ja: {
    lang: "ja",
    title: "Tweetbotの通知をつなぐ",
    warning:
      "Tweetbotで「Workerに接続」を押して、ここに来たときだけ続けてください。ほかのアプリやWebサイト、メッセージのリンクから開いたときは、このページを閉じてください。",
    worker: "Worker",
    types: "受け取る通知",
    dm: "DMの通知も、このWorkerを通して届きます。",
    next: "続けると、Twitterのログインの画面に進みます。つなぐアカウントでログインしてください。",
    continue: "続ける",
  },
} as const;

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * `/connect` の確かめのページ。値は読み取りで形を確かめたものだけを入れるが、どれもエスケープしてから埋める。
 * スクリプトは使わない (CSP で止めている)。
 */
export function confirmationPage(
  host: string,
  types: readonly NotificationType[],
  fields: Record<string, string>,
  japanese: boolean,
): string {
  const t = japanese ? text.ja : text.en;
  const items = types
    .map((type) => `<li>${html(japanese ? names[type].ja : names[type].en)}</li>`)
    .join("");
  const hidden = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${html(name)}" value="${html(value)}">`)
    .join("");
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${html(t.title)}</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
body { margin: 0 auto; max-width: 32rem; padding: 1.5rem 1rem; line-height: 1.5; }
h1 { font-size: 1.4rem; }
.warning { font-weight: 600; }
dt { font-weight: 600; margin-top: 1rem; }
dd { margin: 0.25rem 0 0; }
ul { margin: 0; padding-left: 1.25rem; }
.dm { font-weight: 600; }
button { margin-top: 1.5rem; width: 100%; padding: 0.8rem; font-size: 1.05rem; font-weight: 600; border-radius: 0.75rem; border: none; background: #1d9bf0; color: #fff; }
</style>
</head>
<body>
<h1>${html(t.title)}</h1>
<p class="warning">${html(t.warning)}</p>
<dl>
<dt>${html(t.worker)}</dt>
<dd>${html(host)}</dd>
<dt>${html(t.types)}</dt>
<dd><ul>${items}</ul>${types.includes("dm") ? `<p class="dm">${html(t.dm)}</p>` : ""}</dd>
</dl>
<p>${html(t.next)}</p>
<form method="post" action="/connect">${hidden}<button type="submit">${html(t.continue)}</button></form>
</body>
</html>
`;
}
