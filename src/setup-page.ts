import { html } from "./connect-page";

export type SetupMessage =
  | "start"
  | "ready"
  | "ready_blocked"
  | "not_valid"
  | "crc_failed"
  | "limit"
  | "url_rejected"
  | "duplicate"
  | "create_failed"
  | "not_allowed"
  | "denied"
  | "expired"
  | "restart"
  | "rate_limited"
  | "unavailable";

/** ページの題と説明。名前は Tweetbot の画面に合わせる (Twitter の頃の呼び方)。 */
const messages: Record<SetupMessage, { en: [string, string]; ja: [string, string] }> = {
  start: {
    en: [
      "Set Up Notifications",
      "Log in with Twitter to register this Worker's webhook with your developer app. Only accounts allowed on this Worker can set it up.",
    ],
    ja: [
      "通知の設定",
      "Twitterでログインすると、このWorkerのWebhookを開発者アプリに登録します。設定できるのは、このWorkerで許可したアカウントだけです。",
    ],
  },
  ready: {
    en: ["Webhook Ready", "Twitter verified this Worker. You can now connect from Tweetbot."],
    ja: ["Webhookを用意しました", "TwitterがこのWorkerを確かめました。Tweetbotから接続できます。"],
  },
  ready_blocked: {
    en: [
      "Webhook Ready",
      "Twitter verified this Worker, but Tweetbot cannot connect until you fix X_WEBHOOK_ID below.",
    ],
    ja: [
      "Webhookを用意しました",
      "TwitterがこのWorkerを確かめましたが、下のX_WEBHOOK_IDを直すまで、Tweetbotから接続できません。",
    ],
  },
  not_valid: {
    en: [
      "Webhook Not Verified",
      "The webhook is registered, but Twitter could not verify this Worker. Check the client secret, then open this page again.",
    ],
    ja: [
      "Webhookを確かめられませんでした",
      "Webhookは登録してありますが、TwitterがこのWorkerを確かめられませんでした。Client Secretを確かめてから、このページを開き直してください。",
    ],
  },
  crc_failed: {
    en: [
      "Webhook Not Registered",
      "Twitter could not verify this Worker. Check the client secret, then open this page again.",
    ],
    ja: [
      "Webhookを登録できませんでした",
      "TwitterがこのWorkerを確かめられませんでした。Client Secretを確かめてから、このページを開き直してください。",
    ],
  },
  limit: {
    en: [
      "Webhook Not Registered",
      "Your developer app already has as many webhooks as it can. Delete a webhook you no longer use in the developer console, then open this page again.",
    ],
    ja: [
      "Webhookを登録できませんでした",
      "開発者アプリのWebhookが上限に達しています。使っていないWebhookを開発者コンソールで削除してから、このページを開き直してください。",
    ],
  },
  url_rejected: {
    en: [
      "Webhook Not Registered",
      "Twitter did not accept this Worker's URL as a webhook. Open this page from the Worker's workers.dev URL or custom domain, without a port.",
    ],
    ja: [
      "Webhookを登録できませんでした",
      "TwitterがこのWorkerのURLをWebhookとして受け付けませんでした。Workerのworkers.devのURLか独自ドメインで、ポートを付けずにこのページを開いてください。",
    ],
  },
  duplicate: {
    en: [
      "Webhook Not Registered",
      "Your developer app already has a webhook for this URL, but this Worker could not find it. If this Worker already uses it, set X_WEBHOOK_ID to its ID below. Otherwise, delete it in the developer console and open this page again. Deleting a webhook stops deliveries to it.",
    ],
    ja: [
      "Webhookを登録できませんでした",
      "開発者アプリに、このURLのWebhookがすでにありますが、このWorkerからは見つけられませんでした。このWorkerがすでに使っているものなら、下のIDをX_WEBHOOK_IDに入れてください。そうでなければ、開発者コンソールで削除してから、このページを開き直してください。削除すると、そのWebhookへの配送は止まります。",
    ],
  },
  create_failed: {
    en: ["Webhook Not Registered", "Twitter did not accept the webhook. Try again later."],
    ja: [
      "Webhookを登録できませんでした",
      "TwitterがWebhookを受け付けませんでした。しばらくしてからやり直してください。",
    ],
  },
  not_allowed: {
    en: ["Not Allowed", "This Twitter account is not allowed to set up this Worker."],
    ja: ["設定できません", "このTwitterアカウントでは、このWorkerを設定できません。"],
  },
  denied: {
    en: ["Login Cancelled", "The Twitter login was cancelled. Open this page again to retry."],
    ja: [
      "ログインを取り消しました",
      "Twitterのログインを取り消しました。やり直すときは、このページを開き直してください。",
    ],
  },
  expired: {
    en: ["Login Expired", "The login took too long. Open this page again to retry."],
    ja: [
      "ログインの期限が切れました",
      "ログインに時間がかかりすぎました。やり直すときは、このページを開き直してください。",
    ],
  },
  restart: {
    en: ["Start Again", "Open this page again and log in from the same browser."],
    ja: [
      "初めからやり直してください",
      "このページを開き直し、同じブラウザでログインしてください。",
    ],
  },
  rate_limited: {
    en: ["Too Many Attempts", "Wait a minute, then open this page again."],
    ja: ["試した回数が多すぎます", "1分ほど待ってから、このページを開き直してください。"],
  },
  unavailable: {
    en: ["Could Not Reach Twitter", "Try again later."],
    ja: ["Twitterにつながりませんでした", "しばらくしてからやり直してください。"],
  },
};

const labels = {
  en: {
    worker: "Worker",
    webhook: "Webhook",
    id: "Webhook ID",
    created: "Registered now",
    existing: "Already registered",
    different:
      "X_WEBHOOK_ID is set to a different webhook, and connections use it. Remove X_WEBHOOK_ID or set it to the webhook ID above.",
    invalidSetting:
      "X_WEBHOOK_ID is not a webhook ID, so Tweetbot cannot connect. Remove X_WEBHOOK_ID or set it to the webhook ID above.",
    others: "Webhooks on your developer app",
    valid: "verified",
    invalid: "not verified",
    login: "Log In with Twitter",
  },
  ja: {
    worker: "Worker",
    webhook: "Webhook",
    id: "WebhookのID",
    created: "今登録しました",
    existing: "登録済みでした",
    different:
      "X_WEBHOOK_IDに別のWebhookが設定されていて、接続ではそちらを使います。X_WEBHOOK_IDを消すか、上のWebhookのIDにしてください。",
    invalidSetting:
      "X_WEBHOOK_IDの値がWebhookのIDの形でないので、Tweetbotから接続できません。X_WEBHOOK_IDを消すか、上のWebhookのIDにしてください。",
    others: "開発者アプリのWebhook",
    valid: "確かめ済み",
    invalid: "確かめられていない",
    login: "Twitterでログイン",
  },
} as const;

export type SetupDetails = {
  host: string;
  webhook?: {
    url: string;
    id: string;
    created: boolean;
    /** `X_WEBHOOK_ID` の値と、この Webhook の ID の関係。 */
    configured: "none" | "same" | "different" | "invalid";
  };
  others?: readonly { id: string; url: string; valid: boolean | undefined }[];
  /** ログインを始めるフォームの、確かめの値。 */
  confirm?: string;
};

/**
 * `/setup` のページ。値はどれもエスケープしてから埋める。スクリプトは使わない (CSP で止めている)。
 * ほかの Webhook の URL は、ログインして許可したアカウントだと確かめた後にだけ出す。
 */
export function setupPage(message: SetupMessage, details: SetupDetails, japanese: boolean): string {
  const language = japanese ? "ja" : "en";
  const [title, body] = messages[message][language];
  const label = labels[language];
  const rows: string[] = [`<dt>${label.worker}</dt><dd>${html(details.host)}</dd>`];
  if (details.webhook !== undefined) {
    const { url, id, created, configured } = details.webhook;
    rows.push(
      `<dt>${label.webhook}</dt><dd>${html(url)}<br>${html(created ? label.created : label.existing)}</dd>`,
      `<dt>${label.id}</dt><dd>${html(id)}</dd>`,
    );
    if (configured === "different") rows.push(`<dd class="warning">${html(label.different)}</dd>`);
    if (configured === "invalid")
      rows.push(`<dd class="warning">${html(label.invalidSetting)}</dd>`);
  }
  if (details.others !== undefined && details.others.length > 0) {
    const items = details.others
      .map(
        ({ id, url, valid }) =>
          `<li>${html(url)} (${html(label.id)}: ${html(id)}, ${html(valid === true ? label.valid : label.invalid)})</li>`,
      )
      .join("");
    rows.push(`<dt>${label.others}</dt><dd><ul>${items}</ul></dd>`);
  }
  const form =
    details.confirm === undefined
      ? ""
      : `<form method="post" action="/setup"><input type="hidden" name="confirm" value="${html(details.confirm)}"><button type="submit">${html(label.login)}</button></form>`;
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${html(title)}</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
body { margin: 0 auto; max-width: 32rem; padding: 1.5rem 1rem; line-height: 1.5; }
h1 { font-size: 1.4rem; }
dt { font-weight: 600; margin-top: 1rem; }
dd { margin: 0.25rem 0 0; overflow-wrap: anywhere; }
ul { margin: 0; padding-left: 1.25rem; }
.warning { font-weight: 600; }
button { margin-top: 1.5rem; width: 100%; padding: 0.8rem; font-size: 1.05rem; font-weight: 600; border-radius: 0.75rem; border: none; background: #1d9bf0; color: #fff; }
</style>
</head>
<body>
<h1>${html(title)}</h1>
<p>${html(body)}</p>
<dl>${rows.join("")}</dl>
${form}
</body>
</html>
`;
}
