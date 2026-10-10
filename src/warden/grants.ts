/**
 * Scoped grants — the durable result of "approve for this task / this
 * recipient / 24 hours / always", at `<home>/warden/grants.json`.
 *
 * Matching is exact: same tool, same category, same method, and the scope's
 * own binding (payload digest, task id, target). There are no patterns and no
 * prefixes. A corrupt store means NO grants (everything falls back to asking).
 */
import path from "node:path";
import { withFileLock } from "../soul/lock.js";
import { logWarn } from "../log.js";
import { newId, quarantineCorrupt, readJsonState, wardenDir, writeJsonAtomic } from "./store.js";
import {
  isActionCategory,
  isGrantScope,
  type ActionCategory,
  type ActionRequest,
  type Grant,
  type GrantScope,
  type OriginColumn,
  originColumn,
} from "./types.js";

export const GRANTS_VERSION = 1;
export const MAX_GRANTS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A "once" grant that is never used should not linger. */
const ONCE_TTL_MS = 10 * 60 * 1000;

/** A stored grant. `method` narrows action-dispatched tools (github `pr_comment` ≠ `pr_merge`). */
export interface StoredGrant extends Grant {
  method?: string;
  /** Trust column the approval was given in. Absent (hand-written file) = "chat". */
  column?: OriginColumn;
}

interface GrantsFile {
  version: typeof GRANTS_VERSION;
  grants: StoredGrant[];
}

export function grantsFile(home?: string): string {
  return path.join(wardenDir(home), "grants.json");
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parseGrant(value: unknown): StoredGrant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const g = value as Record<string, unknown>;
  if (typeof g.id !== "string" || !g.id) return null;
  if (typeof g.createdAt !== "string" || Number.isNaN(Date.parse(g.createdAt))) return null;
  if (!isGrantScope(g.scope)) return null;
  if (typeof g.tool !== "string" || !g.tool) return null;
  if (!isActionCategory(g.category)) return null;
  if (!optionalString(g.target) || !optionalString(g.taskId) || !optionalString(g.digest)) {
    return null;
  }
  if (!optionalString(g.method) || !optionalString(g.lastUsedAt)) return null;
  if (
    g.column !== undefined &&
    g.column !== "chat" &&
    g.column !== "task" &&
    g.column !== "channel"
  ) {
    return null;
  }
  if (!optionalString(g.expiresAt)) return null;
  if (g.expiresAt !== undefined && Number.isNaN(Date.parse(g.expiresAt))) return null;
  if (typeof g.uses !== "number" || !Number.isInteger(g.uses) || g.uses < 0) return null;
  // A scope without its binding would match far more than was approved.
  if (g.scope === "once" && !g.digest) return null;
  if (g.scope === "task" && !g.taskId) return null;
  if (g.scope === "target" && !g.target) return null;
  if ((g.scope === "24h" || g.scope === "once") && g.expiresAt === undefined) return null;
  return {
    id: g.id,
    createdAt: g.createdAt,
    scope: g.scope,
    tool: g.tool,
    category: g.category,
    target: g.target,
    taskId: g.taskId,
    digest: g.digest,
    method: g.method,
    column: g.column,
    expiresAt: g.expiresAt,
    uses: g.uses,
    lastUsedAt: g.lastUsedAt,
  };
}

function parseGrantsFile(value: unknown): GrantsFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (doc.version !== GRANTS_VERSION || !Array.isArray(doc.grants)) return null;
  const grants: StoredGrant[] = [];
  for (const raw of doc.grants) {
    const grant = parseGrant(raw);
    // One bad entry poisons the file: a partially trusted grant list is exactly
    // the state a tampered file would be in.
    if (!grant) return null;
    grants.push(grant);
  }
  return { version: GRANTS_VERSION, grants };
}

export function isExpired(grant: Grant, now: number): boolean {
  return grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now;
}

export interface LoadedGrants {
  grants: StoredGrant[];
  corrupt: boolean;
}

/** Load unexpired grants. Corrupt ⇒ none, flagged and logged. */
export async function loadGrants(home?: string, now: number = Date.now()): Promise<LoadedGrants> {
  const read = await readJsonState(grantsFile(home), parseGrantsFile);
  if (read.state === "ok") {
    return { grants: read.value.grants.filter((g) => !isExpired(g, now)), corrupt: false };
  }
  if (read.state === "corrupt") {
    logWarn(`[warden] grants.json is corrupt (${read.error}); treating as no grants`);
    return { grants: [], corrupt: true };
  }
  return { grants: [], corrupt: false };
}

async function mutate<T>(
  home: string | undefined,
  now: number,
  fn: (grants: StoredGrant[]) => { grants: StoredGrant[]; result: T },
): Promise<T> {
  const file = grantsFile(home);
  return await withFileLock(`${file}.lock`, async () => {
    const read = await readJsonState(file, parseGrantsFile);
    if (read.state === "corrupt") await quarantineCorrupt(file, read.error);
    const current = read.state === "ok" ? read.value.grants : [];
    const { grants, result } = fn(current.filter((g) => !isExpired(g, now)));
    await writeJsonAtomic(file, { version: GRANTS_VERSION, grants } satisfies GrantsFile);
    return result;
  });
}

export class GrantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantScopeError";
  }
}

export type GrantSubject = Pick<
  ActionRequest,
  "tool" | "category" | "method" | "targets" | "taskId" | "digest" | "origin"
> & { targetsComplete?: boolean };

/** Why a scope cannot be granted for this request, or null when it can. */
export function scopeProblem(req: GrantSubject, scope: GrantScope): string | null {
  if (scope === "task" && !req.taskId) return "this action does not belong to a task";
  if (scope === "target") {
    if (req.targets.length === 0) return "this action has no target to bind";
    // A grant "for this recipient" is only meaningful when the recipients are
    // all known. If they could not be enumerated, there is nothing to bind to.
    if (req.targetsComplete === false) return "this action's targets cannot be enumerated";
  }
  return null;
}

export interface GrantOptions {
  /**
   * Bind a "24h" approval to the request's targets (one grant per target)
   * instead of to the tool as a whole. Used where a blanket grant would undo
   * the reason for asking — an outbound fetch in a tainted run.
   */
  bindTargets?: boolean;
}

/** Build (without persisting) the grants an approval at `scope` produces. */
export function grantsFor(
  req: GrantSubject,
  scope: GrantScope,
  now: number,
  opts: GrantOptions = {},
): StoredGrant[] {
  const problem = scopeProblem(req, scope);
  if (problem) throw new GrantScopeError(problem);
  const base = {
    createdAt: new Date(now).toISOString(),
    scope,
    tool: req.tool,
    category: req.category,
    method: req.method,
    column: originColumn(req.origin),
    uses: 0,
  };
  if (scope === "once") {
    return [
      {
        ...base,
        id: newId("grant"),
        digest: req.digest,
        expiresAt: new Date(now + ONCE_TTL_MS).toISOString(),
      },
    ];
  }
  if (scope === "task") return [{ ...base, id: newId("grant"), taskId: req.taskId }];
  if (scope === "target") {
    return [...new Set(req.targets)].map((target) => ({ ...base, id: newId("grant"), target }));
  }
  if (scope === "24h") {
    const expiresAt = new Date(now + DAY_MS).toISOString();
    if (opts.bindTargets) {
      const targetProblem = scopeProblem(req, "target");
      if (targetProblem) throw new GrantScopeError(targetProblem);
      return [...new Set(req.targets)].map((target) => ({
        ...base,
        id: newId("grant"),
        target,
        expiresAt,
      }));
    }
    return [{ ...base, id: newId("grant"), expiresAt }];
  }
  return [{ ...base, id: newId("grant") }];
}

/** Persist the grants an approval at `scope` produces. */
export async function createGrants(
  req: GrantSubject,
  scope: GrantScope,
  home?: string,
  now: number = Date.now(),
  opts: GrantOptions = {},
): Promise<StoredGrant[]> {
  const created = grantsFor(req, scope, now, opts);
  return await mutate(home, now, (grants) => {
    const next = [...grants, ...created];
    // Bounded: drop the oldest when over the cap rather than refusing an approval.
    return { grants: next.slice(Math.max(0, next.length - MAX_GRANTS)), result: created };
  });
}

export async function revokeGrant(
  id: string,
  home?: string,
  now: number = Date.now(),
): Promise<StoredGrant | null> {
  return await mutate(home, now, (grants) => {
    const found = grants.find((g) => g.id === id) ?? null;
    return { grants: grants.filter((g) => g.id !== id), result: found };
  });
}

/**
 * Revoke the task-scoped grants of one task: when one of its runs ends, and —
 * for any a run left behind (a crash, Warden off at the time) — when the next
 * run starts, with `createdBefore` set to that run's start. Reads first and
 * writes only when there is something to revoke. Returns what was revoked.
 */
export async function revokeTaskGrants(
  taskId: string,
  home?: string,
  now: number = Date.now(),
  opts: { createdBefore?: number } = {},
): Promise<StoredGrant[]> {
  const matches = (g: StoredGrant): boolean =>
    g.scope === "task" &&
    g.taskId === taskId &&
    (opts.createdBefore === undefined || Date.parse(g.createdAt) < opts.createdBefore);
  // A corrupt file holds no grants anyone can use; the next write quarantines it.
  const current = await loadGrants(home, now);
  if (!current.grants.some(matches)) return [];
  return await mutate(home, now, (grants) => ({
    grants: grants.filter((g) => !matches(g)),
    result: grants.filter(matches),
  }));
}

/**
 * Record that grants were used: bump `uses`, and CONSUME "once" grants. Returns
 * false when a "once" grant had already been consumed by a concurrent caller —
 * the caller must then treat the action as not granted.
 */
export async function useGrants(
  ids: string[],
  home?: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (ids.length === 0) return true;
  return await mutate(home, now, (grants) => {
    const wanted = new Set(ids);
    const present = grants.filter((g) => wanted.has(g.id));
    if (present.length !== wanted.size) return { grants, result: false };
    const stamp = new Date(now).toISOString();
    const next = grants
      .filter((g) => !(wanted.has(g.id) && g.scope === "once"))
      .map((g) => (wanted.has(g.id) ? { ...g, uses: g.uses + 1, lastUsedAt: stamp } : g));
    return { grants: next, result: true };
  });
}

function sameSubject(grant: StoredGrant, req: GrantSubject): boolean {
  return (
    grant.tool === req.tool &&
    grant.category === req.category &&
    (grant.method ?? undefined) === (req.method ?? undefined) &&
    (grant.column ?? "chat") === originColumn(req.origin)
  );
}

export interface MatchOptions {
  /**
   * Which grants may cover the request:
   *  - "any"   — every scope (the default).
   *  - "bound" — only a payload-bound "once" grant or grants bound to every
   *              target. A blanket grant on a tool is not standing permission
   *              to send sensitive data to a recipient the user never saw.
   *  - "once"  — only the grant for this exact payload digest.
   */
  mode?: "any" | "bound" | "once";
  /** Exclude tool-wide "24h" / "always" grants (a tainted run), keeping task-scoped ones. */
  noBlanket?: boolean;
  /** @deprecated use `mode: "bound"`. */
  boundOnly?: boolean;
}

/** A grant that names one target: scope "target", or a target-bound "24h". */
function isTargetBound(grant: StoredGrant): boolean {
  return grant.target !== undefined && (grant.scope === "target" || grant.scope === "24h");
}

/**
 * The grants that together cover `req`, or null. A target-bound grant covers
 * one target, so a multi-recipient request needs EVERY recipient covered — and
 * a request whose recipients could not be enumerated is never covered that way.
 */
export function matchGrants(
  req: GrantSubject,
  grants: StoredGrant[],
  now: number,
  opts: MatchOptions = {},
): StoredGrant[] | null {
  const mode = opts.mode ?? (opts.boundOnly ? "bound" : "any");
  const live = grants.filter((g) => !isExpired(g, now) && sameSubject(g, req));
  const once = live.find((g) => g.scope === "once" && g.digest === req.digest);
  if (once) return [once];
  if (mode === "once") return null;
  if (req.targets.length > 0 && req.targetsComplete !== false) {
    const used: StoredGrant[] = [];
    const covered = req.targets.every((target) => {
      const grant = live.find((g) => isTargetBound(g) && g.target === target);
      if (grant && !used.includes(grant)) used.push(grant);
      return grant !== undefined;
    });
    if (covered) return used;
  }
  if (mode === "bound") return null;
  if (req.taskId) {
    const task = live.find((g) => g.scope === "task" && g.taskId === req.taskId);
    if (task) return [task];
  }
  if (opts.noBlanket) return null;
  const blanket = live.find(
    (g) => (g.scope === "24h" && g.target === undefined) || g.scope === "always",
  );
  return blanket ? [blanket] : null;
}

export type { ActionCategory };
