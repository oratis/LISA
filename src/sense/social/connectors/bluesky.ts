import crypto from "node:crypto";
import { loadSocialMedia } from "../media.js";
import type { SocialDraftContent, SocialMediaRef, SocialPlatformVariant, SocialTarget } from "../types.js";
import {
  getOpenSocialAccount,
  saveOpenSocialAccount,
  type BlueskyAccount,
} from "./accounts.js";
import { httpsOrigin, responseJson } from "./http.js";
import type {
  ConnectorPublishInput,
  ConnectorPublishResult,
  ConnectorValidation,
} from "./types.js";

const DEFAULT_SERVICE = "https://bsky.social";

function graphemeLength(value: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
}

function composeText(content: SocialDraftContent, variant?: SocialPlatformVariant): string {
  const text = variant?.text ?? content.text ?? "";
  const link = variant?.link ?? content.link;
  return link && !text.includes(link) ? `${text}${text ? "\n\n" : ""}${link}` : text;
}

export function validateBlueskyDraft(
  content: SocialDraftContent,
  variant?: SocialPlatformVariant,
): ConnectorValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = composeText(content, variant);
  const selectedIds = variant?.mediaIds;
  const media = selectedIds
    ? content.media.filter((item) => selectedIds.includes(item.id))
    : content.media;
  const images = media.filter((item) => item.kind === "image");
  const videos = media.filter((item) => item.kind === "video");
  if (graphemeLength(text) > 300) errors.push("Bluesky text exceeds 300 graphemes");
  if (!text && media.length === 0) errors.push("Bluesky post is empty");
  if (images.length > 4) errors.push("Bluesky allows at most 4 images");
  if (videos.length > 1) errors.push("Bluesky allows at most 1 video");
  if (images.length && videos.length) errors.push("Bluesky cannot mix image and video embeds");
  for (const image of images) {
    if (image.bytes > 1_000_000) errors.push(`Bluesky image ${image.id} exceeds 1,000,000 bytes`);
    if (!image.altText) warnings.push(`image ${image.id} has no alt text`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

function pdsFromSession(session: Record<string, unknown>, fallback: string): string {
  const doc = session.didDoc;
  if (!doc || typeof doc !== "object") return fallback;
  const services = (doc as { service?: unknown }).service;
  if (!Array.isArray(services)) return fallback;
  const pds = services.find(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "AtprotoPersonalDataServer",
  ) as { serviceEndpoint?: unknown } | undefined;
  return typeof pds?.serviceEndpoint === "string"
    ? httpsOrigin(pds.serviceEndpoint)
    : fallback;
}

export async function connectBlueskyAccount(
  identifier: string,
  appPassword: string,
  service: string = DEFAULT_SERVICE,
  fetchImpl: typeof fetch = fetch,
): Promise<BlueskyAccount> {
  const origin = httpsOrigin(service);
  const session = await responseJson(
    await fetchImpl(`${origin}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier, password: appPassword }),
    }),
  );
  const did = String(session.did ?? "");
  const handle = String(session.handle ?? "");
  const accessJwt = String(session.accessJwt ?? "");
  const refreshJwt = String(session.refreshJwt ?? "");
  if (!did || !handle || !accessJwt || !refreshJwt) {
    throw new Error("Bluesky returned an incomplete session");
  }
  const account: BlueskyAccount = {
    platform: "bluesky",
    id: did,
    handle,
    displayName: handle,
    service: pdsFromSession(session, origin),
    accessJwt,
    refreshJwt,
  };
  await saveOpenSocialAccount(account);
  return account;
}

async function refresh(
  account: BlueskyAccount,
  fetchImpl: typeof fetch,
): Promise<BlueskyAccount> {
  const session = await responseJson(
    await fetchImpl(`${account.service}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.refreshJwt}` },
    }),
  );
  const updated: BlueskyAccount = {
    ...account,
    accessJwt: String(session.accessJwt ?? ""),
    refreshJwt: String(session.refreshJwt ?? ""),
  };
  if (!updated.accessJwt || !updated.refreshJwt) {
    throw new Error("Bluesky refresh returned an incomplete session");
  }
  await saveOpenSocialAccount(updated);
  return updated;
}

async function authedFetch(
  account: BlueskyAccount,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<{ account: BlueskyAccount; response: Response }> {
  const send = (current: BlueskyAccount) =>
    fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${current.accessJwt}`,
      },
    });
  let response = await send(account);
  if (response.status !== 401) return { account, response };
  const updated = await refresh(account, fetchImpl);
  response = await send(updated);
  return { account: updated, response };
}

async function uploadBlob(
  account: BlueskyAccount,
  ref: SocialMediaRef,
  fetchImpl: typeof fetch,
): Promise<{ account: BlueskyAccount; blob: unknown }> {
  const result = await authedFetch(
    account,
    `${account.service}/xrpc/com.atproto.repo.uploadBlob`,
    {
      method: "POST",
      headers: { "content-type": ref.mimeType },
      body: await loadSocialMedia(ref),
    },
    fetchImpl,
  );
  const body = await responseJson(result.response);
  if (!body.blob) throw new Error("Bluesky upload did not return a blob");
  return { account: result.account, blob: body.blob };
}

function selectedMedia(content: SocialDraftContent, variant?: SocialPlatformVariant): SocialMediaRef[] {
  return variant?.mediaIds
    ? content.media.filter((item) => variant.mediaIds!.includes(item.id))
    : content.media;
}

function linkFacet(text: string, link?: string): unknown[] | undefined {
  if (!link) return undefined;
  const start = text.lastIndexOf(link);
  if (start < 0) return undefined;
  return [{
    index: {
      byteStart: Buffer.byteLength(text.slice(0, start)),
      byteEnd: Buffer.byteLength(text.slice(0, start + link.length)),
    },
    features: [{ $type: "app.bsky.richtext.facet#link", uri: link }],
  }];
}

function deterministicRecordKey(idempotencyKey: string): string {
  if (!idempotencyKey) throw new Error("Bluesky publish needs an idempotency key");
  return `lisa-${crypto
    .createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")}`;
}

function stableCreatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Bluesky publish needs a valid approval timestamp");
  }
  return new Date(timestamp).toISOString();
}

export async function publishBluesky(
  input: ConnectorPublishInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorPublishResult> {
  const found = await getOpenSocialAccount("bluesky", input.accountId);
  if (!found || found.platform !== "bluesky") throw new Error("Bluesky account is not linked");
  let account = found;
  const validation = validateBlueskyDraft(input.content, input.variant);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const text = composeText(input.content, input.variant);
  const link = input.variant?.link ?? input.content.link;
  const media = selectedMedia(input.content, input.variant);
  const images: Array<{ alt: string; image: unknown }> = [];
  let video: unknown;
  for (const ref of media) {
    const uploaded = await uploadBlob(account, ref, fetchImpl);
    account = uploaded.account;
    if (ref.kind === "image") images.push({ alt: ref.altText ?? "", image: uploaded.blob });
    else video = uploaded.blob;
  }
  const record: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: stableCreatedAt(input.createdAt),
    ...(linkFacet(text, link) ? { facets: linkFacet(text, link) } : {}),
    ...(images.length
      ? { embed: { $type: "app.bsky.embed.images", images } }
      : video
        ? { embed: { $type: "app.bsky.embed.video", video } }
        : {}),
  };
  const rkey = deterministicRecordKey(input.idempotencyKey);
  const result = await authedFetch(
    account,
    `${account.service}/xrpc/com.atproto.repo.putRecord`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: account.id,
        collection: "app.bsky.feed.post",
        rkey,
        record,
      }),
    },
    fetchImpl,
  );
  const body = await responseJson(result.response);
  const uri = String(body.uri ?? "");
  if (!uri) throw new Error("Bluesky did not return a post URI");
  return {
    ok: true,
    platformPostId: uri,
    url: `https://bsky.app/profile/${encodeURIComponent(account.handle)}/post/${encodeURIComponent(rkey)}`,
  };
}

export function blueskyCapabilities(): Record<string, unknown> {
  return {
    platform: "bluesky",
    text: { maxGraphemes: 300 },
    image: { supported: true, maxCount: 4, maxBytesEach: 1_000_000 },
    video: { supported: true, maxCount: 1 },
    link: { supported: true },
    visibility: ["public"],
    requiresConfirmation: true,
  };
}
