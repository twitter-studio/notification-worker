import { z } from "zod";
import { readBody } from "./body";

export const PreviewHandle = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);
export const XNotificationPreview = z.strictObject({
  author: PreviewHandle,
  excerpt: z.string().min(1).max(280),
});

const Profile = z.object({
  id: z.string(),
  username: PreviewHandle.optional().catch(undefined),
  protected: z.boolean().optional(),
});
const MAX_EXCERPT_LENGTH = 280;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function excerptOf(text: string | undefined): string | undefined {
  const line = text
    ?.replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cs}\p{Bidi_Control}]/gu, "")
    .trim();
  if (!line) return undefined;
  if (line.length <= MAX_EXCERPT_LENGTH) return line;
  let end = 0;
  for (const { segment, index } of graphemes.segment(line)) {
    if (index + segment.length >= MAX_EXCERPT_LENGTH) break;
    end = index + segment.length;
  }
  return end === 0 ? undefined : `${line.slice(0, end).trimEnd()}…`;
}

export type PreviewSource = { authorID: string; excerpt: string; author: string | undefined };

async function lookupPreviewAuthor(
  authorID: string,
  bearer: string,
  fetch: typeof globalThis.fetch,
) {
  const url = new URL(`https://api.x.com/2/users/${authorID}`);
  url.searchParams.set("user.fields", "protected");
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const body = await readBody(response, 8192);
    if (body === undefined) return undefined;
    const json: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
    const parsed = z.object({ data: Profile }).safeParse(json);
    if (parsed.success && parsed.data.data.id === authorID && parsed.data.data.protected === false)
      return parsed.data.data.username;
  } catch {
    return undefined;
  }
  return undefined;
}

export async function resolvePreview(
  source: PreviewSource | undefined,
  bearer: string | undefined,
  fetch: typeof globalThis.fetch,
): Promise<z.infer<typeof XNotificationPreview> | undefined> {
  if (source === undefined) return undefined;
  const author =
    source.author ??
    (bearer ? await lookupPreviewAuthor(source.authorID, bearer, fetch) : undefined);
  return author === undefined ? undefined : { author, excerpt: source.excerpt };
}

export function previewSourceFor(
  payload: {
    author_id: string;
    possibly_sensitive?: boolean | undefined;
    text?: string | undefined;
  },
  users: readonly unknown[],
): PreviewSource | undefined {
  if (payload.possibly_sensitive === true) return undefined;
  const excerpt = excerptOf(payload.text);
  if (excerpt === undefined) return undefined;

  let author: string | undefined;
  for (const user of users) {
    const profile = Profile.safeParse(user);
    if (!profile.success || profile.data.id !== payload.author_id) continue;
    if (profile.data.protected === true) return undefined;
    if (profile.data.protected === false) author ??= profile.data.username;
  }
  return { authorID: payload.author_id, author, excerpt };
}
