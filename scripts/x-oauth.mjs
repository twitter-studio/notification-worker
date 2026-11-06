import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const baseScopes = ["tweet.read", "users.read"];
export class OAuthFailure extends Error {
  constructor() {
    super("x_oauth_failed");
  }
}
function checkDirectory(directory) {
  const info = lstatSync(directory);
  if (
    !isAbsolute(directory) ||
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  )
    throw new OAuthFailure();
}
function readCredential(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 4096
    )
      throw new OAuthFailure();
    const value = readFileSync(fd, "utf8").trim();
    if (!/^[\x21-\x7e]{1,4096}$/.test(value)) throw new OAuthFailure();
    return value;
  } finally {
    closeSync(fd);
  }
}
const Token = z.object({
  access_token: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9._~+/-]+=*$/),
  token_type: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.literal("bearer")),
  expires_in: z.number().int().min(1).max(7200),
  scope: z.string(),
  refresh_token: z.never().optional(),
});
async function readToken(response, scopes) {
  if (!response.ok || !response.body) throw new OAuthFailure();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) {
      await reader.cancel();
      throw new OAuthFailure();
    }
    chunks.push(value);
  }
  const value = Token.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const granted = value.scope.split(" ");
  if (granted.length !== scopes.length || !scopes.every((scope) => granted.includes(scope)))
    throw new OAuthFailure();
  return value;
}
function page(response, status, message) {
  const script = "history.replaceState(null,'','/complete')";
  const hash = createHash("sha256").update(script).digest("base64");
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    Connection: "close",
    "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; frame-ancestors 'none'`,
  });
  response.end(`<!doctype html><meta charset="utf-8"><script>${script}</script><p>${message}</p>`);
}

export async function runOAuth({
  directory,
  port = 8788,
  timeoutMs = 300000,
  fetchImpl = fetch,
  onReady = () => {},
  signal,
  likes = false,
  dm = false,
}) {
  const scopes = [...baseScopes, ...(likes ? ["like.read"] : []), ...(dm ? ["dm.read"] : [])];
  let output;
  let htmlPath;
  let htmlIdentity;
  let succeeded = false;
  const tokenPath = join(directory, "user-token.json");
  const abort = new AbortController();
  const server = createServer();
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  // token交換は10秒まで待つため、先にcallbackのsocketを切らない。
  server.setTimeout(15000);
  let timer;
  let cancel;
  try {
    if (signal?.aborted) throw new OAuthFailure();
    checkDirectory(directory);
    const clientID = readCredential(join(directory, "client-id.txt"));
    const secret = readCredential(join(directory, "client-secret.txt"));
    // 保存先を先に予約し、以前のtokenやsymlinkを上書きしない。
    output = openSync(
      tokenPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let used = false;
    let finished = false;
    const done = Promise.withResolvers();
    void done.promise.catch(() => {});
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      abort.abort();
      if (error) done.reject(new OAuthFailure());
      else done.resolve({ tokenPath });
    };
    cancel = () => finish(true);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    server.on("error", () => finish(true));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    if (finished) throw new OAuthFailure();
    const address = server.address();
    if (!address || typeof address === "string") throw new OAuthFailure();
    const origin = `http://127.0.0.1:${address.port}`;
    const callbackURL = `${origin}/callback`;
    server.on("request", (request, response) => {
      void (async () => {
        if (
          request.method !== "GET" ||
          request.headers.host !== `127.0.0.1:${address.port}` ||
          !request.url ||
          request.url.length > 8192
        ) {
          page(response, 400, "Invalid callback.");
          return;
        }
        let url;
        try {
          url = new URL(request.url, origin);
        } catch {
          page(response, 400, "Invalid callback.");
          return;
        }
        if (url.origin !== origin || url.pathname !== "/callback") {
          page(response, 404, "Not found.");
          return;
        }
        const received = url.searchParams.getAll("state");
        if (
          received.length !== 1 ||
          !/^[A-Za-z0-9_-]{43}$/.test(received[0]) ||
          !timingSafeEqual(Buffer.from(received[0]), Buffer.from(state))
        ) {
          page(response, 400, "Invalid state.");
          return;
        }
        if (used || finished) {
          page(response, 409, "Authorization already handled.");
          return;
        }
        used = true;
        const codes = url.searchParams.getAll("code");
        if (
          url.searchParams.has("error") ||
          codes.length !== 1 ||
          !codes[0] ||
          codes[0].length > 4096
        ) {
          page(response, 400, "Authorization declined.");
          finish(true);
          return;
        }
        const formPart = (value) => new URLSearchParams({ v: value }).toString().slice(2);
        const basic = Buffer.from(`${formPart(clientID)}:${formPart(secret)}`).toString("base64");
        const result = await fetchImpl("https://api.x.com/2/oauth2/token", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basic}`,
          },
          body: new URLSearchParams({
            code: codes[0],
            client_id: clientID,
            grant_type: "authorization_code",
            redirect_uri: callbackURL,
            code_verifier: verifier,
          }),
        });
        const token = await readToken(result, scopes);
        if (finished) return;
        writeFileSync(
          output,
          `${JSON.stringify({ access_token: token.access_token, client_id: clientID, token_type: token.token_type, scope: scopes.join(" "), expires_at: Date.now() + token.expires_in * 1000 })}\n`,
        );
        fsyncSync(output);
        succeeded = true;
        page(response, 200, "Authorization saved. You can close this page.");
        finish(false);
      })().catch(() => {
        if (!response.headersSent && !response.destroyed)
          page(response, 502, "Authorization failed.");
        finish(true);
      });
    });
    const authorize = new URL("https://x.com/i/oauth2/authorize");
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientID,
      redirect_uri: callbackURL,
      scope: scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    htmlPath = join(directory, `authorize-${randomBytes(16).toString("hex")}.html`);
    const htmlFD = openSync(
      htmlPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    htmlIdentity = fstatSync(htmlFD);
    try {
      writeFileSync(
        htmlFD,
        `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><a href="${authorize.href.replaceAll("&", "&amp;")}">Xの本人認可を開く</a>`,
      );
    } finally {
      closeSync(htmlFD);
    }
    timer = setTimeout(() => finish(true), timeoutMs);
    await onReady({ htmlPath, authorizeURL: authorize.href, callbackURL });
    return await done.promise;
  } catch {
    throw new OAuthFailure();
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
    abort.abort();
    server.close();
    server.closeAllConnections();
    if (htmlPath && htmlIdentity) {
      try {
        const current = lstatSync(htmlPath);
        if (current.ino === htmlIdentity.ino && current.dev === htmlIdentity.dev)
          unlinkSync(htmlPath);
      } catch {}
    }
    if (output !== undefined) {
      const original = fstatSync(output);
      closeSync(output);
      if (!succeeded) {
        try {
          const current = lstatSync(tokenPath);
          if (current.ino === original.ino && current.dev === original.dev) unlinkSync(tokenPath);
        } catch {}
      }
    }
  }
}
if (import.meta.main) {
  const [directory, ...extra] = process.argv.slice(2);
  if (
    !directory ||
    extra.some((option) => option !== "--likes" && option !== "--dm") ||
    new Set(extra).size !== extra.length
  ) {
    console.error(
      "usage: node scripts/x-oauth.mjs <owner-only credential directory> [--likes] [--dm]",
    );
    process.exitCode = 2;
  } else {
    const interrupted = new AbortController();
    const stop = () => interrupted.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const result = await runOAuth({
        directory,
        likes: extra.includes("--likes"),
        dm: extra.includes("--dm"),
        signal: interrupted.signal,
        onReady: ({ htmlPath }) => {
          console.log(`認可待ち: ${htmlPath}（5分以内。コード・tokenは表示しません）`);
        },
      });
      console.log(`認可を保護ファイルへ保存しました: ${result.tokenPath}`);
    } catch {
      console.error(
        "X OAuthに失敗しました。資格情報と設定を確認して再実行してください（値は表示しません）。",
      );
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}
