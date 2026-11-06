import { z } from "zod";

export const DmPreviewKey = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const SealedDmPreview = z
  .string()
  .min(39)
  .max(3400)
  .regex(/^[A-Za-z0-9_-]+$/);

export type DmPreviewSource = { kind: "legacy"; excerpt: string };

export async function dmPreviewKeyID(key: string): Promise<string> {
  const data = new TextEncoder().encode(`twitter-studio/dm-preview-key/v1\n${key}`);
  try {
    return encode(await crypto.subtle.digest("SHA-256", data));
  } finally {
    data.fill(0);
  }
}

function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function sealDmPreview({
  source,
  key,
  recipient,
  routeID,
  eventID,
  occurredAt,
}: {
  source: DmPreviewSource;
  key: string;
  recipient: string;
  routeID: string;
  eventID: string;
  occurredAt: string;
}): Promise<string | undefined> {
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(JSON.stringify({ ...source, occurred_at: occurredAt }));
  // 12-byte nonce + AES-GCM ciphertext + 16-byte tag must fit the APNs budget after encoding.
  if (plaintext.length > 2522) return undefined;
  const rawKey = Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  try {
    const encryptionKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, [
      "encrypt",
    ]);
    const additionalData = encoder.encode(
      `twitter-studio/dm-preview/v1\n${recipient}\n${routeID}\n${eventID}`,
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData },
      encryptionKey,
      plaintext,
    );
    const sealed = new Uint8Array(nonce.length + ciphertext.byteLength);
    sealed.set(nonce);
    sealed.set(new Uint8Array(ciphertext), nonce.length);
    return encode(sealed.buffer);
  } finally {
    rawKey.fill(0);
    plaintext.fill(0);
  }
}
