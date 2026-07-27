import type { SocialDraftContent, SocialPlatformVariant, SocialTarget } from "../types.js";

export interface ConnectorPublishInput {
  accountId: string;
  target: SocialTarget;
  content: SocialDraftContent;
  variant?: SocialPlatformVariant;
  idempotencyKey: string;
  /** Stable host approval time used for deterministic platform records. */
  createdAt: string;
}

export interface ConnectorPublishResult {
  ok: boolean;
  platformPostId?: string;
  url?: string;
  error?: string;
}

export interface ConnectorValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
