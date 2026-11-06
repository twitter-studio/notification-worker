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

function observeLookup(
  outcome:
    | "found"
    | "http_error"
    | "invalid_response"
    | "unavailable_profile"
    | "timeout"
    | "transport_error",
  status?: number,
): void {
  console.info({ event: "x_preview_lookup", outcome, ...(status === undefined ? {} : { status }) });
}

async function lookupPreviewAuthor(
  authorID: string,
  bearer: string,
  fetch: typeof globalThis.fetch,
) {
  const url = new URL(`https://api.x.com/2/users/${authorID}`);
  url.searchParams.set("user.fields", "protected");
  const signal = AbortSignal.timeout(1000);
  let status: number | undefined;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      // Workers は "error" を実装していない (#33)。manual で Location を追わず、3xx は下で拒否する。
      redirect: "manual",
      signal,
    });
    status = response.status;
    if (!response.ok) {
      observeLookup("http_error", status);
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    const body = await readBody(response, 8192);
    if (body === undefined) {
      observeLookup("invalid_response", status);
      return undefined;
    }
    const json: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
    const parsed = z.object({ data: Profile }).safeParse(json);
    if (!parsed.success || parsed.data.data.id !== authorID) {
      observeLookup("invalid_response", status);
      return undefined;
    }
    const { username, protected: isProtected } = parsed.data.data;
    if (isProtected !== false || username === undefined) {
      observeLookup("unavailable_profile", status);
      return undefined;
    }
    observeLookup("found", status);
    return username;
  } catch {
    observeLookup(
      signal.aborted ? "timeout" : status === undefined ? "transport_error" : "invalid_response",
      status,
    );
    return undefined;
  }
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
