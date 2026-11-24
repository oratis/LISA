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
export { loadGrants, createGrants, revokeGrant, revokeTaskGrants, matchGrants } from "./grants.js";
export { createTaskApprovalFactory } from "./task-approval.js";
export type { TaskApprovalFactoryOptions, ApprovalReachOut } from "./task-approval.js";
export type { StoredGrant, LoadedGrants } from "./grants.js";
export { readAudit, appendAudit } from "./audit.js";
export type { AuditEntry } from "./audit.js";
export { isConversationTainted, markConversationTainted } from "./taint.js";
export { wardenDir } from "./store.js";
export { isBroadWorkspace, resolveChatWorkspaceRoot } from "./paths.js";
export type { ChatWorkspaceResolution } from "./paths.js";
export {
  PERSISTENT_SELF_WRITE_TOOLS,
  buildProvenanceReport,
  queryProvenance,
} from "./provenance.js";
export type {
  ProvenanceQuery,
  ProvenanceRecord,
  ProvenanceReport,
  ProvenanceSourceRef,
} from "./provenance.js";
export { modelProviderFamily, runCrossFamilyReview } from "./cross-family.js";
export type {
  CrossFamilyDecision,
  CrossFamilyGateOptions,
  CrossFamilyGateResult,
  CrossFamilyReviewer,
  ProviderFamily,
} from "./cross-family.js";
export {
  SignedApprovalVerifier,
  approversFile,
  canonicalApprovalChallenge,
  loadApprovers,
  newChallengeNonce,
  parseApprovalSignature,
  registerApprover,
  revokeApprover,
  signApprovalChallenge,
} from "./signed-approval.js";
export type {
  ApprovalChallenge,
  ApprovalSignature,
  RegisteredApprover,
  SignatureVerifyResult,
} from "./signed-approval.js";
export { FileApprovalInboxStore, MemoryApprovalInboxStore } from "./inbox-store.js";
export type {
  ApprovalInboxStore,
  PendingRecord,
  ResolutionClaim,
  ResolutionVerdict,
} from "./inbox-store.js";
