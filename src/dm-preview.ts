import { z } from "zod";
import type { DmSender } from "./x-preview";

export const DmPreviewKey = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const SealedDmPreview = z
  .string()
  .min(39)
  .max(3400)
  .regex(/^[A-Za-z0-9_-]+$/);

export type DmPreviewSource = { sender?: DmSender | undefined } & (
  | { kind: "legacy"; excerpt?: string | undefined }
  | {
      kind: "x_chat";
      sender_id: string;
      conversation_id: string;
      conversation_key_version: string;
      encoded_event: string;
      conversation_key_change_event?: string | undefined;
    }
);

/** APNs の上限に収める平文の大きさ (12 バイトの nonce と 16 バイトの tag を足し、Base64URL にして 3400 文字以内)。 */
const MAX_PLAINTEXT_BYTES = 2522;

/**
 * 上限に収まらないときに省く順。本文を正しく出すことを、送った人を出すことより優先する。
 * アイコンの URL、送った人、鍵変更 (端末は保存済みの鍵変更で照合できる) の順に省く。
 */
function smaller(source: DmPreviewSource): DmPreviewSource[] {
  const withoutImage: DmPreviewSource =
    source.sender?.profile_image_url === undefined
      ? source
      : { ...source, sender: { ...source.sender, profile_image_url: undefined } };
  const withoutSender: DmPreviewSource = { ...withoutImage, sender: undefined };
  const withoutKeyChange: DmPreviewSource =
    withoutSender.kind === "x_chat"
      ? { ...withoutSender, conversation_key_change_event: undefined }
      : withoutSender;
  return [source, withoutImage, withoutSender, withoutKeyChange];
}

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
  let plaintext: Uint8Array | undefined;
  for (const candidate of smaller(source)) {
    const encoded = encoder.encode(JSON.stringify({ ...candidate, occurred_at: occurredAt }));
    if (encoded.length <= MAX_PLAINTEXT_BYTES) {
      plaintext = encoded;
      break;
    }
    encoded.fill(0);
  }
  if (plaintext === undefined) return undefined;
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
