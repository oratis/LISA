/**
 * Warden — public surface. Other modules (web server, Task Engine, channels)
 * import from here; the files behind it are implementation.
 */
export * from "./types.js";
export { KnownUrls, createWardenSession } from "./session.js";
export type { WardenSession, WardenSessionOptions, WardenOutcome } from "./session.js";
export { WardenInbox, DEFAULT_APPROVAL_TIMEOUT_MS } from "./inbox.js";
export type {
  ApprovalOutcome,
  InboxItemDetail,
  InboxItemView,
  InboxOptions,
  ResolveResult,
  ResolveError,
} from "./inbox.js";
export { evaluate, defaultBehavior, envelopeCovers } from "./policy.js";
export type { PolicyContext, PolicyResult } from "./policy.js";
export { classifyToolCall } from "./classify.js";
export type { Classification, ClassifyContext } from "./classify.js";
export { buildActionRequest } from "./request.js";
export {
  loadRules,
  saveRules,
  setCategoryRule,
  parseRules,
  defaultRules,
  RulesValidationError,
} from "./rules.js";
export type { WardenRules, LoadedRules } from "./rules.js";
export { loadGrants, createGrants, revokeGrant, matchGrants } from "./grants.js";
export type { StoredGrant, LoadedGrants } from "./grants.js";
export { readAudit, appendAudit } from "./audit.js";
export type { AuditEntry } from "./audit.js";
export { isConversationTainted, markConversationTainted } from "./taint.js";
export { wardenDir } from "./store.js";
