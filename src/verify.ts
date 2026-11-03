// 模擬の Webhook の署名 (ADR-0001)。X の Webhook の確かめ (X-001) と同じく、生の本文を解析する前に確かめる。
// 署名は `sha256=<16 進数>` で、鍵は MOCK_WEBHOOK_SECRET、対象は `<時刻 (UNIX 秒)>.<生の本文>`。

/** 署名の時刻と、受け取った時刻のずれとして許す幅。これを越える署名は、やり直し (リプレイ) として拒む。 */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** 署名の鍵の長さの下限。短い鍵は総当たりで探せるので、鍵の設定の誤りとして扱う。 */
export const MIN_SECRET_LENGTH = 32;

export async function verifyMockSignature(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: Uint8Array;
  now: Date;
}): Promise<boolean> {
  if (input.timestamp === null || !/^[0-9]{1,12}$/.test(input.timestamp)) return false;
  const seconds = Number(input.timestamp);
  if (Math.abs(input.now.getTime() / 1000 - seconds) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const hex = /^sha256=([0-9a-f]{64})$/.exec(input.signature ?? "")?.[1];
  if (hex === undefined) return false;
  const mac = new Uint8Array(32);
  for (let index = 0; index < 32; index++) {
    mac[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const prefix = new TextEncoder().encode(`${input.timestamp}.`);
  const signed = new Uint8Array(prefix.length + input.body.length);
  signed.set(prefix);
  signed.set(input.body, prefix.length);
  // HMAC は crypto.subtle.verify で比べる (かかる時間で、正しい値を探られないため)。
  return crypto.subtle.verify("HMAC", key, mac, signed);
}
