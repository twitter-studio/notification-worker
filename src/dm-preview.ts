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

/** 上限に収めるために省いたもの。ログには、この名前だけを出す。 */
type Trimmed = "none" | "profile_image" | "name" | "key_change" | "sender";

/**
 * 上限に収まらないときに省く順。アイコンの URL、名前、鍵変更、送った人の順に省く。
 * 名前を省いても、端末は @ユーザー名を題に出す。
 * 鍵変更を送った人より先に省くのは、X Chat の鍵変更と暗号化したイベントがどちらも大きく、送った人が先に落ちると
 * 実機の X Chat ではほとんど送った人が出なかったため (2026-11-12、#75)。1 対 1 の会話の鍵はめったに変わらず、
 * 端末は本文表示の設定のときに保存した鍵変更で照合できる。鍵が変わって本文を開けないときも、端末は確かめられない
 * 送った人として出す (tweetbot #450)。
 */
function smaller(source: DmPreviewSource): [DmPreviewSource, Trimmed][] {
  const withoutImage: DmPreviewSource =
    source.sender?.profile_image_url === undefined
      ? source
      : { ...source, sender: { ...source.sender, profile_image_url: undefined } };
  const withoutName: DmPreviewSource =
    withoutImage.sender?.name === undefined
      ? withoutImage
      : { ...withoutImage, sender: { ...withoutImage.sender, name: undefined } };
  const withoutKeyChange: DmPreviewSource =
    withoutName.kind === "x_chat"
      ? { ...withoutName, conversation_key_change_event: undefined }
      : withoutName;
  const withoutSender: DmPreviewSource = { ...withoutKeyChange, sender: undefined };
  return [
    [source, "none"],
    [withoutImage, "profile_image"],
    [withoutName, "name"],
    [withoutKeyChange, "key_change"],
    [withoutSender, "sender"],
  ];
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
  let trimmed: Trimmed | "too_large" = "too_large";
  for (const [candidate, dropped] of smaller(source)) {
    const encoded = encoder.encode(JSON.stringify({ ...candidate, occurred_at: occurredAt }));
    if (encoded.length <= MAX_PLAINTEXT_BYTES) {
      plaintext = encoded;
      trimmed = dropped;
      break;
    }
    encoded.fill(0);
  }
  // 結果の名前 (何を省いたか) だけを残す。DM の種類や送った人の有無は、ログの決まり (件数、設定の名前、
  // エラーの名前だけ) の外なので出さない。
  console.info({ event: "dm_preview_sealed", outcome: trimmed });
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
