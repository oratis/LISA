import { loadSocialMedia } from "../media.js";
import type { SocialDraftContent, SocialMediaRef, SocialPlatformVariant } from "../types.js";
import {
  getOpenSocialAccount,
  saveOpenSocialAccount,
  type MastodonAccount,
} from "./accounts.js";
import { httpsOrigin, responseJson } from "./http.js";
import type {
  ConnectorPublishInput,
  ConnectorPublishResult,
  ConnectorValidation,
} from "./types.js";

function composeText(content: SocialDraftContent, variant?: SocialPlatformVariant): string {
  const text = variant?.text ?? content.text ?? "";
  const link = variant?.link ?? content.link;
  return link && !text.includes(link) ? `${text}${text ? "\n\n" : ""}${link}` : text;
}

function selectedMedia(content: SocialDraftContent, variant?: SocialPlatformVariant): SocialMediaRef[] {
  return variant?.mediaIds
    ? content.media.filter((item) => variant.mediaIds!.includes(item.id))
    : content.media;
}

export function validateMastodonDraft(
  content: SocialDraftContent,
  variant?: SocialPlatformVariant,
): ConnectorValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = composeText(content, variant);
  const media = selectedMedia(content, variant);
  if ([...text].length > 500) {
    errors.push("Mastodon text exceeds the conservative 500-character limit");
  }
  if (!text && media.length === 0) errors.push("Mastodon status is empty");
  if (media.length > 4) errors.push("Mastodon allows at most 4 media attachments");
  for (const ref of media) {
    if (ref.kind === "image" && !ref.altText) warnings.push(`image ${ref.id} has no alt text`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export async function connectMastodonAccount(
  instance: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MastodonAccount> {
  const origin = httpsOrigin(instance);
  const body = await responseJson(
    await fetchImpl(`${origin}/api/v1/accounts/verify_credentials`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  );
  const remoteId = String(body.id ?? "");
  const acct = String(body.acct ?? body.username ?? "");
  if (!remoteId || !acct) throw new Error("Mastodon returned an incomplete account");
  const handle = acct.includes("@") ? `@${acct}` : `@${acct}@${new URL(origin).host}`;
  const account: MastodonAccount = {
    platform: "mastodon",
    id: `${origin}|${remoteId}`,
    handle,
    displayName: String(body.display_name ?? "") || handle,
    instance: origin,
    accessToken,
  };
  await saveOpenSocialAccount(account);
  return account;
}

async function uploadMedia(
  account: MastodonAccount,
  ref: SocialMediaRef,
  fetchImpl: typeof fetch,
): Promise<string> {
  const form = new FormData();
  const bytes = await loadSocialMedia(ref);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: ref.mimeType }), `${ref.id}.bin`);
  if (ref.altText) form.append("description", ref.altText);
  const response = await fetchImpl(`${account.instance}/api/v2/media`, {
    method: "POST",
    headers: { authorization: `Bearer ${account.accessToken}` },
    body: form,
  });
  const body = await responseJson(response);
  const id = String(body.id ?? "");
  if (!id) throw new Error("Mastodon media upload returned no id");
  if (response.status !== 202) return id;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const status = await responseJson(
      await fetchImpl(`${account.instance}/api/v1/media/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${account.accessToken}` },
      }),
    );
    if (status.url) return id;
  }
  throw new Error(`Mastodon media ${id} did not finish processing`);
}

export async function publishMastodon(
  input: ConnectorPublishInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorPublishResult> {
  const found = await getOpenSocialAccount("mastodon", input.accountId);
  if (!found || found.platform !== "mastodon") throw new Error("Mastodon account is not linked");
  const validation = validateMastodonDraft(input.content, input.variant);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const mediaIds: string[] = [];
  for (const ref of selectedMedia(input.content, input.variant)) {
    mediaIds.push(await uploadMedia(found, ref, fetchImpl));
  }
  const form = new URLSearchParams();
  const text = composeText(input.content, input.variant);
  if (text) form.set("status", text);
  for (const id of mediaIds) form.append("media_ids[]", id);
  if (input.target.visibility) form.set("visibility", input.target.visibility);
  if (input.target.scheduledAt) form.set("scheduled_at", input.target.scheduledAt);
  const options = input.variant?.options ?? input.target.options ?? {};
  if (typeof options.sensitive === "boolean") form.set("sensitive", String(options.sensitive));
  if (typeof options.spoilerText === "string") form.set("spoiler_text", options.spoilerText);
  if (typeof options.language === "string") form.set("language", options.language);
  const body = await responseJson(
    await fetchImpl(`${found.instance}/api/v1/statuses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${found.accessToken}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": input.idempotencyKey,
      },
      body: form,
    }),
  );
  const id = String(body.id ?? "");
  if (!id) throw new Error("Mastodon did not return a status id");
  return {
    ok: true,
    platformPostId: id,
    url: typeof body.url === "string" ? body.url : undefined,
  };
}

export function mastodonCapabilities(): Record<string, unknown> {
  return {
    platform: "mastodon",
    text: { conservativeMaxCharacters: 500, instanceMayVary: true },
    image: { supported: true },
    video: { supported: true },
    link: { supported: true },
    maxMediaCount: 4,
    visibility: ["public", "unlisted", "private", "direct"],
    scheduling: true,
    requiresConfirmation: true,
  };
}
