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

export function excerptOf(text: string | undefined): string | undefined {
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

type Actor = { authorID: string; author: string | undefined };
export type PreviewSource = Actor &
  ({ kind: "excerpt"; excerpt: string } | { kind: "post"; postID: string; postAuthorID: string });

export const PostPreviewFields = z.object({
  text: z.string().optional().catch(undefined),
  possibly_sensitive: z.boolean().optional().catch(true),
  scopes: z.unknown().optional(),
  withheld: z.unknown().optional(),
});
const PostIdentity = z.object({ id: z.string() });
const ExpandedPost = PostPreviewFields.extend({ id: z.string(), author_id: z.string() });
const PublicPostScopes = z.strictObject({ followers: z.literal(false) });

export function isRestrictedPost(post: z.infer<typeof PostPreviewFields>): boolean {
  return (
    post.possibly_sensitive === true ||
    (post.scopes != null && !PublicPostScopes.safeParse(post.scopes).success) ||
    post.withheld != null
  );
}

function observeLookup(
  purpose: "dm_sender" | undefined,
  outcome:
    | "found"
    | "http_error"
    | "invalid_response"
    | "unavailable_profile"
    | "timeout"
    | "transport_error",
  status?: number,
): void {
  console.info({
    event: "x_preview_lookup",
    ...(purpose === undefined ? {} : { purpose }),
    outcome,
    ...(status === undefined ? {} : { status }),
  });
}

async function lookup<T>(
  url: URL,
  bearer: string,
  schema: z.ZodType<T>,
  usable: (data: T) => boolean,
  fetch: typeof globalThis.fetch,
  purpose?: "dm_sender",
): Promise<T | undefined> {
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
      observeLookup(purpose, "http_error", status);
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    const body = await readBody(response, 8192);
    if (body === undefined) {
      observeLookup(purpose, "invalid_response", status);
      return undefined;
    }
    const json: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      observeLookup(purpose, "invalid_response", status);
      return undefined;
    }
    if (!usable(parsed.data)) {
      observeLookup(purpose, "unavailable_profile", status);
      return undefined;
    }
    observeLookup(purpose, "found", status);
    return parsed.data;
  } catch {
    observeLookup(
      purpose,
      signal.aborted ? "timeout" : status === undefined ? "transport_error" : "invalid_response",
      status,
    );
    return undefined;
  }
}

/** DM の送った人。端末の鍵で暗号化した中身にだけ入れ、中継には平文で送らない。 */
export type DmSender = {
  id: string;
  name?: string | undefined;
  username: string;
  profile_image_url?: string | undefined;
};
const DmSenderProfile = z.object({
  id: z.string(),
  name: z.string().optional().catch(undefined),
  username: PreviewHandle,
  profile_image_url: z.string().optional().catch(undefined),
});
const MAX_DISPLAY_NAME_LENGTH = 100;

/** 表示名から制御文字と書字方向の制御を除く。X の表示名は 50 文字までなので、長すぎるものは使わない。 */
function displayNameOf(name: string | undefined): string | undefined {
  const line = name
    ?.replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cs}\p{Bidi_Control}]/gu, "")
    .trim();
  return line && line.length <= MAX_DISPLAY_NAME_LENGTH ? line : undefined;
}

/** アイコンは X の画像の配信元の https の URL だけを使う (端末がこの URL から画像を取る)。 */
function profileImageOf(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    // 正規化で百分率符号化されて伸びることがあるので、端末が受ける長さは正規化の後に見る。
    return url.href.length <= 512 &&
      url.protocol === "https:" &&
      url.hostname === "pbs.twimg.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.startsWith("/profile_images/") &&
      url.search === "" &&
      url.hash === ""
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** ユーザーの記録 (User Lookup の `data`、Webhook の `users[id].data`) から、DM の送った人を読む。 */
export function dmSenderFrom(senderID: string, value: unknown): DmSender | undefined {
  const profile = DmSenderProfile.safeParse(value);
  if (!profile.success || profile.data.id !== senderID) return undefined;
  const name = displayNameOf(profile.data.name);
  const image = profileImageOf(profile.data.profile_image_url);
  return {
    id: senderID,
    username: profile.data.username,
    ...(name === undefined ? {} : { name }),
    ...(image === undefined ? {} : { profile_image_url: image }),
  };
}

/**
 * DM の送った人の名前、@ユーザー名、アイコンを引く。暗号化して受け手の端末にだけ届けるので、
 * 公開投稿のプレビューと違って、鍵付きのアカウントも除かない (受け手は DM で相手をもう知っている)。
 */
export async function lookupDmSender(
  senderID: string,
  bearer: string,
  fetch: typeof globalThis.fetch,
): Promise<DmSender | undefined> {
  const url = new URL(`https://api.x.com/2/users/${senderID}`);
  url.searchParams.set("user.fields", "profile_image_url");
  const response = await lookup(
    url,
    bearer,
    z.object({ data: z.unknown() }),
    ({ data }) => dmSenderFrom(senderID, data) !== undefined,
    fetch,
    "dm_sender",
  );
  return response === undefined ? undefined : dmSenderFrom(senderID, response.data);
}

export async function resolvePreview(
  source: PreviewSource | undefined,
  bearer: string | undefined,
  fetch: typeof globalThis.fetch,
  allowPostLookup: boolean,
): Promise<z.infer<typeof XNotificationPreview> | undefined> {
  if (source === undefined) return undefined;
  if (source.kind === "post" && (!bearer || !allowPostLookup)) return undefined;
  const [author, excerpt] = await Promise.all([
    source.author ?? (bearer ? lookupPreviewAuthor(source.authorID, bearer, fetch) : undefined),
    source.kind === "excerpt"
      ? source.excerpt
      : bearer && lookupPostExcerpt(source.postID, source.postAuthorID, bearer, fetch),
  ]);
  return author === undefined || !excerpt ? undefined : { author, excerpt };
}

async function lookupPreviewAuthor(
  authorID: string,
  bearer: string,
  fetch: typeof globalThis.fetch,
) {
  const url = new URL(`https://api.x.com/2/users/${authorID}`);
  url.searchParams.set("user.fields", "protected");
  const response = await lookup(
    url,
    bearer,
    z.object({ data: Profile }).refine(({ data }) => data.id === authorID),
    ({ data }) => data.protected === false && data.username !== undefined,
    fetch,
  );
  return response?.data.username;
}

async function lookupPostExcerpt(
  postID: string,
  postAuthorID: string,
  bearer: string,
  fetch: typeof globalThis.fetch,
) {
  const url = new URL(`https://api.x.com/2/tweets/${postID}`);
  url.searchParams.set("post.fields", "possibly_sensitive,scopes,withheld");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "protected");
  const response = await lookup(
    url,
    bearer,
    z.object({ data: ExpandedPost, includes: z.object({ users: z.array(Profile) }) }),
    ({ data, includes }) =>
      data.id === postID &&
      data.author_id === postAuthorID &&
      data.possibly_sensitive === false &&
      !isRestrictedPost(data) &&
      includes.users.some(
        ({ id, protected: isProtected }) => id === postAuthorID && isProtected === false,
      ) &&
      !includes.users.some(
        ({ id, protected: isProtected }) => id === postAuthorID && isProtected === true,
      ),
    fetch,
  );
  return excerptOf(response?.data.text);
}

function previewActor(authorID: string, users: readonly unknown[]): Actor | undefined {
  let author: string | undefined;
  for (const user of users) {
    const profile = Profile.safeParse(user);
    if (!profile.success || profile.data.id !== authorID) continue;
    if (profile.data.protected === true) return undefined;
    if (profile.data.protected === false) author ??= profile.data.username;
  }
  return { authorID, author };
}

export function previewSourceFor(
  payload: z.infer<typeof PostPreviewFields> & { author_id: string },
  users: readonly unknown[],
): PreviewSource | undefined {
  if (isRestrictedPost(payload)) return undefined;
  const excerpt = excerptOf(payload.text);
  const actor = previewActor(payload.author_id, users);
  return excerpt === undefined || actor === undefined
    ? undefined
    : { ...actor, kind: "excerpt", excerpt };
}

export function previewSourceForReferencedPost({
  actorID,
  postID,
  postAuthorID,
  users,
  tweets,
}: {
  actorID: string;
  postID: string;
  postAuthorID: string;
  users: readonly unknown[];
  tweets: readonly unknown[];
}): PreviewSource | undefined {
  const actor = previewActor(actorID, users);
  const postAuthor = previewActor(postAuthorID, users);
  if (actor === undefined || postAuthor === undefined) return undefined;
  const matches = tweets.filter((tweet) => PostIdentity.safeParse(tweet).data?.id === postID);
  if (matches.length > 1) return undefined;
  if (matches.length === 1) {
    const post = ExpandedPost.safeParse(matches[0]).data;
    if (post?.author_id !== postAuthorID || isRestrictedPost(post)) return undefined;
    if (post.possibly_sensitive === false && postAuthor.author !== undefined) {
      const excerpt = excerptOf(post.text);
      if (excerpt !== undefined) return { ...actor, kind: "excerpt", excerpt };
    }
  }
  return { ...actor, kind: "post", postID, postAuthorID };
}
