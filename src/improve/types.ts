/**
 * Improve LISA M0/M1 data model (docs/PLAN_IMPROVE_LISA_2026-11-07.md).
 *
 * Work progress, personal activation, and community contribution are stored as
 * THREE INDEPENDENT statuses so an improvement can be e.g. `preview_ready` +
 * `active` + `pr_ready` at the same time.
 */

export const IMPROVE_SCHEMA_VERSION = 1;

export type ImprovementCapabilityKind = "preference" | "skill" | "workflow";

export type ImprovementWorkStatus = "draft" | "preview_ready" | "failed";
export type ImprovementActivationStatus = "inactive" | "active" | "rolled_back" | "conflict";
export type ImprovementContributionStatus = "none" | "exported" | "pr_ready";

export interface ChangeSetFile {
  /** Safe relative path inside the capability package (no `..`, no leading `/`). */
  path: string;
  content: string;
  sha256: string;
}

export interface AcceptanceCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ChangeSet {
  id: string;
  revision: number;
  baseProfileVersion: number;
  files: ChangeSetFile[];
  /** SHA-256 over canonical ChangeSet files + metadata; binds preview & apply. */
  digest: string;
  requiredCapabilities: string[];
  acceptanceCases: AcceptanceCheckResult[];
}

export interface CapabilityVersion {
  packageId: string;
  version: number;
  digest: string;
  kind: ImprovementCapabilityKind;
  createdAt: string;
  permissions: string[];
  files: ChangeSetFile[];
}

export interface ActivationCheckpoint {
  at: string;
  action: "apply" | "rollback" | "conflict";
  fromVersion: number | null;
  toVersion: number | null;
  digest: string;
  note?: string;
}

export interface ContributionExport {
  exportedAt: string;
  exportDigest: string;
  upstreamRepo: string;
  upstreamBranch: string;
  branchName: string;
  title: string;
  body: string;
  compareUrl: string;
  files: string[];
}

export interface ImprovementRecord {
  id: string;
  sessionId?: string;
  originSessionId?: string;
  originMessageIds?: string[];
  packageId: string;
  kind: ImprovementCapabilityKind;
  title: string;
  goal: string;
  workStatus: ImprovementWorkStatus;
  activationStatus: ImprovementActivationStatus;
  contributionStatus: ImprovementContributionStatus;
  changeSet?: ChangeSet;
  activeVersion?: number;
  previousVersion?: number;
  history: ActivationCheckpoint[];
  contribution?: ContributionExport;
  createdAt: string;
  updatedAt: string;
}

export interface ImprovementsState {
  version: typeof IMPROVE_SCHEMA_VERSION;
  profileVersion: number;
  items: ImprovementRecord[];
  activeCapabilities: Record<string, CapabilityVersion>;
  versionArchive: Record<string, CapabilityVersion[]>;
}
