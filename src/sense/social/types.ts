/**
 * Host-side contract for conversation-driven social publishing.
 *
 * A social connector is an MCP server plus a procedural Skill. The connector
 * owns OAuth and platform APIs; these types deliberately contain no access
 * tokens, refresh tokens, client secrets, or raw media bytes.
 */

export const SOCIAL_CONNECTOR_SCHEMA_VERSION = 1 as const;

export interface SocialConnectorManifest {
  schemaVersion: typeof SOCIAL_CONNECTOR_SCHEMA_VERSION;
  id: string;
  displayName: string;
  platform: string;
  /** Server key from the plugin's .mcp.json. */
  mcpServer: string;
  /** Skill name containing platform-specific composition guidance. */
  skill: string;
  tools: {
    listAccounts: string;
    getCapabilities: string;
    validateDraft: string;
    publish: string;
    getPublishStatus?: string;
    disconnectAccount?: string;
  };
}

export interface DiscoveredSocialConnector {
  plugin: string;
  manifestPath: string;
  manifest?: SocialConnectorManifest;
  error?: string;
}

export type SocialDraftState =
  | "draft"
  | "awaiting-approval"
  | "approved"
  | "publishing"
  | "partial"
  | "published"
  | "failed"
  | "cancelled"
  | "expired";

export interface SocialTarget {
  connectorId: string;
  accountId: string;
  platform: string;
  visibility?: string;
  scheduledAt?: string;
  /** Account/platform fields such as TikTok interaction controls. */
  options?: Record<string, unknown>;
}

export interface SocialMediaRef {
  /** Opaque handle into a host-managed media store; never a filesystem path. */
  id: string;
  kind: "image" | "video";
  mimeType: string;
  bytes: number;
  sha256: string;
  altText?: string;
}

export interface SocialDraftContent {
  text?: string;
  link?: string;
  title?: string;
  description?: string;
  media: SocialMediaRef[];
}

export interface SocialPlatformVariant {
  text?: string;
  link?: string;
  title?: string;
  description?: string;
  mediaIds?: string[];
  options?: Record<string, unknown>;
}

export interface SocialDraftApproval {
  digest: string;
  approvedAt: string;
  expiresAt: string;
  approvedBy: "local-user";
  claimedAt?: string;
}

export interface SocialDraftEvent {
  at: string;
  kind:
    | "created"
    | "updated"
    | "approval-requested"
    | "approved"
    | "claimed"
    | "outcome"
    | "cancelled";
  detail?: string;
}

export interface SocialPublishOutcome {
  targetKey: string;
  ok: boolean;
  platformPostId?: string;
  url?: string;
  error?: string;
  attempts: number;
  completedAt: string;
}

export interface SocialDraft {
  id: string;
  revision: number;
  state: SocialDraftState;
  createdAt: string;
  updatedAt: string;
  targets: SocialTarget[];
  canonical: SocialDraftContent;
  /** Keyed by `${connectorId}:${accountId}`. */
  variants: Record<string, SocialPlatformVariant>;
  approval?: SocialDraftApproval;
  outcomes?: SocialPublishOutcome[];
  events: SocialDraftEvent[];
}

export interface NewSocialDraft {
  targets: SocialTarget[];
  canonical: SocialDraftContent;
  variants?: Record<string, SocialPlatformVariant>;
}

export interface SocialDraftPatch {
  targets?: SocialTarget[];
  canonical?: SocialDraftContent;
  variants?: Record<string, SocialPlatformVariant>;
}
