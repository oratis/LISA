/**
 * Truthful read-only capability summary for Web, Mac, and iOS clients
 * (A01 of docs/PLAN_PRODUCT_ALIGNMENT_2026-10-24.md).
 *
 * This endpoint ONLY describes what the current server + authenticated caller
 * supports so clients can render honest UI states instead of faking features.
 * It NEVER grants permissions — every state-changing endpoint continues to
 * enforce its own auth, tenancy, edition, and Warden gates.
 */
import type { Edition } from "../edition.js";
import type { TaskKind } from "../tasks/types.js";
import type { CapabilityProfile } from "./capabilities.js";
import { cloudTasksEnabled } from "./tasks-api.js";

export type CapabilityStatus = "available" | "needs_setup" | "disabled" | "unsupported" | "offline";

export interface ClientCapabilityEntry {
  status: CapabilityStatus;
  reason?: string;
}

export interface TasksCapabilityEntry extends ClientCapabilityEntry {
  supportedKinds: TaskKind[];
}

export interface ClientCapabilitiesResponse {
  edition: Edition;
  surface: string;
  profile: CapabilityProfile;
  location: "mac" | "cloud";
  canApprove: boolean;
  tasks: TasksCapabilityEntry;
  approvals: ClientCapabilityEntry;
  connectors: ClientCapabilityEntry;
  localTools: ClientCapabilityEntry;
  cloudWorkspace: ClientCapabilityEntry;
  artifacts: ClientCapabilityEntry;
}

export interface ClientCapabilitiesInput {
  edition: Edition;
  surface: string;
  profile: CapabilityProfile;
  canApprove: boolean;
  localOwner: boolean;
  connectorsEnabled?: boolean;
  cloudWorkspaceConfigured?: boolean;
  cloudTasksOn?: boolean;
}

const ALL_LOCAL_TASK_KINDS: TaskKind[] = ["oneoff", "routine", "watcher", "goal"];
const CLOUD_TASK_KINDS: TaskKind[] = ["oneoff", "routine", "goal"];

export function buildClientCapabilities(
  input: ClientCapabilitiesInput,
): ClientCapabilitiesResponse {
  const isCloud = input.edition === "cloud";
  const cloudTasksOn = input.cloudTasksOn ?? cloudTasksEnabled();

  const tasks: TasksCapabilityEntry = !isCloud
    ? {
        status: "available",
        supportedKinds: [...ALL_LOCAL_TASK_KINDS],
      }
    : cloudTasksOn
      ? {
          status: "available",
          supportedKinds: [...CLOUD_TASK_KINDS],
        }
      : {
          status: "disabled",
          reason: "Background tasks are currently disabled on this cloud server.",
          supportedKinds: [],
        };

  const approvals: ClientCapabilityEntry = input.canApprove
    ? { status: "available" }
    : {
        status: "disabled",
        reason: "Approvals require a trusted local owner or signed-in account session.",
      };

  const connectors: ClientCapabilityEntry =
    isCloud || !input.localOwner
      ? {
          status: "unsupported",
          reason: "Workspace connectors are only managed directly on the Mac host.",
        }
      : input.connectorsEnabled
        ? { status: "available" }
        : {
            status: "needs_setup",
            reason: "Connect a workspace account in Dashboard to enable connectors.",
          };

  const localTools: ClientCapabilityEntry =
    !isCloud && input.profile === "local-owner"
      ? { status: "available" }
      : {
          status: "unsupported",
          reason: isCloud
            ? "Local host tools are unavailable on LISA Cloud."
            : "Local host tools require the local owner session on the Mac.",
        };

  const cloudWorkspace: ClientCapabilityEntry = isCloud
    ? { status: "available" }
    : input.cloudWorkspaceConfigured
      ? { status: "available" }
      : {
          status: "needs_setup",
          reason: "Sign in to LISA Cloud to enable cloud workspace access.",
        };

  const artifacts: ClientCapabilityEntry =
    tasks.status === "available"
      ? { status: "available" }
      : {
          status: "disabled",
          reason: tasks.reason,
        };

  return {
    edition: input.edition,
    surface: input.surface,
    profile: input.profile,
    location: isCloud ? "cloud" : "mac",
    canApprove: input.canApprove,
    tasks,
    approvals,
    connectors,
    localTools,
    cloudWorkspace,
    artifacts,
  };
}
