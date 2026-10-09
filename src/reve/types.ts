/**
 * Reve dream records (W9, docs/DESIGN_REVE_DREAMS.md).
 *
 * Every autonomous reflective pass — an idle/Reve run, a session reflection,
 * the weekly examen, a desire review — is wrapped so that once it finishes a
 * reviewable "dream diff" lands in `<lisaHome>/reve/dreams/<id>.json`.
 *
 * Ownership split (the sovereignty decision):
 *  - USER parts (memory, kb, skills Lisa patched) can be reverted by the user.
 *  - SOUL parts (identity, purpose, constitution, values, opinions, desires,
 *    journal, emotions) are Lisa's. The user can only ask her to reconsider.
 */
import type { AutonomyOutcome } from "../autonomy/runs.js";

export const DREAM_RECORD_VERSION = 1 as const;

/** Which reflective mechanism produced the dream. */
export type DreamTrigger = "idle" | "reflect" | "examen" | "desire-review";

export const DREAM_TRIGGERS: readonly DreamTrigger[] = ["idle", "reflect", "examen", "desire-review"];

/** Parts of the home the user owns and may revert from a dream. */
export type UserPart = "memory" | "kb" | "skills";
export const USER_PARTS: readonly UserPart[] = ["memory", "kb", "skills"];

/** Every tracked part. `soul` is Lisa's and never user-revertible. */
export type DreamPart = UserPart | "soul";

/** How the soul side of the diff was captured. */
export type CaptureMode = "git" | "snapshot";

export interface SoulCommitFile {
  path: string;
  added: number;
  removed: number;
}

/** One soul-git commit that landed inside the dream window. */
export interface SoulCommit {
  sha: string;
  at: string;
  subject: string;
  /** opKind from the commit subject ("patch", "feel", "journal", ...). */
  opKind: string;
  /** Caller label from the subject ("reflect", "heartbeat", "soul_patch", ...). */
  caller: string;
  /** Dream id stamped into the subject when the commit was made in a dream scope. */
  dreamId?: string;
  /** Reconsider request ids stamped into the subject, if any. */
  reconsider?: string[];
  files: SoulCommitFile[];
  /** Compact unified diff for this commit, capped. */
  diff: string;
  diffTruncated: boolean;
}

/** One file that changed between the pre-pass snapshot and the post-pass state. */
export interface FileChange {
  part: DreamPart;
  /** Path relative to the active home, POSIX separators. */
  path: string;
  status: "added" | "modified" | "deleted";
  /** sha256 hex of the content before the pass, null if it did not exist. */
  beforeHash: string | null;
  /** sha256 hex of the content after the pass, null if it was deleted. */
  afterHash: string | null;
  bytesBefore: number;
  bytesAfter: number;
  /** Compact line diff ("+ " / "- " lines), capped. */
  diff: string;
  diffTruncated: boolean;
  /** For MEMORY.md / USER.md: entries added / removed. */
  entriesAdded?: string[];
  entriesRemoved?: string[];
  /** True when the pre-pass content is stored and a user revert is possible. */
  revertible: boolean;
}

export interface DesireChanges {
  added: string[];
  revised: string[];
  closed: string[];
}

export interface EmotionDelta {
  before: Record<string, number>;
  after: Record<string, number>;
  delta: Record<string, number>;
}

/** Cheap, deterministic drift indicators for the coherence paper. */
export interface DreamMetrics {
  identityPatches: number;
  purposePatches: number;
  constitutionPatches: number;
  /** Lines added + removed across values/ and opinions/. */
  valuesChurn: number;
  opinionsChurn: number;
  /** added + revised + closed desires. */
  desireChurn: number;
  /** Sum of |delta| across emotion dimensions. */
  emotionVolatility: number;
  memoryEntriesAdded: number;
  memoryEntriesRemoved: number;
  kbFilesChanged: number;
  skillsTouched: number;
}

export interface DreamRevertAudit {
  at: string;
  parts: UserPart[];
  files: string[];
  forced: boolean;
}

export interface DreamRecord {
  version: typeof DREAM_RECORD_VERSION;
  id: string;
  trigger: DreamTrigger;
  /** Heartbeat task name, when relevant. */
  task?: string;
  windowStart: string;
  windowEnd: string;
  /** AutonomyRun ids recorded inside this pass. */
  autonomyRunIds: string[];
  outcome: AutonomyOutcome | "unknown";
  capture: CaptureMode;
  soulCommits: SoulCommit[];
  /** Soul-git HEAD before / after the pass (git capture only). */
  soulHeadBefore?: string;
  soulHeadAfter?: string;
  changes: FileChange[];
  desires: DesireChanges;
  emotions: EmotionDelta | null;
  skillsTouched: string[];
  metrics: DreamMetrics;
  /** Reconsider request ids that were injected into this pass. */
  reconsiderDelivered: string[];
  reverts: DreamRevertAudit[];
  /** One-paragraph human summary (also written to <id>.md). */
  summary: string;
  /** True when diffs were trimmed to respect the record byte cap. */
  truncated: boolean;
}

/** List-view projection of a dream. */
export interface DreamSummary {
  id: string;
  trigger: DreamTrigger;
  task?: string;
  windowStart: string;
  windowEnd: string;
  outcome: DreamRecord["outcome"];
  capture: CaptureMode;
  summary: string;
  parts: DreamPart[];
  revertibleParts: UserPart[];
  soulCommitCount: number;
  changeCount: number;
  metrics: DreamMetrics;
  reverted: boolean;
}

/** A user's "please reconsider" note for a dream's soul changes. */
export interface ReconsiderRequest {
  id: string;
  dreamId: string;
  note: string;
  createdAt: string;
  status: "pending" | "delivered";
  deliveredAt?: string;
  /** Dream id of the pass that received the note. */
  deliveredIn?: string;
}
