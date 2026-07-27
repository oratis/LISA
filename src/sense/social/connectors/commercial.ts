import type {
  SocialDraftContent,
  SocialPlatformVariant,
  SocialTarget,
} from "../types.js";
import type { ConnectorValidation } from "./types.js";

export type CommercialPlatform =
  | "threads"
  | "instagram"
  | "linkedin"
  | "x"
  | "tiktok"
  | "youtube"
  | "facebook";

export interface CommercialAdapterProfile {
  platform: CommercialPlatform;
  connectorId: string;
  displayName: string;
  accountKinds: string[];
  oauthScopes: string[];
  externalGates: string[];
  mediaTransfer: "public-url" | "direct-upload" | "resumable-upload" | "mixed";
  versionPolicy: string;
  pricingNotice?: string;
  officialDocs: string[];
}

export interface CommercialReadinessInput {
  oauthClientConfigured: boolean;
  redirectOriginConfigured: boolean;
  platformReviewApproved: boolean;
  businessVerificationComplete?: boolean;
  publicMediaStagingConfigured?: boolean;
  youtubeAuditApproved?: boolean;
  tiktokAuditApproved?: boolean;
  xPaidAccessConfirmed?: boolean;
}

export interface CommercialReadiness {
  platform: CommercialPlatform;
  state: "draft-only" | "private-test-only" | "ready";
  blockers: string[];
  notices: string[];
}

export interface CommercialPublishStep {
  operation: string;
  method: "GET" | "POST" | "PUT";
  endpoint: string;
  purpose: string;
  carriesMediaBytes?: boolean;
}

const META_VERSION_POLICY =
  "Resolve a supported Graph API version at connector release time; never silently float versions.";

export const COMMERCIAL_ADAPTER_PROFILES: Record<
  CommercialPlatform,
  CommercialAdapterProfile
> = {
  threads: {
    platform: "threads",
    connectorId: "threads-official",
    displayName: "Threads",
    accountKinds: ["Threads user"],
    oauthScopes: ["threads_basic", "threads_content_publish"],
    externalGates: ["Meta app review"],
    mediaTransfer: "public-url",
    versionPolicy: META_VERSION_POLICY,
    officialDocs: [
      "https://developers.facebook.com/docs/threads/posts",
      "https://developers.facebook.com/docs/threads/get-started",
    ],
  },
  instagram: {
    platform: "instagram",
    connectorId: "instagram-official",
    displayName: "Instagram",
    accountKinds: ["Instagram Business", "Instagram Creator"],
    oauthScopes: ["instagram_basic", "instagram_content_publish"],
    externalGates: ["Meta app review", "Professional account eligibility"],
    mediaTransfer: "public-url",
    versionPolicy: META_VERSION_POLICY,
    officialDocs: [
      "https://developers.facebook.com/docs/instagram-platform/content-publishing",
    ],
  },
  linkedin: {
    platform: "linkedin",
    connectorId: "linkedin-official",
    displayName: "LinkedIn",
    accountKinds: ["Member", "Organization"],
    oauthScopes: ["w_member_social", "w_organization_social"],
    externalGates: ["LinkedIn product access", "Organization role check"],
    mediaTransfer: "direct-upload",
    versionPolicy:
      "Pin a supported YYYYMM Linkedin-Version and rotate before its sunset; always send X-Restli-Protocol-Version: 2.0.0.",
    officialDocs: [
      "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
    ],
  },
  x: {
    platform: "x",
    connectorId: "x-official",
    displayName: "X",
    accountKinds: ["X user"],
    oauthScopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    externalGates: ["Paid API tier/quota"],
    mediaTransfer: "mixed",
    versionPolicy: "Pin X API v2 endpoints and capability-test the paid project at runtime.",
    pricingNotice: "Publishing and media requests may consume paid X API quota.",
    officialDocs: [
      "https://docs.x.com/x-api/posts/create-post",
      "https://docs.x.com/x-api/media/upload-media",
    ],
  },
  tiktok: {
    platform: "tiktok",
    connectorId: "tiktok-official",
    displayName: "TikTok",
    accountKinds: ["TikTok creator"],
    oauthScopes: ["user.info.basic", "video.publish", "video.upload"],
    externalGates: [
      "Content Posting API product approval",
      "Direct Post audit for non-private visibility",
      "Verified media URL prefix for PULL_FROM_URL",
    ],
    mediaTransfer: "mixed",
    versionPolicy: "Capability-query creator_info immediately before every confirmation.",
    officialDocs: [
      "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
      "https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide",
    ],
  },
  youtube: {
    platform: "youtube",
    connectorId: "youtube-official",
    displayName: "YouTube",
    accountKinds: ["YouTube channel"],
    oauthScopes: ["https://www.googleapis.com/auth/youtube.upload"],
    externalGates: ["Google OAuth verification", "YouTube API audit for public uploads"],
    mediaTransfer: "resumable-upload",
    versionPolicy: "Use YouTube Data API v3 and resumable sessions with status reconciliation.",
    officialDocs: [
      "https://developers.google.com/youtube/v3/docs/videos/insert",
      "https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol",
    ],
  },
  facebook: {
    platform: "facebook",
    connectorId: "facebook-pages-official",
    displayName: "Facebook Pages",
    accountKinds: ["Facebook Page"],
    oauthScopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
    externalGates: ["Meta app review", "Business verification", "Page role check"],
    mediaTransfer: "mixed",
    versionPolicy: META_VERSION_POLICY,
    officialDocs: [
      "https://developers.facebook.com/docs/pages-api/posts",
      "https://developers.facebook.com/docs/pages-api/getting-started",
    ],
  },
};

export function evaluateCommercialReadiness(
  platform: CommercialPlatform,
  input: CommercialReadinessInput,
): CommercialReadiness {
  const profile = COMMERCIAL_ADAPTER_PROFILES[platform];
  const blockers: string[] = [];
  const notices: string[] = [];
  if (!input.oauthClientConfigured) blockers.push("OAuth client is not configured");
  if (!input.redirectOriginConfigured) blockers.push("canonical HTTPS OAuth redirect is not configured");
  if (!input.platformReviewApproved) blockers.push("platform product/app review is not approved");
  if (
    ["threads", "instagram", "facebook"].includes(platform) &&
    !input.businessVerificationComplete
  ) {
    blockers.push("Meta business verification is incomplete");
  }
  if (
    profile.mediaTransfer === "public-url" &&
    !input.publicMediaStagingConfigured
  ) {
    blockers.push("privacy-scoped public media staging is not configured");
  }
  if (platform === "x" && !input.xPaidAccessConfirmed) {
    blockers.push("X paid API access/quota is not confirmed");
  }
  if (platform === "youtube" && !input.youtubeAuditApproved) {
    notices.push("unverified YouTube API projects can upload only private videos");
  }
  if (platform === "tiktok" && !input.tiktokAuditApproved) {
    notices.push("unaudited TikTok clients can publish only private content");
  }
  if (blockers.length) return { platform, state: "draft-only", blockers, notices };
  if (notices.length) return { platform, state: "private-test-only", blockers, notices };
  return { platform, state: "ready", blockers, notices };
}

function textFor(content: SocialDraftContent, variant?: SocialPlatformVariant): string {
  return variant?.text ?? content.text ?? "";
}

function mediaFor(content: SocialDraftContent, variant?: SocialPlatformVariant) {
  return variant?.mediaIds
    ? content.media.filter((item) => variant.mediaIds!.includes(item.id))
    : content.media;
}

function option(
  target: SocialTarget,
  variant: SocialPlatformVariant | undefined,
  key: string,
): unknown {
  return variant?.options?.[key] ?? target.options?.[key];
}

export function validateCommercialDraft(
  platform: CommercialPlatform,
  target: SocialTarget,
  content: SocialDraftContent,
  variant?: SocialPlatformVariant,
): ConnectorValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = textFor(content, variant);
  const media = mediaFor(content, variant);
  if (platform === "threads" && [...text].length > 500) {
    errors.push("Threads text exceeds 500 characters");
  }
  if (platform === "instagram") {
    if (media.length === 0) errors.push("Instagram publishing requires image or video media");
    if (media.length > 10) errors.push("Instagram carousel exceeds 10 items");
    if ([...text].length > 2200) errors.push("Instagram caption exceeds 2200 characters");
    if (content.link) warnings.push("Instagram feed captions do not provide a clickable link attachment");
  }
  if (platform === "linkedin" && [...text].length > 3000) {
    errors.push("LinkedIn commentary exceeds the conservative 3000-character limit");
  }
  if (platform === "x") {
    if ([...text].length > 280) errors.push("X post exceeds the standard 280-character limit");
    if (media.length > 4) errors.push("X post exceeds 4 media items");
    warnings.push("X API publishing may consume paid quota");
  }
  if (platform === "tiktok") {
    if (media.length === 0) errors.push("TikTok requires video or photo media");
    for (const key of ["privacyLevel", "disableComment", "disableDuet", "disableStitch"]) {
      if (option(target, variant, key) == null) errors.push(`TikTok requires ${key} from creator-aware confirmation UI`);
    }
  }
  if (platform === "youtube") {
    if (media.length !== 1 || media[0]?.kind !== "video") {
      errors.push("YouTube requires exactly one video");
    }
    const title = variant?.title ?? content.title ?? "";
    if (!title) errors.push("YouTube title is required");
    if ([...title].length > 100) errors.push("YouTube title exceeds 100 characters");
    if ([...(variant?.description ?? content.description ?? "")].length > 5000) {
      errors.push("YouTube description exceeds 5000 characters");
    }
    for (const key of ["privacyStatus", "categoryId", "madeForKids"]) {
      if (option(target, variant, key) == null) errors.push(`YouTube requires ${key}`);
    }
  }
  if (platform === "facebook" && !target.accountId) {
    errors.push("Facebook publishing requires a Page account, not a personal profile");
  }
  if (!text && !content.link && !content.title && media.length === 0) {
    errors.push(`${COMMERCIAL_ADAPTER_PROFILES[platform].displayName} post is empty`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function commercialPublishPlan(
  platform: CommercialPlatform,
  hasMedia: boolean,
): CommercialPublishStep[] {
  switch (platform) {
    case "threads":
      return [
        { operation: "create-container", method: "POST", endpoint: "/{threads-user-id}/threads", purpose: hasMedia ? "Create IMAGE/VIDEO/CAROUSEL container from staged public URL" : "Create TEXT container" },
        { operation: "publish-container", method: "POST", endpoint: "/{threads-user-id}/threads_publish", purpose: "Publish creation_id" },
      ];
    case "instagram":
      return [
        { operation: "create-container", method: "POST", endpoint: "/{ig-user-id}/media", purpose: "Create image, reel, or carousel container from staged public URL" },
        { operation: "poll-container", method: "GET", endpoint: "/{creation-id}?fields=status_code", purpose: "Wait for media processing" },
        { operation: "publish-container", method: "POST", endpoint: "/{ig-user-id}/media_publish", purpose: "Publish creation_id" },
      ];
    case "linkedin":
      return [
        ...(hasMedia ? [{ operation: "initialize-upload", method: "POST" as const, endpoint: "/rest/images?action=initializeUpload or /rest/videos?action=initializeUpload", purpose: "Obtain upload URL and media URN" }] : []),
        ...(hasMedia ? [{ operation: "upload-media", method: "PUT" as const, endpoint: "{uploadUrl}", purpose: "Upload bytes", carriesMediaBytes: true }] : []),
        { operation: "create-post", method: "POST", endpoint: "/rest/posts", purpose: "Create versioned Post resource" },
      ];
    case "x":
      return [
        ...(hasMedia ? [{ operation: "upload-media", method: "POST" as const, endpoint: "/2/media/upload", purpose: "Upload media and poll processing", carriesMediaBytes: true }] : []),
        { operation: "create-post", method: "POST", endpoint: "/2/tweets", purpose: "Create post with text and media_ids" },
      ];
    case "tiktok":
      return [
        { operation: "creator-info", method: "POST", endpoint: "/v2/post/publish/creator_info/query/", purpose: "Refresh allowed privacy and interaction controls" },
        { operation: "initialize-post", method: "POST", endpoint: "/v2/post/publish/video/init/ or /v2/post/publish/content/init/", purpose: "Initialize direct post" },
        { operation: "upload-media", method: "PUT", endpoint: "{upload_url}", purpose: "Transfer media bytes or use verified PULL_FROM_URL", carriesMediaBytes: true },
        { operation: "poll-status", method: "POST", endpoint: "/v2/post/publish/status/fetch/", purpose: "Reconcile publish_id" },
      ];
    case "youtube":
      return [
        { operation: "start-resumable", method: "POST", endpoint: "/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", purpose: "Create resumable session with metadata" },
        { operation: "upload-video", method: "PUT", endpoint: "{Location}", purpose: "Upload/resume video bytes", carriesMediaBytes: true },
        { operation: "poll-processing", method: "GET", endpoint: "/youtube/v3/videos?part=status,processingDetails&id={id}", purpose: "Reconcile processing and privacy" },
      ];
    case "facebook":
      return hasMedia
        ? [{ operation: "upload-page-media", method: "POST", endpoint: "/{page-id}/photos or /{page-id}/videos", purpose: "Upload and publish Page media", carriesMediaBytes: true }]
        : [{ operation: "create-page-post", method: "POST", endpoint: "/{page-id}/feed", purpose: "Publish Page text/link post" }];
  }
}
