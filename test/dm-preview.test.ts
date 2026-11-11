import { afterEach, describe, expect, it, vi } from "vitest";
import { type DmPreviewSource, sealDmPreview } from "../src/dm-preview";

const recipient = "1111111111111111111";
const routeID = crypto.randomUUID();
const eventID = `x2_${"E".repeat(43)}`;
const occurredAt = new Date().toISOString();
const key = new Uint8Array(32).fill(3);
const encodedKey = btoa(String.fromCharCode(...key))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/, "");
const budget = 2522;
const sender = {
  id: "5555555555555555555",
  name: "Example Name",
  username: "example",
  profile_image_url: "https://pbs.twimg.com/profile_images/1/example_normal.jpg",
};

async function open(sealed: string | undefined) {
  if (sealed === undefined) return undefined;
  const bytes = Uint8Array.from(atob(sealed.replaceAll("-", "+").replaceAll("_", "/")), (value) =>
    value.charCodeAt(0),
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(
        `twitter-studio/dm-preview/v1\n${recipient}\n${routeID}\n${eventID}`,
      ),
    },
    await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]),
    bytes.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

const bytesOf = (source: DmPreviewSource) =>
  new TextEncoder().encode(JSON.stringify({ ...source, occurred_at: occurredAt })).length;

/** `shape` の平文がちょうど上限になる X Chat の暗号化イベントの長さで、送った人と鍵変更の付いた中身を作る。 */
function chatFitting(shape: (source: DmPreviewSource) => DmPreviewSource): DmPreviewSource {
  const base = (length: number): DmPreviewSource => ({
    kind: "x_chat",
    sender_id: sender.id,
    conversation_id: `${recipient}:${sender.id}`,
    conversation_key_version: "1",
    encoded_event: "e".repeat(length),
    conversation_key_change_event: "k".repeat(400),
    sender,
  });
  return base(budget - bytesOf(shape(base(0))));
}

describe("DM の暗号化した中身の大きさ", () => {
  afterEach(() => vi.restoreAllMocks());

  it("何を省いたかだけをログに残し、中身は出さない", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const source = chatFitting((value) => ({
      ...value,
      sender: { ...sender, profile_image_url: undefined },
      conversation_key_change_event: undefined,
    }));
    await sealDmPreview({ source, key: encodedKey, recipient, routeID, eventID, occurredAt });
    expect(info).toHaveBeenCalledWith({
      event: "dm_preview_sealed",
      kind: "x_chat",
      sender: true,
      trimmed: "key_change",
    });
    const logged = JSON.stringify(info.mock.calls);
    for (const value of [sender.id, sender.name, sender.username, recipient, "kkkk"])
      expect(logged).not.toContain(value);
  });

  const seal = (source: DmPreviewSource) =>
    sealDmPreview({ source, key: encodedKey, recipient, routeID, eventID, occurredAt });

  it("上限に収まれば、送った人と鍵変更をそのまま入れる", async () => {
    const source = chatFitting((value) => value);
    expect(await open(await seal(source))).toEqual({ ...source, occurred_at: occurredAt });
  });

  it("収まらなければ、まずアイコンの URL を省く", async () => {
    const source = chatFitting((value) => ({
      ...value,
      sender: { ...sender, profile_image_url: undefined },
    }));
    const plain = await open(await seal(source));
    expect(plain.sender).toEqual({ id: sender.id, name: sender.name, username: sender.username });
    expect(plain.conversation_key_change_event).toBe("k".repeat(400));
  });

  it("それでも収まらなければ、鍵変更を省き、送った人は残す", async () => {
    const source = chatFitting((value) => ({
      ...value,
      sender: { ...sender, profile_image_url: undefined },
      conversation_key_change_event: undefined,
    }));
    const plain = await open(await seal(source));
    expect(plain.sender).toEqual({ id: sender.id, name: sender.name, username: sender.username });
    expect(plain).not.toHaveProperty("conversation_key_change_event");
  });

  it("鍵変更を省いても収まらなければ、送った人も省く", async () => {
    const source = chatFitting((value) => ({
      ...value,
      sender: undefined,
      conversation_key_change_event: undefined,
    }));
    const plain = await open(await seal(source));
    expect(plain).not.toHaveProperty("sender");
    expect(plain).not.toHaveProperty("conversation_key_change_event");
    expect(plain.encoded_event).toBe(source.kind === "x_chat" ? source.encoded_event : "");
  });

  it("本文だけでも収まらなければ送らない", async () => {
    const source = chatFitting((value) => ({
      ...value,
      sender: undefined,
      conversation_key_change_event: undefined,
    }));
    if (source.kind !== "x_chat") throw new Error("Expected X Chat");
    expect(await seal({ ...source, encoded_event: `${source.encoded_event}e` })).toBeUndefined();
  });
});
