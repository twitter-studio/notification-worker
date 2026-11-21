import { z } from "zod";
import { discardBody } from "./body";
import { readJSON } from "./x-subscriptions";

export type Authorization = {
  refreshToken: string;
  scopes: string[];
  expiresAt: number;
  next: number;
  failures: number;
  attempt?: string;
};

const Token = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().min(60).max(86400),
  scope: z.string().max(1024).optional(),
});
const OAuthError = z.object({ error: z.literal("invalid_grant") });

type Result =
  | { kind: "refreshed"; grant: Authorization }
  | { kind: "retry" }
  | { kind: "reauthorize" };

export async function refreshAuthorization(grant: Authorization, env: Env): Promise<Result> {
  if (!env.X_OAUTH2_CLIENT_ID || !env.X_OAUTH2_CLIENT_SECRET) return { kind: "retry" };
  const encode = (value: string) => encodeURIComponent(value).replaceAll("%20", "+");
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${encode(env.X_OAUTH2_CLIENT_ID)}:${encode(env.X_OAUTH2_CLIENT_SECRET)}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refreshToken }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  if (!response) return { kind: "retry" };
  const body = await readJSON(response);
  await discardBody(response);
  if (response.status === 400 && OAuthError.safeParse(body).success) return { kind: "reauthorize" };
  if (response.status !== 200) return { kind: "retry" };
  const parsed = Token.safeParse(body);
  // 成功応答では旧refresh tokenが無効になりうるため、不正な応答の後に旧値を再使用しない。
  if (!parsed.success) return { kind: "reauthorize" };
  const scopes = parsed.data.scope?.split(" ") ?? grant.scopes;
  if (!grant.scopes.every((scope) => scopes.includes(scope))) return { kind: "reauthorize" };
  return {
    kind: "refreshed",
    grant: {
      refreshToken: parsed.data.refresh_token,
      scopes,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
      next: Date.now() + Math.min(90 * 60_000, parsed.data.expires_in * 750),
      failures: 0,
    },
  };
}
