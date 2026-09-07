/**
 * Reconciler behaviour for the usage outbox (T-8): retry budget, escalation
 * to needs_human, dry-run, tenant filtering, staleness, the startup timer and
 * the operator CLI report.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reconcile-"));
process.env.LISA_HOME = TMP;
delete process.env.LISA_FIRESTORE;
// log.ts routes through console.error only in text mode; captureLogs() below
// hooks console, so pin the format instead of inheriting K_SERVICE from CI.
process.env.LISA_LOG_FORMAT = "text";

import type { AccountRecord } from "../web/accounts.js";
import type { ReconcileDeps } from "./reconcile.js";
import { cmdBillingReconcile } from "../cli/billing-reconcile.js";
import type { SettlementDeps, UsageEvent } from "./outbox.js";

const { MemoryOutboxStore, newUsageEvent, SETTLED_REPLAY_WINDOW_MS } = await import("./outbox.js");
const {
  reconcileOnce,
  startBillingReconciler,
  RECONCILE_MAX_ATTEMPTS,
  RECONCILE_PENDING_GRACE_MS,
} = await import("./reconcile.js");
const { redactId } = await import("../log.js");

const T0 = Date.parse("2026-09-06T08:00:00Z");
const UID = "em-reconcile-secret-0001";
const ACCT: AccountRecord = {
  uid: UID,
  kind: "email",
  email: "r@example.com",
  createdAt: T0,
  lastLoginAt: T0,
  verified: true,
  sessionVersion: 0,
};
const USAGE = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };

function event(overrides: Partial<UsageEvent> = {}, acct: AccountRecord = ACCT): UsageEvent {
  const ev = newUsageEvent(
    { acct, kind: "gw", model: "claude-sonnet-4-6", usage: USAGE, costMicros: 777, reservationId: "r" },
    T0 - 2 * RECONCILE_PENDING_GRACE_MS,
  );
  return { ...ev, ...overrides };
}

function ledger(opts: { fail?: boolean } = {}) {
  const applied = new Set<string>();
  const state = { calls: 0, balance: 0, fail: opts.fail ?? false };
  const debit: SettlementDeps["debit"] = async (_acct, ev, eventId) => {
    state.calls += 1;
    if (state.fail) throw new Error(`ledger down for ${UID}`);
    if (eventId && applied.has(eventId)) return false;
    if (eventId) applied.add(eventId);
    state.balance -= ev.costMicros;
    return true;
  };
  return { debit, state };
}

function deps(
  store: InstanceType<typeof MemoryOutboxStore>,
  l: ReturnType<typeof ledger>,
  overrides: Partial<ReconcileDeps> = {},
): ReconcileDeps {
  return { store, debit: l.debit, loadAccount: async () => ACCT, now: () => T0, ...overrides };
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = origErr;
      console.log = origLog;
    },
  };
}

/**
 * Wait for a condition instead of for a fixed number of milliseconds: these
 * tests exercise real timers, and under a loaded `npm test` a 15ms interval
 * routinely slips past any fixed sleep. The deadline is the failure mode.
 */
async function until(cond: () => boolean, deadlineMs = 3000): Promise<boolean> {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});

describe("reconcileOnce", () => {
  test("retries a failed event while under the attempt cap, then escalates with a structured ERROR", async () => {
    const store = new MemoryOutboxStore();
    const l = ledger({ fail: true });
    const ev = event({ status: "failed", attempts: 1, lastError: "first failure" });
    await store.append(ev);
    // attempts 1 → cap-1: each pass fails and bumps attempts.
    for (let attempt = ev.attempts; attempt < RECONCILE_MAX_ATTEMPTS - 1; attempt++) {
      const r = await reconcileOnce({}, deps(store, l));
      assert.equal(r.failed, 1, `attempt ${attempt}`);
      assert.equal(r.escalated, 0);
      const live = (await store.get(UID, ev.id))!;
      assert.equal(live.status, "failed");
      assert.equal(live.attempts, attempt + 1);
      assert.ok(!live.lastError!.includes(UID));
    }
    // The last allowed attempt fails ⇒ needs_human.
    const r = await reconcileOnce({}, deps(store, l));
    assert.equal(r.escalated, 1);
    assert.equal(r.failed, 0);
    const live = (await store.get(UID, ev.id))!;
    assert.equal(live.status, "needs_human");
    assert.equal(live.attempts, RECONCILE_MAX_ATTEMPTS);
    const line = logs.lines.find((x) => x.includes("needs_human"));
    assert.ok(line, "escalation must be logged");
    assert.ok(line.includes("[billing]"));
    assert.ok(line.includes(ev.id));
    assert.ok(line.includes(redactId(UID)));
    assert.ok(!line.includes(UID), `raw uid in escalation log: ${line}`);
    assert.ok(line.includes("777"), "the amount at stake is part of the operator's handle");
    // needs_human is parked: later passes skip it, even when the ledger is back.
    l.state.fail = false;
    const parked = await reconcileOnce({}, deps(store, l));
    assert.equal(parked.skipped, 1);
    assert.equal(parked.committed, 0);
    assert.equal(l.state.balance, 0);
    // --retry-human gives it one more cycle.
    const retried = await reconcileOnce({ retryHuman: true }, deps(store, l));
    assert.equal(retried.committed, 1);
    assert.equal(l.state.balance, -777);
    assert.equal((await store.get(UID, ev.id))!.status, "committed");
  });

  test("dry run reports what it would do and writes nothing", async () => {
    const store = new MemoryOutboxStore();
    const l = ledger();
    const pending = event();
    const failed = event({ status: "failed", attempts: 2 });
    const human = event({ status: "needs_human", attempts: RECONCILE_MAX_ATTEMPTS });
    const fresh = event({ createdAt: T0 - 1000 });
    for (const ev of [pending, failed, human, fresh]) await store.append(ev);
    store.calls.length = 0;
    const r = await reconcileOnce({ dryRun: true }, deps(store, l));
    assert.equal(r.dryRun, true);
    assert.equal(r.scanned, 4);
    assert.equal(r.committed, 2, "pending + failed would be committed");
    assert.equal(r.skipped, 2, "needs_human + within-grace are skipped");
    assert.equal(r.escalated, 0);
    assert.equal(l.state.calls, 0, "dry run never debits");
    assert.deepEqual(store.calls.filter((c) => c.op !== "listOpen" && c.op !== "listTenants" && c.op !== "get"), []);
    assert.equal((await store.get(UID, pending.id))!.status, "pending");
  });

  test("a missing account cannot be charged: escalated, never silently dropped", async () => {
    const store = new MemoryOutboxStore();
    const l = ledger();
    const ev = event();
    await store.append(ev);
    const r = await reconcileOnce({}, deps(store, l, { loadAccount: async () => null }));
    assert.equal(r.escalated, 1);
    assert.equal(l.state.calls, 0);
    const live = (await store.get(UID, ev.id))!;
    assert.equal(live.status, "needs_human");
    assert.match(live.lastError!, /account_missing/);
  });

  test("an event older than the ledger's replay window is escalated instead of re-applied", async () => {
    const store = new MemoryOutboxStore();
    const l = ledger();
    const ev = event({ createdAt: T0 - SETTLED_REPLAY_WINDOW_MS - 1 });
    await store.append(ev);
    const r = await reconcileOnce({}, deps(store, l));
    assert.equal(r.escalated, 1);
    assert.equal(l.state.calls, 0, "the idempotency key may have aged out — a replay could double charge");
    assert.match((await store.get(UID, ev.id))!.lastError!, /replay_window/);
  });

  test("scans every tenant, or only --uid; reports the tenant count", async () => {
    const store = new MemoryOutboxStore();
    const l = ledger();
    const other: AccountRecord = { ...ACCT, uid: "em-other" };
    await store.append(event());
    await store.append(event({}, other));
    const only = await reconcileOnce(
      { uid: "em-other" },
      deps(store, l, { loadAccount: async (uid) => (uid === "em-other" ? other : ACCT) }),
    );
    assert.equal(only.tenants, 1);
    assert.equal(only.committed, 1);
    assert.equal((await store.listOpen(UID)).length, 1);
    const all = await reconcileOnce(
      {},
      deps(store, l, { loadAccount: async (uid) => (uid === "em-other" ? other : ACCT) }),
    );
    assert.equal(all.tenants, 1, "em-other has nothing open any more");
    assert.equal(all.committed, 1);
    assert.equal(l.state.balance, -777 * 2);
  });

  test("a store that cannot be listed fails the run loudly rather than reporting a clean sweep", async () => {
    const store = new MemoryOutboxStore({ faults: { list: () => new Error("index unreadable") } });
    const l = ledger();
    await store.append(event());
    await assert.rejects(reconcileOnce({}, deps(store, l)), /index unreadable/);
    assert.equal(l.state.calls, 0);
  });
});

describe("startBillingReconciler", () => {
  test("runs after the initial delay, then on the interval, and stop() ends it", async () => {
    let runs = 0;
    const handle = startBillingReconciler({
      initialDelayMs: 5,
      intervalMs: 15,
      run: async () => {
        runs += 1;
        return { scanned: 0, committed: 0, escalated: 0, skipped: 0, failed: 0, tenants: 0, dryRun: false };
      },
    });
    assert.ok(await until(() => runs >= 2), `expected the initial run plus at least one tick, got ${runs}`);
    handle.stop();
    const seen = runs;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(runs, seen, "no runs after stop()");
  });

  test("a run that cannot take the cross-instance lock is skipped, and a throwing run never kills the timer", async () => {
    let attempts = 0;
    let locks = 0;
    const handle = startBillingReconciler({
      initialDelayMs: 1,
      intervalMs: 5,
      acquireRunLock: async () => {
        locks += 1;
        return locks === 1 ? null : async () => {};
      },
      run: async () => {
        attempts += 1;
        throw new Error("boom");
      },
    });
    assert.ok(await until(() => attempts >= 2), `expected at least two attempted runs, got ${attempts}`);
    handle.stop();
    assert.ok(locks >= 2);
    assert.equal(attempts, locks - 1, "the first lock refusal skipped the run; later ticks ran and threw");
    assert.ok(logs.lines.some((l) => l.includes("[billing]") && l.includes("boom")));
  });

  test("overlapping ticks do not run concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let runs = 0;
    const handle = startBillingReconciler({
      initialDelayMs: 1,
      intervalMs: 2,
      run: async () => {
        runs += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return { scanned: 0, committed: 0, escalated: 0, skipped: 0, failed: 0, tenants: 0, dryRun: false };
      },
    });
    // Several intervals must elapse while one run is still in flight.
    assert.ok(await until(() => runs >= 2), `expected the run to be re-entered, got ${runs}`);
    handle.stop();
    await until(() => inFlight === 0);
    assert.equal(maxInFlight, 1);
  });
});

describe("lisa billing reconcile (operator CLI)", () => {
  test("--dry-run --json prints the report without touching the store", async () => {
    const store = new MemoryOutboxStore();
    const l = ledger();
    await store.append(event());
    await cmdBillingReconcile(["--dry-run", "--json"], deps(store, l));
    const json = logs.lines.find((x) => x.trim().startsWith("{"));
    assert.ok(json, "a JSON report line");
    const report = JSON.parse(json) as { scanned: number; committed: number; dryRun: boolean };
    assert.equal(report.dryRun, true);
    assert.equal(report.scanned, 1);
    assert.equal(report.committed, 1);
    assert.equal(l.state.calls, 0);
    assert.equal(process.exitCode ?? 0, 0);
  });

  test("the default text report names every counter; --uid narrows the scan; --resolve closes a parked event by hand", async () => {
    const store = new MemoryOutboxStore();
    const l = ledger();
    const parked = event({ status: "needs_human", attempts: RECONCILE_MAX_ATTEMPTS, lastError: "x" });
    await store.append(parked);
    await cmdBillingReconcile(["--uid", UID], deps(store, l));
    const text = logs.lines.join("\n");
    for (const key of ["scanned", "committed", "escalated", "skipped", "failed"]) {
      assert.ok(text.includes(key), `report mentions ${key}`);
    }
    assert.ok(text.includes(parked.id), "parked events are listed with their id for the operator");
    logs.lines.length = 0;
    // The operator fixed the balance by hand and closes the event without a debit.
    await cmdBillingReconcile(["--uid", UID, "--resolve", parked.id], deps(store, l));
    assert.equal((await store.get(UID, parked.id))!.status, "committed");
    assert.equal(l.state.calls, 0, "resolve never debits");
    assert.ok(logs.lines.some((x) => x.includes(parked.id) && x.includes("resolved")));
    // Resolving something that is not parked is refused.
    logs.lines.length = 0;
    await cmdBillingReconcile(["--uid", UID, "--resolve", "nope"], deps(store, l));
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });
});
