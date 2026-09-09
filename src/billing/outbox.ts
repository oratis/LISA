/**
 * Durable usage outbox (T-8) — the record that survives a torn settlement.
 *
 * Settling a metered turn is TWO writes: "the provider has been paid, here is
 * what it cost" and "take it out of the balance". Before T-8 only the second
 * one was durable, so a crash, a Firestore blip or a full disk between them
 * lost the charge silently — the user got the inference, the operator got the
 * bill, and nothing on disk remembered why the numbers stopped matching.
 *
 * The outbox makes the FIRST write durable and the second one replayable:
 *
 *   append(pending) ──► debit(balance, eventId) ──► update(committed)
 *        │                      │                        │
 *        └ fails ⇒ FAIL CLOSED  └ fails ⇒ event parked    └ fails ⇒ event stays
 *          (no charge, the         as `failed`, the         `pending`; the debit
 *          permit is released,     reconciler retries       ALREADY landed and
 *          caller retries)         it later                 the ledger's own
 *                                                           idempotency key
 *                                                           refuses a replay
 *
 * The invariant we buy (.codex/INVARIANTS.md 计费与交易 §1): every state the
 * process can die in is either "no charge and no record" or "a record that the
 * reconciler can settle exactly once". Never "charged and forgotten", never
 * "charged twice".
 *
 * Idempotency lives in the LEDGER, not here: `debitTurn(…, {eventId})` records
 * the id in the balance's `settled` ring inside the same atomic update as the
 * money, so a replay is refused by the thing holding the money rather than by
 * a caller who remembered to check. Firestore has no multi-document
 * transaction in this codebase's client (firestore.ts exposes CAS only), so
 * "mark committed" is a separate write on purpose — the ledger key is what
 * makes that safe, and is why the reconciler can re-run a half-finished
 * settlement without a second charge.
 *
 * Flag: LISA_BILLING_OUTBOX=0 disables ONLY the outbox write. Every fail-closed
 * check that existed before T-8 keeps its exact behaviour with the flag off.
 */
import path from "node:path";
import crypto from "node:crypto";
import type { AccountRecord } from "../web/accounts.js";
import type { ProviderUsage } from "../providers/types.js";
import { homeScope, homeForUid, lisaGlobalHome } from "../paths.js";
import { logError, logInfo, redactId } from "../log.js";
import { appendLine, atomicWrite, readTextOrEmpty } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import { firestoreEnabled, getDoc, setDoc, casUpdate, FirestoreError } from "../cloud/firestore.js";
import { BillingStateError, debitTurn, SETTLED_TTL_MS } from "./quota.js";

// ── the event ───────────────────────────────────────────────────────────────

export type UsageEventStatus = "pending" | "committed" | "failed" | "needs_human";

/** One settled inference, durable BEFORE the balance moves. */
export interface UsageEvent {
  /** Random id — also the balance ledger's idempotency key. Never derived from the uid. */
  id: string;
  uid: string;
  /** What drove the turn: chat | gw | reflect | birth | voice_* | autonomy… */
  kind: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Cache reads + writes, summed: they price differently but reconcile as one number. */
  tokensCache: number;
  /** Face cost, micro-USD, already priced by prices.ts. */
  costMicros: number;
  /** The admission permit this turn ran under — the audit link back to the lease. */
  reservationId: string;
  /** ms since epoch. */
  createdAt: number;
  status: UsageEventStatus;
  /** Balance-commit attempts made so far. */
  attempts: number;
  /** Redacted failure detail from the last attempt (never raw ids or tokens). */
  lastError?: string;
}

/**
 * Commit attempts before an event stops being retried and waits for a person.
 * Five spread over 15-minute reconciler passes is a bit over an hour of
 * automatic recovery — long enough for a Firestore incident, short enough that
 * a genuinely broken tenant reaches a human the same day.
 */
export const MAX_COMMIT_ATTEMPTS = 5;

/**
 * How old an event may be and still be safely re-applied.
 *
 * The ledger's idempotency ring (quota.ts `settled`) forgets ids after
 * SETTLED_TTL_MS, and sooner for a very busy tenant (SETTLED_MAX entries). Past
 * this window a "replay" could be indistinguishable from a fresh charge, so the
 * reconciler escalates instead of guessing. Half the TTL leaves margin for the
 * count-based eviction the age bound cannot see.
 */
export const SETTLED_REPLAY_WINDOW_MS = SETTLED_TTL_MS / 2;

/** Where a failed attempt parks the event. Shared by settlement and reconciliation. */
export function parkedStatusAfter(attempts: number): UsageEventStatus {
  return attempts >= MAX_COMMIT_ATTEMPTS ? "needs_human" : "failed";
}

/** Coarse provider name for reconciliation against a provider invoice. */
function providerOfModel(model: string): string {
  const m = model.trim().toLowerCase();
  if (m.startsWith("glm-") || m.startsWith("chatglm-")) return "zhipu";
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.startsWith("media/")) return "media";
  return "unknown";
}

export interface SettlementInput {
  acct: AccountRecord;
  kind: string;
  model: string;
  /** Token counts for the audit trail. Absent for duration-priced media turns. */
  usage?: ProviderUsage;
  /** Face cost, micro-USD. Zero or less means there is nothing to settle. */
  costMicros: number;
  reservationId: string;
  provider?: string;
  /** Force the event id (tests, and a caller that already minted one). */
  eventId?: string;
}

export function newUsageEvent(input: SettlementInput, now: number = Date.now()): UsageEvent {
  const usage = input.usage;
  return {
    id: input.eventId ?? crypto.randomUUID(),
    uid: input.acct.uid,
    kind: input.kind,
    provider: input.provider ?? providerOfModel(input.model),
    model: input.model,
    tokensIn: usage?.inputTokens ?? 0,
    tokensOut: usage?.outputTokens ?? 0,
    tokensCache: (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0),
    costMicros: input.costMicros,
    reservationId: input.reservationId,
    createdAt: now,
    status: "pending",
    attempts: 0,
  };
}

// ── redaction ───────────────────────────────────────────────────────────────

const BEARER_RE = /\b(bearer|token|key|secret)[=:\s]+[A-Za-z0-9._~+/-]{6,}=*/gi;
const MAX_ERROR_CHARS = 240;

/**
 * A store/ledger error rendered for a log line and for `lastError`.
 *
 * Both destinations are read by operators and neither is an audit trail, so the
 * uid is redacted and anything that looks like a credential is stripped:
 * provider clients love to echo the failing URL (which carries the uid) and the
 * Authorization header back inside the error message.
 */
export function describeError(err: unknown, uid?: string): string {
  let text: string;
  if (err instanceof BillingStateError) text = `BillingStateError(${err.code}): ${err.message}`;
  else if (err instanceof Error) text = `${err.name}: ${err.message}`;
  else text = String(err);
  text = text.replace(BEARER_RE, (m) => `${m.split(/[=:\s]/)[0]} ***`);
  if (uid) text = text.split(uid).join(redactId(uid));
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

// ── the store seam ──────────────────────────────────────────────────────────

export interface OutboxStore {
  /**
   * Idempotent CREATE. An id that already exists is left exactly as it is — a
   * replayed append must never reopen an event that has since been committed.
   */
  append(event: UsageEvent): Promise<void>;
  /** Replace an existing event's status/attempts/lastError. */
  update(event: UsageEvent): Promise<void>;
  get(uid: string, id: string): Promise<UsageEvent | null>;
  /** Everything not yet committed for one tenant, oldest first. */
  listOpen(uid: string): Promise<UsageEvent[]>;
  /** Tenants that may have open events. May over-report; never under-report. */
  listTenants(): Promise<string[]>;
}

/** In-memory adapter: the test double, and the store when nothing is durable. */
export class MemoryOutboxStore implements OutboxStore {
  readonly calls: Array<{ op: string; uid?: string; id?: string }> = [];
  private readonly events = new Map<string, Map<string, UsageEvent>>();
  constructor(
    private readonly opts: {
      faults?: {
        append?: (event: UsageEvent) => Error | undefined;
        update?: (event: UsageEvent) => Error | undefined;
        list?: () => Error | undefined;
      };
    } = {},
  ) {}

  private tenant(uid: string): Map<string, UsageEvent> {
    let t = this.events.get(uid);
    if (!t) this.events.set(uid, (t = new Map()));
    return t;
  }

  async append(event: UsageEvent): Promise<void> {
    this.calls.push({ op: "append", uid: event.uid, id: event.id });
    const fault = this.opts.faults?.append?.(event);
    if (fault) throw fault;
    const t = this.tenant(event.uid);
    if (t.has(event.id)) return;
    t.set(event.id, { ...event });
  }

  async update(event: UsageEvent): Promise<void> {
    this.calls.push({ op: "update", uid: event.uid, id: event.id });
    const fault = this.opts.faults?.update?.(event);
    if (fault) throw fault;
    this.tenant(event.uid).set(event.id, { ...event });
  }

  async get(uid: string, id: string): Promise<UsageEvent | null> {
    this.calls.push({ op: "get", uid, id });
    const found = this.events.get(uid)?.get(id);
    return found ? { ...found } : null;
  }

  async listOpen(uid: string): Promise<UsageEvent[]> {
    this.calls.push({ op: "listOpen", uid });
    const fault = this.opts.faults?.list?.();
    if (fault) throw fault;
    return [...(this.events.get(uid)?.values() ?? [])]
      .filter((e) => e.status !== "committed")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((e) => ({ ...e }));
  }

  async listTenants(): Promise<string[]> {
    this.calls.push({ op: "listTenants" });
    const fault = this.opts.faults?.list?.();
    if (fault) throw fault;
    return [...this.events.entries()]
      .filter(([, t]) => [...t.values()].some((e) => e.status !== "committed"))
      .map(([uid]) => uid);
  }
}

// ── local edition: append-only JSONL beside usage.jsonl ─────────────────────

/** Compact once the log passes this many lines. */
const JSONL_MAX_LINES = 4000;
/** Committed events are kept this long for a human comparing against usage.jsonl. */
const JSONL_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The tenant's billing directory.
 *
 * Inside a home scope we are servicing that tenant's own request and the active
 * home already IS its subtree (which is also what the Mac edition's single home
 * means). The reconciler runs OUTSIDE any scope and addresses tenants by uid,
 * so it resolves the cloud layout explicitly.
 */
function billingDirFor(uid: string): string {
  const scoped = homeScope.getStore();
  return path.join(scoped ?? homeForUid(uid), "billing");
}
function outboxFile(uid: string): string {
  return path.join(billingDirFor(uid), "outbox.jsonl");
}
function outboxLock(uid: string): string {
  return path.join(billingDirFor(uid), "outbox.lock");
}

function parseEvent(line: string): UsageEvent | null {
  try {
    const raw = JSON.parse(line) as Partial<UsageEvent>;
    if (typeof raw.id !== "string" || !raw.id) return null;
    if (typeof raw.uid !== "string" || typeof raw.costMicros !== "number") return null;
    if (typeof raw.createdAt !== "number" || typeof raw.attempts !== "number") return null;
    return raw as UsageEvent;
  } catch {
    return null;
  }
}

/**
 * Local adapter. Append-only: every state change is a new line and the LAST
 * line for an id wins on replay, so a torn write costs at most the newest
 * transition — never an earlier one. Appends take the tenant's billing lock so
 * that "does this id already exist?" and "write it" cannot interleave, and so
 * compaction can never drop a line that landed while it was rewriting.
 */
export class JsonlOutboxStore implements OutboxStore {
  private async replay(uid: string): Promise<Map<string, UsageEvent>> {
    const text = await readTextOrEmpty(outboxFile(uid));
    const byId = new Map<string, UsageEvent>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const event = parseEvent(line);
      if (event) byId.set(event.id, event);
    }
    return byId;
  }

  async append(event: UsageEvent): Promise<void> {
    await withFileLock(outboxLock(event.uid), async () => {
      const existing = (await this.replay(event.uid)).get(event.id);
      if (existing) return;
      await appendLine(outboxFile(event.uid), JSON.stringify(event));
    });
  }

  async update(event: UsageEvent): Promise<void> {
    await withFileLock(outboxLock(event.uid), async () => {
      await appendLine(outboxFile(event.uid), JSON.stringify(event));
      await this.compact(event.uid);
    });
  }

  async get(uid: string, id: string): Promise<UsageEvent | null> {
    return (await this.replay(uid)).get(id) ?? null;
  }

  async listOpen(uid: string): Promise<UsageEvent[]> {
    return [...(await this.replay(uid)).values()]
      .filter((e) => e.status !== "committed")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async listTenants(): Promise<string[]> {
    const scoped = homeScope.getStore();
    // Inside a scope there is exactly one tenant to look at; the reconciler
    // (unscoped) walks the cloud layout.
    if (scoped) return [];
    const fs = await import("node:fs/promises");
    let entries: string[];
    try {
      entries = (await fs.readdir(path.join(lisaGlobalHome(), "users"), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: string[] = [];
    for (const uid of entries) {
      if ((await this.listOpen(uid)).length) out.push(uid);
    }
    return out;
  }

  /** Best-effort: drop committed events past the retention window. Caller holds the lock. */
  private async compact(uid: string): Promise<void> {
    try {
      const file = outboxFile(uid);
      const text = await readTextOrEmpty(file);
      const lines = text.split("\n").filter(Boolean);
      if (lines.length <= JSONL_MAX_LINES) return;
      const cutoff = Date.now() - JSONL_RETENTION_MS;
      const kept = [...(await this.replay(uid)).values()].filter(
        (e) => e.status !== "committed" || e.createdAt >= cutoff,
      );
      await atomicWrite(file, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch (err) {
      // Losing a compaction only wastes disk; losing an event would lose money,
      // so this never propagates.
      logError(
        `[billing] outbox compaction failed (uid ${redactId(uid)}): ${describeError(err, uid)}`,
      );
    }
  }
}

// ── cloud edition: Firestore ────────────────────────────────────────────────

// lisa-outbox/{uid}                 — the tenant's OPEN index  { uid, open: [ids] }
// lisa-outbox/{uid}/events/{id}     — the event itself, created id-keyed
// lisa-outbox-tenants/{shard}       — sticky registry of tenants that ever opened one
const TENANT_SHARDS = 8;

/** Exported for tests: sharding must be deterministic and stay in range. */
export function tenantShard(uid: string): string {
  const h = crypto.createHash("sha256").update(uid).digest();
  return `lisa-outbox-tenants/${h[0]! % TENANT_SHARDS}`;
}

/** Exported for tests: this is the append idempotency classification. */
export function isAlreadyExists(err: unknown): boolean {
  return err instanceof FirestoreError && (err.status === 409 || err.status === 412);
}

/**
 * Cloud adapter. The event document is created with an `exists:false`
 * precondition so creation is idempotent by id, and every listing goes through
 * a per-tenant index document because the Firestore client here has no query
 * API — an index write is one extra CAS on a document only this tenant writes,
 * which is the same cost profile as the balance itself.
 *
 * The tenant registry is STICKY on purpose: adding a uid is skipped entirely
 * once this process has seen it, so the steady-state cost is zero writes on a
 * shared document. Entries are pruned lazily, by the reconciler, when a
 * tenant's index turns out to be empty.
 */
export class FirestoreOutboxStore implements OutboxStore {
  private readonly registered = new Set<string>();

  async append(event: UsageEvent): Promise<void> {
    // Index FIRST: a dangling id is self-healing (listOpen prunes ids with no
    // document), whereas an event nothing indexes would be invisible forever.
    await this.registerTenant(event.uid);
    await casUpdate(`lisa-outbox/${event.uid}`, (current) => {
      const open = readIds(current);
      if (open.includes(event.id)) return { next: null, result: undefined };
      return { next: { uid: event.uid, open: [...open, event.id] }, result: undefined };
    });
    try {
      await setDoc(`lisa-outbox/${event.uid}/events/${event.id}`, toDoc(event), { exists: false });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err; // already durable: an idempotent replay
    }
  }

  async update(event: UsageEvent): Promise<void> {
    await setDoc(`lisa-outbox/${event.uid}/events/${event.id}`, toDoc(event));
    if (event.status !== "committed") return;
    await casUpdate(`lisa-outbox/${event.uid}`, (current) => {
      const open = readIds(current).filter((id) => id !== event.id);
      if (open.length === readIds(current).length) return { next: null, result: undefined };
      return { next: { uid: event.uid, open }, result: undefined };
    });
  }

  async get(uid: string, id: string): Promise<UsageEvent | null> {
    const doc = await getDoc(`lisa-outbox/${uid}/events/${id}`);
    return doc ? fromDoc(doc.data) : null;
  }

  async listOpen(uid: string): Promise<UsageEvent[]> {
    const index = await getDoc(`lisa-outbox/${uid}`);
    const ids = readIds(index?.data ?? null);
    const events: UsageEvent[] = [];
    const stale: string[] = [];
    for (const id of ids) {
      const event = await this.get(uid, id);
      if (!event || event.status === "committed") stale.push(id);
      else events.push(event);
    }
    // Prune when something is stale, and ALSO when a tenant has simply drained:
    // update() removes a committed id from the index directly, so a tenant that
    // settles cleanly never produces a stale id and used to stay in the sticky
    // registry forever. The reconciler walks that registry every 15 minutes, so
    // the sweep's cost grew with every account that ever bought anything and
    // never came back down.
    //
    // `index !== null` is load-bearing: append() registers the tenant BEFORE it
    // writes the index, so a concurrent sweep can see a registered uid whose
    // index document does not exist yet. Deregistering on that would strand the
    // event being appended — its charge would never be reconciled. An index that
    // EXISTS and is empty can only mean drained.
    if (stale.length) await this.pruneIndex(uid, stale);
    else if (index && ids.length === 0) await this.forgetTenant(uid);
    return events.sort((a, b) => a.createdAt - b.createdAt);
  }

  async listTenants(): Promise<string[]> {
    const out = new Set<string>();
    for (let shard = 0; shard < TENANT_SHARDS; shard++) {
      const doc = await getDoc(`lisa-outbox-tenants/${shard}`);
      for (const uid of readIds(doc?.data ?? null, "uids")) out.add(uid);
    }
    return [...out];
  }

  private async registerTenant(uid: string): Promise<void> {
    if (this.registered.has(uid)) return;
    await casUpdate(tenantShard(uid), (current) => {
      const uids = readIds(current, "uids");
      if (uids.includes(uid)) return { next: null, result: undefined };
      return { next: { uids: [...uids, uid] }, result: undefined };
    });
    this.registered.add(uid);
  }

  private async pruneIndex(uid: string, stale: string[]): Promise<void> {
    try {
      const remaining = await casUpdate(`lisa-outbox/${uid}`, (current) => {
        const open = readIds(current).filter((id) => !stale.includes(id));
        return { next: { uid, open }, result: open.length };
      });
      if (remaining > 0) return;
      await this.forgetTenant(uid);
    } catch (err) {
      logInfo(
        `[billing] outbox index prune skipped (uid ${redactId(uid)}): ${describeError(err, uid)}`,
      );
    }
  }

  /**
   * Drop a drained tenant from the sticky registry. Best-effort by design: a
   * uid left behind only costs one extra getDoc per sweep, while a failure that
   * propagated would abort a reconcile pass that has real work queued behind it.
   */
  private async forgetTenant(uid: string): Promise<void> {
    try {
      await casUpdate(tenantShard(uid), (current) => {
        const uids = readIds(current, "uids").filter((u) => u !== uid);
        return { next: { uids }, result: undefined };
      });
      this.registered.delete(uid);
    } catch (err) {
      logInfo(
        `[billing] outbox tenant deregister skipped (uid ${redactId(uid)}): ${describeError(err, uid)}`,
      );
    }
  }
}

/** Exported for tests: defensive parse of a Firestore array field. */
export function readIds(data: Record<string, unknown> | null, field = "open"): string[] {
  const raw = data?.[field];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}
/** Exported for tests: a money record must survive the round trip intact. */
export function toDoc(event: UsageEvent): Record<string, unknown> {
  return { ...event, lastError: event.lastError ?? "" };
}
export function fromDoc(data: Record<string, unknown>): UsageEvent {
  const event = { ...data } as unknown as UsageEvent;
  if (!event.lastError) delete event.lastError;
  return event;
}

let defaultStore: OutboxStore | null = null;
/** The adapter for this edition. Firestore in the cloud, JSONL everywhere else. */
export function defaultOutboxStore(): OutboxStore {
  defaultStore ??= firestoreEnabled() ? new FirestoreOutboxStore() : new JsonlOutboxStore();
  return defaultStore;
}
/** Tests only: forget the memoized adapter after changing LISA_FIRESTORE. */
export function _resetOutboxStoreForTests(): void {
  defaultStore = null;
}

// ── settlement ──────────────────────────────────────────────────────────────

export interface SettlementDeps {
  store: OutboxStore;
  /**
   * Move the money. `eventId` is the ledger's idempotency key: a replay of an
   * id already applied MUST return false without changing the balance.
   */
  debit(acct: AccountRecord, event: UsageEvent, eventId?: string): Promise<boolean>;
  now(): number;
  enabled(): boolean;
}

export interface CommitOutcome {
  /** True when this call actually moved the balance (false for a refused replay). */
  applied: boolean;
  /** True when the event's `committed` status is durable. */
  committed: boolean;
}

export interface SettlementResult extends CommitOutcome {
  /** The outbox event id, or null when nothing durable was written. */
  eventId: string | null;
}

/** LISA_BILLING_OUTBOX: default ON; "0"/"false"/"off" disables the outbox write only. */
export function outboxEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.LISA_BILLING_OUTBOX?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** Debit through the real ledger, inside the tenant's home scope. */
export const defaultDebit: SettlementDeps["debit"] = (acct, event, eventId) =>
  withTenantHome(acct.uid, () =>
    debitTurn(acct, event.model, event.costMicros, event.createdAt, eventId ? { eventId } : {}),
  );

/**
 * A live settlement already runs inside its tenant's scope, so entering one
 * again would be wrong (the Mac edition's single home is not `users/<uid>`).
 * The reconciler has no scope at all and needs one.
 */
function withTenantHome<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  return homeScope.getStore() ? fn() : homeScope.run(homeForUid(uid), fn);
}

export function defaultSettlementDeps(): SettlementDeps {
  return {
    store: defaultOutboxStore(),
    debit: defaultDebit,
    now: () => Date.now(),
    enabled: outboxEnabled,
  };
}

function wrapDebitError(err: unknown, uid: string): BillingStateError {
  if (err instanceof BillingStateError) return err;
  return new BillingStateError(
    "balance_unavailable",
    `balance commit failed: ${describeError(err, uid)}`,
  );
}

/**
 * Apply one outbox event to the balance and close it out.
 *
 * Throws when the DEBIT fails (the caller must not treat the turn as paid) —
 * having first parked the event so the charge is not forgotten. Does NOT throw
 * when only the "mark committed" write fails: the money is already correct and
 * a thrown error there would tell the caller to retry a charge that landed.
 */
export async function commitUsageEvent(
  event: UsageEvent,
  acct: AccountRecord,
  deps: SettlementDeps,
): Promise<CommitOutcome> {
  const attempts = event.attempts + 1;
  let applied: boolean;
  try {
    applied = await deps.debit(acct, event, event.id);
  } catch (err) {
    const detail = describeError(err, acct.uid);
    const status = parkedStatusAfter(attempts);
    try {
      await deps.store.update({ ...event, status, attempts, lastError: detail });
    } catch (parkErr) {
      logError(
        `[billing] outbox park failed (event ${event.id}, uid ${redactId(acct.uid)}): ` +
          describeError(parkErr, acct.uid),
      );
    }
    logError(
      status === "needs_human"
        ? `[billing] outbox event ${event.id} → needs_human after ${attempts} attempts ` +
            `(uid ${redactId(acct.uid)}, ${event.costMicros} micros, ${event.kind}/${event.model}): ${detail}`
        : `[billing] outbox commit failed (event ${event.id}, uid ${redactId(acct.uid)}, ` +
            `attempt ${attempts}/${MAX_COMMIT_ATTEMPTS}, ${event.costMicros} micros): ${detail}`,
    );
    throw wrapDebitError(err, acct.uid);
  }
  let committed = true;
  try {
    await deps.store.update({ ...event, status: "committed", attempts, lastError: undefined });
  } catch (err) {
    committed = false;
    logError(
      `[billing] outbox mark-committed failed (event ${event.id}, uid ${redactId(acct.uid)}) — ` +
        `the debit LANDED, the reconciler will close the record: ${describeError(err, acct.uid)}`,
    );
  }
  return { applied, committed };
}

/**
 * Settle one metered turn: durable record first, money second.
 *
 * Fails closed on an outbox write failure — the caller releases its permit and
 * gets a retryable error rather than a turn that was paid for but unrecorded.
 */
export async function settleUsage(
  input: SettlementInput,
  deps: SettlementDeps = defaultSettlementDeps(),
): Promise<SettlementResult> {
  if (!(input.costMicros > 0)) return { eventId: null, applied: false, committed: true };
  const event = newUsageEvent(input, deps.now());

  if (!deps.enabled()) {
    // Flag off: no durable record, but the pre-T-8 debit path is untouched —
    // including its fail-closed behaviour on a balance-store failure.
    try {
      const applied = await deps.debit(input.acct, event, undefined);
      return { eventId: null, applied, committed: true };
    } catch (err) {
      throw wrapDebitError(err, input.acct.uid);
    }
  }

  try {
    await deps.store.append(event);
  } catch (err) {
    const detail = describeError(err, input.acct.uid);
    logError(
      `[billing] outbox append failed — settlement refused, nothing charged ` +
        `(event ${event.id}, uid ${redactId(input.acct.uid)}, ${event.costMicros} micros): ${detail}`,
    );
    throw new BillingStateError("outbox_unavailable", `usage outbox is unavailable: ${detail}`);
  }

  const outcome = await commitUsageEvent(event, input.acct, deps);
  return { eventId: event.id, ...outcome };
}
