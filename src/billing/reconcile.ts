/**
 * Billing reconciler (T-8) — the compensator for a torn settlement.
 *
 * outbox.ts guarantees that a charge is either invisible or recorded. This is
 * what turns "recorded" back into "settled": it sweeps every open usage event,
 * re-applies the balance commit idempotently, and escalates what it cannot fix
 * to a human instead of guessing (.codex/INVARIANTS.md 计费与交易 §1/§5).
 *
 * Three ways an event reaches this module:
 *   pending      the process died between the durable append and the debit;
 *   failed       the debit was attempted and the balance store said no;
 *   needs_human  the retry budget ran out, or a replay would not be provably
 *                safe — parked until an operator looks.
 *
 * Everything here is safe to run concurrently with live traffic: the debit
 * carries the event id, and the ledger refuses an id it already applied.
 */
import crypto from "node:crypto";
import type { AccountRecord } from "../web/accounts.js";
import { getAccount } from "../web/accounts.js";
import { logError, logInfo, redactId } from "../log.js";
import { firestoreEnabled, acquireLease, releaseLease as releaseFsLease } from "../cloud/firestore.js";
import {
  commitUsageEvent,
  defaultDebit,
  defaultOutboxStore,
  describeError,
  parkedStatusAfter,
  MAX_COMMIT_ATTEMPTS,
  SETTLED_REPLAY_WINDOW_MS,
  type OutboxStore,
  type SettlementDeps,
  type UsageEvent,
} from "./outbox.js";

export const RECONCILE_MAX_ATTEMPTS = MAX_COMMIT_ATTEMPTS;

/**
 * How long a `pending` event is left alone.
 *
 * A pending event younger than this may still be owned by a settlement in
 * flight in another process. Racing it is harmless to the money (the ledger key
 * refuses the double) but it would burn the retry budget on an event that was
 * about to close itself, and it would log failures that are not failures.
 */
export const RECONCILE_PENDING_GRACE_MS = 5 * 60_000;

/** Reconciler cadence. */
export const RECONCILE_INTERVAL_MS = 15 * 60_000;
const RECONCILE_INITIAL_DELAY_MS = 30_000;
/** Cross-instance lock TTL — comfortably longer than a pass, shorter than the interval. */
const RECONCILE_LOCK_TTL_MS = 5 * 60_000;

export interface ReconcileOptions {
  /** Report what would happen; write nothing, debit nothing. */
  dryRun?: boolean;
  /** Restrict the sweep to one tenant. */
  uid?: string;
  /** Give parked (needs_human) events one more automatic cycle. */
  retryHuman?: boolean;
  /** Override the clock (tests, and the CLI's single-shot run). */
  now?: number;
}

/** A parked event, named so an operator can act on it. */
export interface ParkedRef {
  id: string;
  uid: string;
  costMicros: number;
  attempts: number;
  lastError?: string;
}

export interface ReconcileReport {
  /** Open events examined. */
  scanned: number;
  /** Events settled by this pass (or that would be, in a dry run). */
  committed: number;
  /** Events moved to needs_human by this pass. */
  escalated: number;
  /** Events deliberately left alone (parked, or still inside the grace period). */
  skipped: number;
  /** Events that failed this attempt but keep their retry budget. */
  failed: number;
  /** Tenants that actually had an open event. */
  tenants: number;
  dryRun: boolean;
  /** Everything currently waiting for a human, for the operator report. */
  parked?: ParkedRef[];
}

export interface ReconcileDeps {
  store: OutboxStore;
  debit: SettlementDeps["debit"];
  loadAccount(uid: string): Promise<AccountRecord | null>;
  now(): number;
}

export function defaultReconcileDeps(): ReconcileDeps {
  return {
    store: defaultOutboxStore(),
    debit: defaultDebit,
    loadAccount: getAccount,
    now: () => Date.now(),
  };
}

function refOf(event: UsageEvent): ParkedRef {
  return {
    id: event.id,
    uid: event.uid,
    costMicros: event.costMicros,
    attempts: event.attempts,
    ...(event.lastError ? { lastError: event.lastError } : {}),
  };
}

/**
 * Park an event a machine must not decide about. The reason is written into
 * `lastError` because that is what `lisa billing reconcile` shows the operator.
 */
async function park(
  deps: ReconcileDeps,
  event: UsageEvent,
  reason: string,
  dryRun: boolean,
): Promise<void> {
  logError(
    `[billing] outbox event ${event.id} → needs_human (uid ${redactId(event.uid)}, ` +
      `${event.costMicros} micros, ${event.kind}/${event.model}): ${reason}`,
  );
  if (dryRun) return;
  try {
    await deps.store.update({ ...event, status: "needs_human", lastError: reason });
  } catch (err) {
    logError(`[billing] outbox park failed (event ${event.id}): ${describeError(err, event.uid)}`);
  }
}

/**
 * One reconciliation pass.
 *
 * Throws only when the STORE cannot be listed: reporting a clean sweep over a
 * store we could not read would be the most dangerous possible lie here.
 */
export async function reconcileOnce(
  opts: ReconcileOptions = {},
  deps: ReconcileDeps = defaultReconcileDeps(),
): Promise<ReconcileReport> {
  const now = opts.now ?? deps.now();
  const dryRun = !!opts.dryRun;
  const report: ReconcileReport = {
    scanned: 0,
    committed: 0,
    escalated: 0,
    skipped: 0,
    failed: 0,
    tenants: 0,
    dryRun,
    parked: [],
  };
  const uids = opts.uid ? [opts.uid] : await deps.store.listTenants();

  for (const uid of uids) {
    const open = await deps.store.listOpen(uid);
    if (!open.length) continue;
    report.tenants += 1;
    // One account read per tenant, and only once we know we have work.
    let acct: AccountRecord | null | undefined;

    for (const event of open) {
      report.scanned += 1;

      if (event.status === "needs_human" && !opts.retryHuman) {
        report.skipped += 1;
        report.parked!.push(refOf(event));
        continue;
      }
      if (event.status === "pending" && now - event.createdAt < RECONCILE_PENDING_GRACE_MS) {
        report.skipped += 1;
        continue;
      }
      if (now - event.createdAt > SETTLED_REPLAY_WINDOW_MS) {
        // The ledger may no longer remember this id, so "re-apply" and "charge
        // a second time" are indistinguishable. A person decides.
        report.escalated += 1;
        report.parked!.push(refOf(event));
        await park(deps, event, "replay_window: older than the balance ledger's idempotency window", dryRun);
        continue;
      }

      if (acct === undefined) acct = await deps.loadAccount(uid);
      if (!acct) {
        report.escalated += 1;
        report.parked!.push(refOf(event));
        await park(deps, event, "account_missing: no account record for this uid", dryRun);
        continue;
      }
      if (dryRun) {
        report.committed += 1;
        continue;
      }

      try {
        await commitUsageEvent(event, acct, {
          store: deps.store,
          debit: deps.debit,
          now: () => now,
          enabled: () => true,
        });
        report.committed += 1;
      } catch {
        // commitUsageEvent has already parked the event and logged the detail;
        // mirror its own escalation rule to classify the outcome.
        if (parkedStatusAfter(event.attempts + 1) === "needs_human") {
          report.escalated += 1;
          report.parked!.push(refOf(event));
        } else {
          report.failed += 1;
        }
      }
    }
  }
  return report;
}

// ── the background timer ────────────────────────────────────────────────────

export interface ReconcilerHandle {
  stop(): void;
}

export interface ReconcilerOptions {
  initialDelayMs?: number;
  intervalMs?: number;
  run?: () => Promise<ReconcileReport>;
  /**
   * Claim this cycle across instances. Returns a release function, or null when
   * another instance already owns it. Doing the sweep twice would be safe (the
   * ledger key refuses the double) but it would double the Firestore reads and
   * duplicate every escalation alert.
   */
  acquireRunLock?: () => Promise<(() => Promise<void>) | null>;
}

async function defaultRunLock(): Promise<(() => Promise<void>) | null> {
  if (!firestoreEnabled()) return async () => {}; // single instance: nothing to arbitrate
  const owner = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const handle = await acquireLease("billing-reconcile", owner, RECONCILE_LOCK_TTL_MS);
  if (!handle) return null;
  return () => releaseFsLease(handle);
}

/**
 * Start the reconciler: once shortly after boot (so a crash's leftovers are
 * settled without waiting a full interval) and then on the interval.
 *
 * The timers are unref'd — reconciliation must never be the reason a process
 * refuses to exit — and a pass that throws is logged, never fatal.
 */
export function startBillingReconciler(opts: ReconcilerOptions = {}): ReconcilerHandle {
  const initialDelayMs = opts.initialDelayMs ?? RECONCILE_INITIAL_DELAY_MS;
  const intervalMs = opts.intervalMs ?? RECONCILE_INTERVAL_MS;
  const run = opts.run ?? (() => reconcileOnce());
  const acquireRunLock = opts.acquireRunLock ?? defaultRunLock;

  let stopped = false;
  let running = false;
  let interval: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    // A slow pass must not stack up behind the interval.
    if (stopped || running) return;
    running = true;
    let release: (() => Promise<void>) | null = null;
    try {
      release = await acquireRunLock();
      if (!release) return;
      const report = await run();
      if (report.committed || report.escalated || report.failed) {
        logInfo(
          `[billing] reconcile: ${report.committed} committed, ${report.failed} retrying, ` +
            `${report.escalated} escalated, ${report.skipped} skipped across ${report.tenants} tenants`,
        );
      }
    } catch (err) {
      logError(`[billing] reconcile pass failed: ${describeError(err)}`);
    } finally {
      running = false;
      if (release) await release().catch(() => {});
    }
  };

  const first = setTimeout(() => {
    if (stopped) return;
    void tick();
    interval = setInterval(() => void tick(), intervalMs);
    interval.unref?.();
  }, initialDelayMs);
  first.unref?.();

  return {
    stop(): void {
      stopped = true;
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}
