/**
 * The approval inbox — where an "ask" waits for a human.
 *
 * Pending items live in a per-tenant in-memory map (the waiter is a Promise in
 * this process) with a durable mirror at `<home>/warden/pending.json`. The
 * mirror exists so a restart can show and expire what was orphaned; it is
 * NEVER a source of approval. An item can only be approved through `resolve`
 * against a live in-memory waiter, so no state of the file — missing, corrupt
 * or hand-edited — can turn into an allow.
 *
 * Every way an approval can end other than an explicit approve is a deny:
 * timeout, cancellation, capacity, tenant eviction, shutdown, restart.
 */
import path from "node:path";
import { logWarn } from "../log.js";
import { auditQuietly, auditResolution } from "./audit.js";
import { createGrants, revokeGrant, scopeProblem } from "./grants.js";
import {
  newId,
  quarantineCorrupt,
  readJsonState,
  wardenDir,
  writeJsonAtomic,
} from "./store.js";
import {
  GRANT_SCOPES,
  isActionCategory,
  isGrantScope,
  type ActionRequest,
  type ApprovalRequestedEvent,
  type GrantScope,
  type InboxItemKind,
  type WardenEmit,
} from "./types.js";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_PER_TENANT = 200;
export const MAX_TENANTS = 500;
const PENDING_VERSION = 1;

export interface ApprovalOutcome {
  approved: boolean;
  scope?: GrantScope;
  reason?: string;
  expired?: boolean;
}

/** What a client sees. No home path, no uid, no raw input. */
export interface InboxItemView {
  id: string;
  kind: InboxItemKind;
  at: string;
  expiresAt: string;
  tool: string;
  method?: string;
  connector?: string;
  category: ActionRequest["category"];
  targets: string[];
  dataClasses: ActionRequest["dataClasses"];
  preview: string;
  purpose?: string;
  digest: string;
  taskId?: string;
  origin: ActionRequest["origin"];
  reason: string;
  /** Scopes this item can be approved with (empty for a handoff). */
  scopes: GrantScope[];
}

interface Item {
  id: string;
  kind: InboxItemKind;
  uid: string | null;
  home: string;
  createdAt: number;
  expiresAt: number;
  request: ActionRequest;
  reason: string;
  settle?: (outcome: ApprovalOutcome) => void;
  timer?: NodeJS.Timeout;
  detachAbort?: () => void;
}

interface Tenant {
  items: Map<string, Item>;
  home: string;
  /** Settles once the durable mirror has been reconciled for this process. */
  recovering?: Promise<void>;
  touchedAt: number;
}

interface PendingRecord {
  id: string;
  kind: InboxItemKind;
  createdAt: number;
  expiresAt: number;
  reason: string;
  request: ActionRequest;
}

interface PendingFile {
  version: typeof PENDING_VERSION;
  items: PendingRecord[];
}

export type ResolveError =
  | "not_found"
  | "expired"
  | "not_approvable"
  | "invalid_scope"
  | "scope_not_applicable"
  | "digest_mismatch"
  | "audit_failed";

export type ResolveResult =
  | { ok: true; id: string; verdict: "approved" | "denied" | "dismissed"; scope?: GrantScope; grantIds?: string[]; grantError?: string }
  | { ok: false; error: ResolveError; message?: string };

export interface InboxOptions {
  emit?: WardenEmit;
  defaultTimeoutMs?: number;
  handoffTtlMs?: number;
  maxPendingPerTenant?: number;
  maxTenants?: number;
  now?: () => number;
}

export interface RequestOptions {
  /** The tenant's home, captured inside the request scope. */
  home: string;
  /** Deterministic policy reason shown on the card. */
  reason: string;
  timeoutMs?: number;
  /** Cancels the wait (turn aborted / client gone). Cancellation is a deny. */
  signal?: AbortSignal;
}

function pendingFile(home: string): string {
  return path.join(wardenDir(home), "pending.json");
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

function tenantKey(uid: string | null): string {
  return uid === null ? "\u0000local" : `u:${uid}`;
}

function scopesFor(item: Item): GrantScope[] {
  if (item.kind !== "approval") return [];
  return GRANT_SCOPES.filter((scope) => scopeProblem(item.request, scope) === null);
}

function view(item: Item): InboxItemView {
  const req = item.request;
  return {
    id: item.id,
    kind: item.kind,
    at: new Date(item.createdAt).toISOString(),
    expiresAt: new Date(item.expiresAt).toISOString(),
    tool: req.tool,
    method: req.method,
    connector: req.connector,
    category: req.category,
    targets: req.targets,
    dataClasses: req.dataClasses,
    preview: req.preview,
    purpose: req.purpose,
    digest: req.digest,
    taskId: req.taskId,
    origin: req.origin,
    reason: item.reason,
    scopes: scopesFor(item),
  };
}

export class WardenInbox {
  private readonly tenants = new Map<string, Tenant>();
  private readonly persistChains = new Map<string, Promise<void>>();
  private readonly emit?: WardenEmit;
  private readonly defaultTimeoutMs: number;
  private readonly handoffTtlMs: number;
  private readonly maxPendingPerTenant: number;
  private readonly maxTenants: number;
  private readonly now: () => number;
  private closed = false;

  constructor(opts: InboxOptions = {}) {
    this.emit = opts.emit;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.handoffTtlMs = opts.handoffTtlMs ?? DEFAULT_HANDOFF_TTL_MS;
    this.maxPendingPerTenant = opts.maxPendingPerTenant ?? MAX_PENDING_PER_TENANT;
    this.maxTenants = opts.maxTenants ?? MAX_TENANTS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Queue an approval and wait for the answer. Resolves — never rejects — with
   * `approved: false` for every outcome other than an explicit approve.
   */
  async request(req: ActionRequest, opts: RequestOptions): Promise<ApprovalOutcome> {
    if (this.closed) return { approved: false, reason: "The approval inbox is shut down." };
    if (opts.signal?.aborted) return { approved: false, reason: "The turn was cancelled." };
    const tenant = await this.tenant(req.uid, opts.home);
    if (this.pendingApprovals(tenant) >= this.maxPendingPerTenant) {
      return {
        approved: false,
        reason: "Too many approvals are already waiting; answer those first.",
      };
    }
    const timeoutMs = Math.max(1, opts.timeoutMs ?? this.defaultTimeoutMs);
    const createdAt = this.now();
    const item: Item = {
      id: newId("apr"),
      kind: "approval",
      uid: req.uid,
      home: opts.home,
      createdAt,
      expiresAt: createdAt + timeoutMs,
      request: req,
      reason: opts.reason,
    };
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      item.settle = resolve;
    });
    item.timer = setTimeout(() => {
      void this.finish(item, "expired", {
        approved: false,
        expired: true,
        reason: "The approval request expired without an answer.",
      });
    }, timeoutMs);
    if (opts.signal) {
      const onAbort = () => {
        void this.finish(item, "cancelled", {
          approved: false,
          reason: "The turn was cancelled before the approval was answered.",
        });
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      item.detachAbort = () => opts.signal!.removeEventListener("abort", onAbort);
    }
    tenant.items.set(item.id, item);
    await this.persist(tenant);
    this.announce(item);
    return await outcome;
  }

  /** Record a hand-off: an informational item the user dismisses. Never blocks. */
  async handoff(
    req: ActionRequest,
    opts: { home: string; reason: string },
  ): Promise<InboxItemView | null> {
    if (this.closed) return null;
    const tenant = await this.tenant(req.uid, opts.home);
    // A hand-off is informational; at capacity the oldest hand-off makes room.
    const handoffs = [...tenant.items.values()].filter((i) => i.kind === "handoff");
    if (handoffs.length >= this.maxPendingPerTenant) {
      const oldest = handoffs.sort((a, b) => a.createdAt - b.createdAt)[0]!;
      tenant.items.delete(oldest.id);
      this.emitResolved(oldest, "dismissed");
    }
    const createdAt = this.now();
    const item: Item = {
      id: newId("apr"),
      kind: "handoff",
      uid: req.uid,
      home: opts.home,
      createdAt,
      expiresAt: createdAt + this.handoffTtlMs,
      request: req,
      reason: opts.reason,
    };
    tenant.items.set(item.id, item);
    await this.persist(tenant);
    this.announce(item);
    return view(item);
  }

  /** Pending items for one tenant, oldest first. Expired hand-offs are dropped. */
  async list(uid: string | null, home: string): Promise<InboxItemView[]> {
    const tenant = await this.tenant(uid, home);
    this.sweep(tenant);
    return [...tenant.items.values()].sort((a, b) => a.createdAt - b.createdAt).map(view);
  }

  /**
   * Answer an item. Looks ONLY in `uid`'s own map: another tenant's id is
   * indistinguishable from a non-existent one.
   */
  async resolve(
    uid: string | null,
    id: string,
    answer: { approve: boolean; scope?: unknown; reason?: unknown; digest?: unknown },
  ): Promise<ResolveResult> {
    const tenant = this.tenants.get(tenantKey(uid));
    const item = tenant?.items.get(id);
    if (!tenant || !item) return { ok: false, error: "not_found" };
    tenant.touchedAt = this.now();
    if (this.now() >= item.expiresAt) {
      if (item.kind === "approval") {
        await this.finish(item, "expired", {
          approved: false,
          expired: true,
          reason: "The approval request expired without an answer.",
        });
      } else {
        tenant.items.delete(item.id);
        await this.persist(tenant);
      }
      return { ok: false, error: "expired" };
    }
    if (typeof answer.digest === "string" && answer.digest !== item.request.digest) {
      return { ok: false, error: "digest_mismatch" };
    }
    const note = typeof answer.reason === "string" ? answer.reason.slice(0, 500) : undefined;

    if (!answer.approve) {
      if (item.kind === "handoff") {
        tenant.items.delete(item.id);
        await this.persist(tenant);
        await auditQuietly(
          auditResolution(item.request, "dismissed", {
            home: item.home,
            approvalId: item.id,
            note,
            now: this.now(),
          }),
        );
        this.emitResolved(item, "dismissed");
        return { ok: true, id, verdict: "dismissed" };
      }
      await this.finish(item, "denied", { approved: false, reason: note }, { note });
      return { ok: true, id, verdict: "denied" };
    }

    if (item.kind !== "approval") {
      return {
        ok: false,
        error: "not_approvable",
        message: "A hand-off cannot be approved: the user has to do this step themselves.",
      };
    }
    const scope = answer.scope === undefined ? "once" : answer.scope;
    if (!isGrantScope(scope)) return { ok: false, error: "invalid_scope" };
    const problem = scopeProblem(item.request, scope);
    if (problem) return { ok: false, error: "scope_not_applicable", message: problem };

    // Claim the item before any await so a concurrent approve/deny/expiry loses.
    if (!this.claim(item)) return { ok: false, error: "not_found" };
    let grantIds: string[] | undefined;
    let grantError: string | undefined;
    if (scope !== "once") {
      try {
        grantIds = (await createGrants(item.request, scope, item.home, this.now())).map((g) => g.id);
      } catch (err) {
        // The user approved THIS payload; a failed grant write narrows the
        // approval to this one call rather than widening or losing it.
        grantError = (err as Error).message;
        logWarn(`[warden] could not persist a ${scope} grant: ${grantError}`);
      }
    }
    const effective: GrantScope = grantError ? "once" : scope;
    const honoured = await this.conclude(
      item,
      "approved",
      { approved: true, scope: effective },
      { scope: effective, grantId: grantIds?.[0] },
    );
    if (!honoured) {
      // The approval could not be recorded, so it did not happen: take back
      // any grant it created.
      for (const grantId of grantIds ?? []) {
        await revokeGrant(grantId, item.home, this.now()).catch(() => undefined);
      }
      return {
        ok: false,
        error: "audit_failed",
        message: "The approval could not be recorded in the audit log, so it was not applied.",
      };
    }
    return { ok: true, id, verdict: "approved", scope: effective, grantIds, grantError };
  }

  /** Deny everything pending and stop accepting requests (server shutdown). */
  async shutdown(): Promise<void> {
    this.closed = true;
    const pending: Promise<void>[] = [];
    for (const tenant of this.tenants.values()) {
      for (const item of [...tenant.items.values()]) {
        if (item.kind !== "approval") continue;
        pending.push(
          this.finish(item, "cancelled", {
            approved: false,
            reason: "The server is shutting down.",
          }),
        );
      }
    }
    await Promise.all(pending);
    await Promise.all([...this.persistChains.values()].map((p) => p.catch(() => undefined)));
  }

  /** Pending approvals across all tenants (diagnostics / tests). */
  get size(): number {
    let total = 0;
    for (const tenant of this.tenants.values()) total += tenant.items.size;
    return total;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private pendingApprovals(tenant: Tenant): number {
    let count = 0;
    for (const item of tenant.items.values()) if (item.kind === "approval") count++;
    return count;
  }

  private async tenant(uid: string | null, home: string): Promise<Tenant> {
    const key = tenantKey(uid);
    let tenant = this.tenants.get(key);
    if (!tenant) {
      tenant = { items: new Map(), home, touchedAt: this.now() };
      this.tenants.set(key, tenant);
      this.evictIdleTenants(key);
    }
    tenant.touchedAt = this.now();
    // Every caller waits for the same reconciliation, so a concurrent request
    // cannot write the mirror before the orphans in it have been read.
    tenant.recovering ??= this.recover(tenant, uid).catch((err: unknown) => {
      logWarn(`[warden] pending.json recovery failed: ${(err as Error).message}`);
    });
    await tenant.recovering;
    return tenant;
  }

  /** LRU across tenants. Evicting a tenant DENIES whatever it had pending. */
  private evictIdleTenants(keep: string): void {
    if (this.tenants.size <= this.maxTenants) return;
    const candidates = [...this.tenants.entries()]
      .filter(([key]) => key !== keep)
      .sort((a, b) => {
        // Prefer tenants with nothing pending, then least recently touched.
        const empty = Number(a[1].items.size > 0) - Number(b[1].items.size > 0);
        return empty !== 0 ? empty : a[1].touchedAt - b[1].touchedAt;
      });
    while (this.tenants.size > this.maxTenants && candidates.length > 0) {
      const [key, tenant] = candidates.shift()!;
      for (const item of [...tenant.items.values()]) {
        if (item.kind === "approval") {
          void this.finish(item, "cancelled", {
            approved: false,
            reason: "The approval was dropped under load; ask again.",
          });
        }
      }
      this.tenants.delete(key);
      // Approvals are gone from the mirror; hand-offs stay for the next touch.
      void this.persist(tenant);
    }
  }

  /**
   * First touch of a tenant in this process: whatever the mirror holds was
   * orphaned by a restart. Approvals are expired (their waiter is gone);
   * unexpired hand-offs are shown again.
   */
  private async recover(tenant: Tenant, uid: string | null): Promise<void> {
    const file = pendingFile(tenant.home);
    const read = await readJsonState(file, parsePendingFile);
    if (read.state === "missing") return;
    if (read.state === "corrupt") {
      // Nothing is restored from a file that cannot be trusted.
      await quarantineCorrupt(file, read.error);
      return;
    }
    const now = this.now();
    for (const record of read.value.items) {
      if (record.kind === "handoff" && record.expiresAt > now) {
        tenant.items.set(record.id, {
          id: record.id,
          kind: "handoff",
          uid,
          home: tenant.home,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          // The uid comes from the caller's authenticated scope, never the file.
          request: { ...record.request, uid },
          reason: record.reason,
        });
        continue;
      }
      if (record.kind === "approval") {
        await auditQuietly(
          auditResolution({ ...record.request, uid }, "expired", {
            home: tenant.home,
            approvalId: record.id,
            note: "orphaned by a process restart",
            now,
          }),
        );
      }
    }
    await this.persist(tenant);
  }

  private sweep(tenant: Tenant): void {
    const now = this.now();
    let dropped = false;
    for (const item of [...tenant.items.values()]) {
      if (item.kind === "handoff" && item.expiresAt <= now) {
        tenant.items.delete(item.id);
        dropped = true;
      }
    }
    if (dropped) void this.persist(tenant);
  }

  /** Atomically take ownership of a pending approval. False = someone else already did. */
  private claim(item: Item): boolean {
    const tenant = this.tenants.get(tenantKey(item.uid));
    if (!tenant || tenant.items.get(item.id) !== item) return false;
    tenant.items.delete(item.id);
    if (item.timer) clearTimeout(item.timer);
    item.detachAbort?.();
    return true;
  }

  private async finish(
    item: Item,
    resolution: "denied" | "expired" | "cancelled",
    outcome: ApprovalOutcome,
    extra: { note?: string } = {},
  ): Promise<void> {
    if (!this.claim(item)) return;
    await this.conclude(item, resolution, outcome, extra);
  }

  private async conclude(
    item: Item,
    resolution: "approved" | "denied" | "expired" | "cancelled",
    outcome: ApprovalOutcome,
    extra: { note?: string; scope?: GrantScope; grantId?: string } = {},
  ): Promise<boolean> {
    const tenant = this.tenants.get(tenantKey(item.uid));
    const audit = auditResolution(item.request, resolution, {
      home: item.home,
      approvalId: item.id,
      scope: extra.scope,
      grantId: extra.grantId,
      note: extra.note,
      latencyMs: this.now() - item.createdAt,
      now: this.now(),
    });
    let effective = outcome;
    if (resolution === "approved") {
      // No audit record ⇒ no approval (INVARIANTS §权限与工具 5).
      try {
        await audit;
      } catch (err) {
        logWarn(`[warden] approval not honoured, audit write failed: ${(err as Error).message}`);
        effective = { approved: false, reason: "The approval could not be recorded." };
      }
    } else {
      await auditQuietly(audit);
    }
    if (tenant) await this.persist(tenant).catch(() => undefined);
    item.settle?.(effective);
    this.emitResolved(
      item,
      !effective.approved && resolution === "approved"
        ? "denied"
        : resolution === "cancelled"
          ? "denied"
          : resolution,
      effective.approved ? extra.scope : undefined,
    );
    return effective.approved;
  }

  private announce(item: Item): void {
    if (!this.emit) return;
    const v = view(item);
    const event: ApprovalRequestedEvent = {
      type: "approval_requested",
      id: v.id,
      kind: v.kind,
      at: v.at,
      tool: v.tool,
      category: v.category,
      targets: v.targets,
      preview: v.preview,
      purpose: v.purpose,
      digest: v.digest,
      expiresAt: v.expiresAt,
      taskId: v.taskId,
      origin: v.origin,
      reason: v.reason,
    };
    this.safeEmit(event, item.uid);
  }

  private emitResolved(
    item: Item,
    verdict: "approved" | "denied" | "expired" | "dismissed",
    scope?: GrantScope,
  ): void {
    this.safeEmit({ type: "approval_resolved", id: item.id, verdict, scope }, item.uid);
  }

  private safeEmit(event: Parameters<WardenEmit>[0], uid: string | null): void {
    if (!this.emit) return;
    try {
      this.emit(event, uid);
    } catch (err) {
      logWarn(`[warden] inbox emitter threw: ${(err as Error).message}`);
    }
  }

  /** Rewrite the durable mirror for a tenant. Failures are logged, never fatal. */
  private persist(tenant: Tenant): Promise<void> {
    const file = pendingFile(tenant.home);
    const previous = this.persistChains.get(file) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const doc: PendingFile = {
          version: PENDING_VERSION,
          items: [...tenant.items.values()].map((item) => ({
            id: item.id,
            kind: item.kind,
            createdAt: item.createdAt,
            expiresAt: item.expiresAt,
            reason: item.reason,
            request: item.request,
          })),
        };
        try {
          await writeJsonAtomic(file, doc);
        } catch (err) {
          logWarn(`[warden] could not write pending.json: ${(err as Error).message}`);
        }
      });
    this.persistChains.set(file, next);
    void next.then(() => {
      if (this.persistChains.get(file) === next) this.persistChains.delete(file);
    });
    return next;
  }
}
