// 模擬のイベントを、自分の Worker の POST /webhooks/mock へ、署名して送る (README の「模擬のイベントで試す」)。
// 使い方: MOCK_WEBHOOK_SECRET=<鍵> node scripts/send-mock-event.mjs https://<自分の Worker>.workers.dev [種類] [post_id]
// 鍵は環境の変数で渡す (コマンドの引数に書くと、シェルの履歴に残るため)。
import { createHmac, randomUUID } from "node:crypto";

const [workerUrl, kind = "mention", postId = "1234567890123456789"] = process.argv.slice(2);
const secret = process.env.MOCK_WEBHOOK_SECRET;
if (workerUrl === undefined || secret === undefined || secret.length < 32) {
  console.error(
    "usage: MOCK_WEBHOOK_SECRET=<32 文字以上> node scripts/send-mock-event.mjs <Worker の URL> [種類] [post_id]",
  );
  process.exit(2);
}
const event = { id: randomUUID(), kind, created_at: new Date().toISOString() };
if (kind !== "follow") event.post_id = postId;
const body = JSON.stringify({ events: [event] });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

const response = await fetch(new URL("/webhooks/mock", workerUrl), {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Mock-Timestamp": timestamp,
    "X-Mock-Signature": `sha256=${signature}`,
  },
  body,
});
console.log(response.status, await response.text());
