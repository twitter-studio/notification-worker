// 模擬の Webhook の署名の鍵を作り、コミットしない .dev.vars の MOCK_WEBHOOK_SECRET の行に書く (README の「模擬のイベントで試す」)。
// 鍵は画面に出さない (シェルの履歴やログに残さないため)。前の行があれば置き換え、ファイルは持ち主だけが読める権限にする。
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const path = ".dev.vars";
const secret = randomBytes(32).toString("base64url");
const lines = existsSync(path)
  ? readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("MOCK_WEBHOOK_SECRET="))
  : [];
while (lines.at(-1) === "") lines.pop();
lines.push(`MOCK_WEBHOOK_SECRET=${secret}`, "");
writeFileSync(path, lines.join("\n"), { mode: 0o600 });
// すでにあったファイルは、書いても権限が変わらないので、直す。
chmodSync(path, 0o600);
console.log("MOCK_WEBHOOK_SECRET を .dev.vars に書きました (値は表示しません)。");
