/**
 * Pluggable durable store for Warden's approval inbox.
 *
 * Separates the inbox's persistence and single-consumption resolution claim
 * from the in-memory waiter registry so:
 *  - Local / single-instance Mac deployments use `FileApprovalInboxStore`
 *    backed atomically by `<home>/warden/pending.json` and
 *    `<home>/warden/resolved.json` (single-consumption claim ledger).
 *  - Multi-instance deployments (e.g. Cloud Run) can plug in a shared store
 *    (Firestore / Redis / SQLite) implementing `ApprovalInboxStore` without
 *    rewriting `WardenInbox`.
 *
 * Critical invariant preserved across every store implementation:
 *  Pending items loaded after a restart NEVER carry tool input payloads and
 *  NEVER become approvable — approvals still expire fail-closed.
 */
import path from "node:path";
import { withFileLock } from "../soul/lock.js";
import { quarantineCorrupt, readJsonState, wardenDir, writeJsonAtomic } from "./store.js";
import { isActionCategory, type ActionRequest, type InboxItemKind } from "./types.js";

const PENDING_VERSION = 1;
const RESOLVED_VERSION = 1;
const MAX_RESOLVED_RECORDS = 2000;

export interface PendingRecord {
  id: string;
  kind: InboxItemKind;
  createdAt: number;
  expiresAt: number;
  reason: string;
  request: ActionRequest;
}

export type ResolutionVerdict = "approved" | "denied" | "expired" | "dismissed" | "cancelled";

export interface ResolutionClaim {
  id: string;
  verdict: ResolutionVerdict;
  at: number;
  approverId?: string;
}

export interface ApprovalInboxStore {
  /** Load mirrored pending records for a tenant home (returns [] on missing/corrupt). */
  loadPending(home: string): Promise<PendingRecord[]>;
  /** Atomically persist the current mirror of pending records for a tenant home. */
  savePending(home: string, items: PendingRecord[]): Promise<void>;
  /**
   * Atomically claim single-consumption resolution for `claim.id`.
   * Returns `true` ONLY for the first caller that claims `claim.id`; subsequent
   * callers (including after restart or from another process sharing the store)
   * receive `false`.
   */
  claimResolution(home: string, claim: ResolutionClaim): Promise<boolean>;
}

interface PendingFile {
  version: typeof PENDING_VERSION;
  items: PendingRecord[];
}

interface ResolvedFile {
  version: typeof RESOLVED_VERSION;
  items: ResolutionClaim[];
}

function pendingFile(home: string): string {
  return path.join(wardenDir(home), "pending.json");
}

function resolvedFile(home: string): string {
  return path.join(wardenDir(home), "resolved.json");
}

function resolvedLockFile(home: string): string {
  return path.join(wardenDir(home), "resolved.lock");
}

function parseRequest(value: unknown): ActionRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.tool !== "string" || typeof r.digest !== "string") {
    return null;
  }
  if (!isActionCategory(r.category) || typeof r.preview !== "string") return null;
  if (!Array.isArray(r.targets) || !r.targets.every((t) => typeof t === "string")) return null;
  if (!Array.isArray(r.dataClasses)) return null;
  const origin = r.origin as Record<string, unknown> | undefined;
  if (!origin || typeof origin !== "object" || typeof origin.kind !== "string") return null;
  return value as ActionRequest;
}

function parsePendingFile(value: unknown): PendingFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (doc.version !== PENDING_VERSION || !Array.isArray(doc.items)) return null;
  const items: PendingRecord[] = [];
  for (const raw of doc.items) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || (r.kind !== "approval" && r.kind !== "handoff")) return null;
    if (typeof r.createdAt !== "number" || typeof r.expiresAt !== "number") return null;
    if (typeof r.reason !== "string") return null;
    const request = parseRequest(r.request);
    if (!request) return null;
    items.push({
      id: r.id,
      kind: r.kind,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      reason: r.reason,
      request,
    });
  }
  return { version: PENDING_VERSION, items };
}

const VALID_VERDICTS = new Set<ResolutionVerdict>([
  "approved",
  "denied",
  "expired",
  "dismissed",
  "cancelled",
]);

function parseResolvedFile(value: unknown): ResolvedFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (doc.version !== RESOLVED_VERSION || !Array.isArray(doc.items)) return null;
  const items: ResolutionClaim[] = [];
  for (const raw of doc.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.verdict !== "string" ||
      !VALID_VERDICTS.has(r.verdict as ResolutionVerdict) ||
      typeof r.at !== "number"
    ) {
      return null;
    }
    if (r.approverId !== undefined && typeof r.approverId !== "string") return null;
    items.push({
      id: r.id,
      verdict: r.verdict as ResolutionVerdict,
      at: r.at,
      ...(r.approverId ? { approverId: r.approverId } : {}),
    });
  }
  return { version: RESOLVED_VERSION, items };
}

/** Default local store backed by atomic JSON files + file-lock single consumption. */
export class FileApprovalInboxStore implements ApprovalInboxStore {
  async loadPending(home: string): Promise<PendingRecord[]> {
    const file = pendingFile(home);
    const read = await readJsonState(file, parsePendingFile);
    if (read.state === "missing") return [];
    if (read.state === "corrupt") {
      await quarantineCorrupt(file, read.error);
      return [];
    }
    return read.value.items;
  }

  async savePending(home: string, items: PendingRecord[]): Promise<void> {
    const doc: PendingFile = { version: PENDING_VERSION, items };
    await writeJsonAtomic(pendingFile(home), doc);
  }

  async claimResolution(home: string, claim: ResolutionClaim): Promise<boolean> {
    const file = resolvedFile(home);
    return await withFileLock(
      resolvedLockFile(home),
      async () => {
        const read = await readJsonState(file, parseResolvedFile);
        let existing: ResolutionClaim[] = [];
        if (read.state === "ok") {
          existing = read.value.items;
        } else if (read.state === "corrupt") {
          await quarantineCorrupt(file, read.error);
        }
        if (existing.some((entry) => entry.id === claim.id)) {
          return false;
        }
        const next = [...existing, claim];
        if (next.length > MAX_RESOLVED_RECORDS) {
          next.splice(0, next.length - MAX_RESOLVED_RECORDS);
        }
        await writeJsonAtomic(file, { version: RESOLVED_VERSION, items: next });
        return true;
      },
      { timeoutMs: 5_000, staleMs: 30_000 },
    );
  }
}

/** Pure in-memory store for unit tests and ephemeral runs. */
export class MemoryApprovalInboxStore implements ApprovalInboxStore {
  private readonly pending = new Map<string, PendingRecord[]>();
  private readonly resolved = new Map<string, Map<string, ResolutionClaim>>();

  async loadPending(home: string): Promise<PendingRecord[]> {
    return [...(this.pending.get(home) ?? [])];
  }

  async savePending(home: string, items: PendingRecord[]): Promise<void> {
    this.pending.set(home, [...items]);
  }

  async claimResolution(home: string, claim: ResolutionClaim): Promise<boolean> {
    let map = this.resolved.get(home);
    if (!map) {
      map = new Map();
      this.resolved.set(home, map);
    }
    if (map.has(claim.id)) return false;
    map.set(claim.id, claim);
    if (map.size > MAX_RESOLVED_RECORDS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    return true;
  }
}
