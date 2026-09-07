/**
 * Failure-injection suite for the durable usage outbox (T-8).
 *
 * Every test here models one way the two-write settlement ("charge the
 * provider, then debit the balance") can be torn, and asserts the money
 * invariants (.codex/INVARIANTS.md 计费与交易):
 *   - no double charge, no lost charge after reconciliation;
 *   - the outbox append fails CLOSED (no debit, retryable error);
 *   - the admission permit is still releasable after every failure;
 *   - nothing secret (raw uid, bearer tokens) reaches the logs.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-outbox-"));
process.env.LISA_HOME = TMP;
delete process.env.LISA_FIRESTORE;
// log.ts routes through console.error only in text mode; captureLogs() below
// hooks console, so pin the format instead of inheriting K_SERVICE from CI.
process.env.LISA_LOG_FORMAT = "text";

import type { AccountRecord } from "../web/accounts.js";
import type { AdmissionDependencies } from "./admission.js";
import type { UsageEvent, SettlementDeps, SettlementInput } from "./outbox.js";

const {
  MemoryOutboxStore,
  JsonlOutboxStore,
  settleUsage,
  commitUsageEvent,
  newUsageEvent,
  describeError,
  outboxEnabled,
  tenantShard,
  isAlreadyExists,
  readIds,
  toDoc,
  fromDoc,
  defaultOutboxStore,
  _resetOutboxStoreForTests,
} = await import("./outbox.js");
const { reconcileOnce } = await import("./reconcile.js");
const { admitInference } = await import("./admission.js");
const { debitTurn, readBalance, creditPurchase, BillingStateError, SETTLED_MAX } =
  await import("./quota.js");
const { homeScope, homeForUid } = await import("../paths.js");
const { redactId } = await import("../log.js");

const T0 = Date.parse("2026-09-06T08:00:00Z");
const UID = "em-topsecretuid0001";
const ACCT: AccountRecord = {
  uid: UID,
  kind: "email",
  email: "u@example.com",
  createdAt: T0,
  lastLoginAt: T0,
  verified: true,
  sessionVersion: 0,
};
const USAGE = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };

function input(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    acct: ACCT,
    kind: "chat",
    model: "glm-4.6",
    usage: USAGE,
    costMicros: 4_200,
    reservationId: "resv-1",
    ...overrides,
  };
}

/**
 * A balance ledger double with the SAME idempotency contract as quota.ts
 * debitTurn(eventId): a replayed event id returns false and changes nothing.
 * `failTimes` injects a store outage on the next N debits.
 */
function fakeLedger(opts: { failTimes?: number; error?: () => Error } = {}) {
  const applied = new Set<string>();
  let failures = opts.failTimes ?? 0;
  const state = { calls: 0, balance: 0 };
  const debit: SettlementDeps["debit"] = async (_acct, event, eventId) => {
    state.calls += 1;
    if (failures > 0) {
      failures -= 1;
      throw (
        opts.error?.() ?? new Error(`balance store down for ${UID} Bearer sk-secret-token-123456`)
      );
    }
    if (eventId && applied.has(eventId)) return false;
    if (eventId) applied.add(eventId);
    state.balance -= event.costMicros;
    return true;
  };
  return { debit, state, applied };
}

function deps(
  store: InstanceType<typeof MemoryOutboxStore>,
  ledger: ReturnType<typeof fakeLedger>,
  overrides: Partial<SettlementDeps> = {},
): SettlementDeps {
  return { store, debit: ledger.debit, now: () => T0, enabled: () => true, ...overrides };
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = orig;
    },
  };
}

let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
  fs.rmSync(path.join(TMP, "users"), { recursive: true, force: true });
});
afterEach(() => {
  logs.restore();
});

describe("usage outbox — settlement failure injection", () => {
  test("(a) outbox append failure fails CLOSED: nothing debited, retryable BillingStateError", async () => {
    const store = new MemoryOutboxStore({
      faults: { append: () => new Error(`ENOSPC writing outbox for ${UID}`) },
    });
    const ledger = fakeLedger();
    await assert.rejects(
      settleUsage(input(), deps(store, ledger)),
      (err: unknown) => err instanceof BillingStateError && err.code === "outbox_unavailable",
    );
    assert.equal(
      ledger.state.calls,
      0,
      "the balance must not be touched when the event is not durable",
    );
    assert.equal(ledger.state.balance, 0);
    assert.deepEqual(await store.listOpen(UID), []);
    // Logged loudly, but never with the raw uid.
    const line = logs.lines.find((l) => l.includes("[billing]") && l.includes("outbox"));
    assert.ok(line, "an append failure must be logged");
    assert.ok(!line.includes(UID), `raw uid leaked into logs: ${line}`);
    assert.ok(line.includes(redactId(UID)));
  });

  test("(b) balance commit failure after a durable append: event is 'failed', settle throws, reconciler finishes it once", async () => {
    const store = new MemoryOutboxStore();
    const ledger = fakeLedger({ failTimes: 1 });
    await assert.rejects(
      settleUsage(input(), deps(store, ledger)),
      (err: unknown) => err instanceof BillingStateError && err.code === "balance_unavailable",
    );
    const open = await store.listOpen(UID);
    assert.equal(open.length, 1);
    const ev = open[0]!;
    assert.equal(ev.status, "failed");
    assert.equal(ev.attempts, 1);
    assert.ok(ev.lastError && !ev.lastError.includes(UID), "lastError must not carry the raw uid");
    assert.ok(!ev.lastError.includes("sk-secret-token"), "lastError must not carry a token");
    assert.equal(ledger.state.balance, 0, "a failed commit must not have charged");

    // The store recovers; the reconciler applies the charge exactly once.
    const report = await reconcileOnce(
      { now: T0 + 60_000 },
      { store, debit: ledger.debit, loadAccount: async () => ACCT, now: () => T0 + 60_000 },
    );
    assert.equal(report.committed, 1);
    assert.equal(report.escalated, 0);
    assert.equal(ledger.state.balance, -4_200);
    assert.deepEqual(await store.listOpen(UID), []);
    assert.equal((await store.get(UID, ev.id))?.status, "committed");
    // A second pass finds nothing and changes nothing.
    const again = await reconcileOnce(
      { now: T0 + 120_000 },
      { store, debit: ledger.debit, loadAccount: async () => ACCT, now: () => T0 + 120_000 },
    );
    assert.equal(again.scanned, 0);
    assert.equal(ledger.state.balance, -4_200);
  });

  test("(c) mark-committed failure after a successful debit: no throw, no second charge, reconciler closes it", async () => {
    let failMark = true;
    const store = new MemoryOutboxStore({
      faults: {
        update: (event) => {
          if (event.status === "committed" && failMark) {
            failMark = false;
            return new Error("outbox write failed after debit");
          }
          return undefined;
        },
      },
    });
    const ledger = fakeLedger();
    const result = await settleUsage(input(), deps(store, ledger));
    assert.ok(result.eventId);
    assert.equal(result.applied, true);
    assert.equal(
      result.committed,
      false,
      "the caller learns the mark did not land, but the turn is paid",
    );
    assert.equal(ledger.state.balance, -4_200);
    // The event is still open; the debit already happened.
    const open = await store.listOpen(UID);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.status, "pending");
    // Reconciliation must NOT debit again: the idempotency key says "already applied".
    const later = T0 + 10 * 60_000;
    const report = await reconcileOnce(
      { now: later },
      { store, debit: ledger.debit, loadAccount: async () => ACCT, now: () => later },
    );
    assert.equal(report.committed, 1);
    assert.equal(ledger.state.balance, -4_200, "double charge");
    assert.equal(ledger.state.calls, 2, "the replay consulted the ledger once and was refused");
    assert.deepEqual(await store.listOpen(UID), []);
  });

  test("(d) process crash between append and commit: the reconciler applies the charge exactly once", async () => {
    const store = new MemoryOutboxStore();
    const ledger = fakeLedger();
    // Simulate the crash: a durable pending event with no commit ever attempted.
    const ev = newUsageEvent(input(), T0 - 10 * 60_000);
    await store.append(ev);
    assert.equal(ev.status, "pending");
    assert.equal(ev.attempts, 0);
    const first = await reconcileOnce(
      { now: T0 },
      { store, debit: ledger.debit, loadAccount: async () => ACCT, now: () => T0 },
    );
    assert.deepEqual(
      {
        scanned: first.scanned,
        committed: first.committed,
        escalated: first.escalated,
        skipped: first.skipped,
        failed: first.failed,
      },
      { scanned: 1, committed: 1, escalated: 0, skipped: 0, failed: 0 },
    );
    assert.equal(ledger.state.balance, -4_200);
    const second = await reconcileOnce(
      { now: T0 + 1 },
      { store, debit: ledger.debit, loadAccount: async () => ACCT, now: () => T0 + 1 },
    );
    assert.equal(second.scanned, 0);
    assert.equal(ledger.state.balance, -4_200);
  });

  test("(d') a pending event younger than the grace period is left alone (a live settlement may own it)", async () => {
    const store = new MemoryOutboxStore();
    const ledger = fakeLedger();
    await store.append(newUsageEvent(input(), T0 - 30_000));
    const report = await reconcileOnce(
      { now: T0 },
      { store, debit: ledger.debit, loadAccount: async () => ACCT, now: () => T0 },
    );
    assert.equal(report.skipped, 1);
    assert.equal(report.committed, 0);
    assert.equal(ledger.state.calls, 0);
  });

  test("(e) replaying the same event is a no-op at every layer", async () => {
    const store = new MemoryOutboxStore();
    const ledger = fakeLedger();
    const ev = newUsageEvent(input(), T0);
    await store.append(ev);
    await store.append({ ...ev }); // idempotent create
    assert.equal((await store.listOpen(UID)).length, 1);
    const first = await commitUsageEvent(ev, ACCT, deps(store, ledger));
    assert.deepEqual(first, { applied: true, committed: true });
    const second = await commitUsageEvent(ev, ACCT, deps(store, ledger));
    assert.deepEqual(second, { applied: false, committed: true });
    assert.equal(ledger.state.balance, -4_200);
    // A committed record can never be reopened by a stale replay of its pending form.
    await store.append({ ...ev, status: "pending", attempts: 0 });
    assert.deepEqual(await store.listOpen(UID), []);
    assert.equal((await store.get(UID, ev.id))?.status, "committed");
  });

  test("(f) via admitInference: a settle failure rejects and the permit still releases the lease exactly once", async () => {
    const calls: string[] = [];
    const d: AdmissionDependencies = {
      preflight: () => ({ ok: true }),
      precheck: async () => ({ ok: true, budgetMicroUSD: 100 }),
      acquire: async () => "off",
      startRenewal: () => () => calls.push("stop"),
      releaseLease: async () => {
        calls.push("release");
      },
      settle: async () => {
        throw new BillingStateError("outbox_unavailable", "outbox append failed");
      },
    };
    const admission = await admitInference(ACCT, "glm-4.6", d);
    assert.ok(admission.ok);
    if (!admission.ok) return;
    assert.ok(admission.permit.reservationId, "a permit carries a reservation id for the outbox");
    await assert.rejects(admission.permit.settle("chat", USAGE), BillingStateError);
    // The caller's finally block:
    await admission.permit.release();
    await admission.permit.release();
    assert.deepEqual(calls, ["stop", "release"]);
  });

  test("(g) no secrets in logs: a store error carrying the uid and a bearer token is redacted", async () => {
    const store = new MemoryOutboxStore();
    const ledger = fakeLedger({
      failTimes: 1,
      error: () =>
        new Error(
          `commit lisa-balances/${UID} failed (503) Authorization: Bearer ya29.secret-token-value`,
        ),
    });
    await assert.rejects(settleUsage(input(), deps(store, ledger)));
    const all = logs.lines.join("\n");
    assert.ok(all.includes("[billing]"), "the failure must be logged");
    assert.ok(!all.includes(UID), `raw uid leaked: ${all}`);
    assert.ok(!all.includes("ya29.secret-token-value"), `token leaked: ${all}`);
    const ev = (await store.listOpen(UID))[0]!;
    assert.ok(all.includes(ev.id), "the event id is the operator's handle and must be logged");
    assert.ok(!ev.lastError!.includes("ya29.secret-token-value"));
  });

  test("(h) LISA_BILLING_OUTBOX=0 skips the outbox write but still debits (existing fail-closed checks untouched)", async () => {
    const store = new MemoryOutboxStore();
    const ledger = fakeLedger();
    const result = await settleUsage(input(), deps(store, ledger, { enabled: () => false }));
    assert.equal(result.eventId, null);
    assert.equal(result.applied, true);
    assert.equal(ledger.state.balance, -4_200);
    assert.deepEqual(await store.listOpen(UID), []);
    assert.deepEqual(
      store.calls.filter((c) => c.op === "append" || c.op === "update"),
      [],
      "the store must not be WRITTEN when the flag is off",
    );
    // ...and a balance failure with the flag off still surfaces as the same retryable error.
    const down = fakeLedger({ failTimes: 1 });
    await assert.rejects(
      settleUsage(input(), deps(store, down, { enabled: () => false })),
      (err: unknown) => err instanceof BillingStateError && err.code === "balance_unavailable",
    );
    assert.equal(outboxEnabled({ LISA_BILLING_OUTBOX: "0" }), false);
    assert.equal(outboxEnabled({ LISA_BILLING_OUTBOX: "false" }), false);
    assert.equal(outboxEnabled({}), true);
    assert.equal(outboxEnabled({ LISA_BILLING_OUTBOX: "1" }), true);
  });

  test("(i) a zero-cost settlement writes no event and debits nothing", async () => {
    const store = new MemoryOutboxStore();
    const ledger = fakeLedger();
    const result = await settleUsage(input({ costMicros: 0 }), deps(store, ledger));
    assert.deepEqual(result, { eventId: null, applied: false, committed: true });
    assert.equal(ledger.state.calls, 0);
    assert.equal(store.calls.length, 0);
  });

  test("the happy path: append → debit → committed, with the full event shape", async () => {
    const store = new MemoryOutboxStore();
    const ledger = fakeLedger();
    const result = await settleUsage(input({ provider: "zhipu" }), deps(store, ledger));
    assert.ok(result.eventId);
    assert.equal(result.applied, true);
    assert.equal(result.committed, true);
    const ev = await store.get(UID, result.eventId);
    assert.ok(ev);
    assert.equal(ev.uid, UID);
    assert.equal(ev.kind, "chat");
    assert.equal(ev.provider, "zhipu");
    assert.equal(ev.model, "glm-4.6");
    assert.equal(ev.tokensIn, 1000);
    assert.equal(ev.tokensOut, 500);
    assert.equal(ev.costMicros, 4_200);
    assert.equal(ev.reservationId, "resv-1");
    assert.equal(ev.status, "committed");
    assert.equal(ev.attempts, 1);
    assert.equal(ev.createdAt, T0);
    assert.deepEqual(
      store.calls.filter((c) => c.op !== "get" && c.op !== "listOpen").map((c) => c.op),
      ["append", "update"],
      "the record is made durable BEFORE the debit and closed after — in that order",
    );
    assert.deepEqual(await store.listOpen(UID), []);
  });
});

describe("usage outbox — the balance ledger's idempotency key (quota.ts)", () => {
  test("debitTurn(eventId) applies once; a replay returns false and leaves the balance alone", async () => {
    await homeScope.run(homeForUid("em-idem"), async () => {
      await creditPurchase({ at: T0, microUSD: 5_000_000, transactionId: "seed-idem" }, T0);
      assert.equal(
        await debitTurn(ACCT, "claude-sonnet-4-6", 1_000_000, T0, { eventId: "evt-1" }),
        true,
      );
      assert.equal(
        await debitTurn(ACCT, "claude-sonnet-4-6", 1_000_000, T0 + 1, { eventId: "evt-1" }),
        false,
      );
      const b = await readBalance();
      assert.equal(b.paidMicroUSD, 4_000_000);
      assert.deepEqual(
        b.settled?.map((s) => s.id),
        ["evt-1"],
      );
      // A different event id is a real charge; no id means the legacy (non-idempotent) debit.
      assert.equal(
        await debitTurn(ACCT, "claude-sonnet-4-6", 1_000_000, T0 + 2, { eventId: "evt-2" }),
        true,
      );
      assert.equal(await debitTurn(ACCT, "claude-sonnet-4-6", 1_000_000, T0 + 3), true);
      assert.equal((await readBalance()).paidMicroUSD, 2_000_000);
    });
  });

  test("the settled ring is bounded and survives a round-trip through the balance file", async () => {
    await homeScope.run(homeForUid("em-ring"), async () => {
      await creditPurchase({ at: T0, microUSD: 50_000_000, transactionId: "seed-ring" }, T0);
      for (let i = 0; i < SETTLED_MAX + 5; i++) {
        await debitTurn(ACCT, "claude-sonnet-4-6", 1, T0 + i, { eventId: `evt-${i}` });
      }
      const b = await readBalance();
      assert.equal(b.settled?.length, SETTLED_MAX);
      assert.equal(b.settled?.[0]?.id, "evt-5", "oldest entries are evicted first");
      assert.equal(b.paidMicroUSD, 50_000_000 - (SETTLED_MAX + 5));
    });
  });

  test("a corrupt settled entry makes the balance fail closed (never silently dropped)", async () => {
    const home = homeForUid("em-corrupt-ring");
    fs.mkdirSync(path.join(home, "billing"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "billing", "balance.json"),
      JSON.stringify({ paidMicroUSD: 1, purchases: [], settled: [{ id: 42, at: "x" }] }),
    );
    await homeScope.run(home, async () => {
      await assert.rejects(
        readBalance(),
        (err: unknown) => err instanceof BillingStateError && err.code === "balance_corrupt",
      );
      await assert.rejects(
        debitTurn(ACCT, "claude-sonnet-4-6", 1, T0, { eventId: "e" }),
        BillingStateError,
      );
    });
  });
});

describe("usage outbox — end to end on the local JSONL store with the real balance ledger", () => {
  const uid = "em-e2e";
  const acct: AccountRecord = { ...ACCT, uid };
  const realDebit: SettlementDeps["debit"] = (a, event, eventId) =>
    homeScope.run(homeForUid(a.uid), () =>
      debitTurn(
        a,
        event.model,
        event.costMicros,
        event.createdAt,
        eventId ? { eventId } : undefined,
      ),
    );

  test("settle writes the event before the debit and marks it committed after", async () => {
    const store = new JsonlOutboxStore();
    const result = await homeScope.run(homeForUid(uid), () =>
      settleUsage(input({ acct }), { store, debit: realDebit, now: () => T0, enabled: () => true }),
    );
    assert.equal(result.committed, true);
    const file = path.join(homeForUid(uid), "billing", "outbox.jsonl");
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as UsageEvent);
    assert.deepEqual(
      lines.map((l) => l.status),
      ["pending", "committed"],
    );
    const balance = await homeScope.run(homeForUid(uid), readBalance);
    assert.equal(balance.window?.spentMicroUSD, 4_200);
    assert.deepEqual(
      balance.settled?.map((s) => s.id),
      [result.eventId],
    );
  });

  test("an unwritable outbox fails closed: no debit, no ledger change", async () => {
    const store = new JsonlOutboxStore();
    const uid2 = "em-e2e-ro";
    const acct2 = { ...ACCT, uid: uid2 };
    // billing/outbox.jsonl as a DIRECTORY ⇒ every append fails with EISDIR.
    fs.mkdirSync(path.join(homeForUid(uid2), "billing", "outbox.jsonl"), { recursive: true });
    await assert.rejects(
      homeScope.run(homeForUid(uid2), () =>
        settleUsage(input({ acct: acct2 }), {
          store,
          debit: realDebit,
          now: () => T0,
          enabled: () => true,
        }),
      ),
      (err: unknown) => err instanceof BillingStateError && err.code === "outbox_unavailable",
    );
    const balance = await homeScope.run(homeForUid(uid2), readBalance);
    assert.equal(balance.window, undefined, "no window was opened, nothing was spent");
  });

  test("a corrupt balance after a durable append: event parked as failed, then recovered by the reconciler", async () => {
    const store = new JsonlOutboxStore();
    const uid3 = "em-e2e-recover";
    const acct3 = { ...ACCT, uid: uid3 };
    const billing = path.join(homeForUid(uid3), "billing");
    fs.mkdirSync(billing, { recursive: true });
    fs.writeFileSync(path.join(billing, "balance.json"), "{corrupt");
    await assert.rejects(
      homeScope.run(homeForUid(uid3), () =>
        settleUsage(input({ acct: acct3 }), {
          store,
          debit: realDebit,
          now: () => T0,
          enabled: () => true,
        }),
      ),
      (err: unknown) => err instanceof BillingStateError && err.code === "balance_corrupt",
    );
    assert.equal(
      fs.readFileSync(path.join(billing, "balance.json"), "utf8"),
      "{corrupt",
      "never overwritten",
    );
    let open = await store.listOpen(uid3);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.status, "failed");
    // Operator restores the balance file; the reconciler settles the parked charge once.
    fs.rmSync(path.join(billing, "balance.json"));
    const report = await reconcileOnce(
      { now: T0 + 60_000 },
      { store, debit: realDebit, loadAccount: async () => acct3, now: () => T0 + 60_000 },
    );
    assert.equal(report.committed, 1);
    open = await store.listOpen(uid3);
    assert.deepEqual(open, []);
    const balance = await homeScope.run(homeForUid(uid3), readBalance);
    assert.equal(balance.window?.spentMicroUSD, 4_200);
    const again = await reconcileOnce(
      { now: T0 + 120_000 },
      { store, debit: realDebit, loadAccount: async () => acct3, now: () => T0 + 120_000 },
    );
    assert.equal(again.scanned, 0);
    assert.equal((await homeScope.run(homeForUid(uid3), readBalance)).window?.spentMicroUSD, 4_200);
  });
});

describe("describeError", () => {
  test("keeps the class, code and a short message; strips the uid and bearer tokens", () => {
    const err = new BillingStateError(
      "balance_unavailable",
      `commit lisa-balances/${UID} failed Bearer abc.def-ghi`,
    );
    const text = describeError(err, UID);
    assert.ok(text.startsWith("BillingStateError(balance_unavailable)"));
    assert.ok(!text.includes(UID));
    assert.ok(text.includes(redactId(UID)));
    assert.ok(!text.includes("abc.def-ghi"));
    assert.ok(describeError("plain string").includes("plain string"));
    assert.ok(describeError(new Error("x".repeat(500))).length < 260);
  });
});

describe("outbox document + sharding helpers", () => {
  // These sit on the cloud path, which the local suite cannot exercise without
  // a Firestore emulator — but they are pure, and each encodes an invariant
  // money depends on.
  const event = {
    id: "evt-1",
    uid: "u-1",
    kind: "chat",
    model: "claude-sonnet-4-6",
    costMicros: 1234,
    createdAt: 1_700_000_000_000,
    status: "pending",
    attempts: 0,
    reservationId: "r-1",
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } as unknown as UsageEvent;

  test("a usage event survives the document round trip unchanged", () => {
    assert.deepEqual(fromDoc(toDoc(event)), event);
  });

  test("lastError is stored as '' and comes back absent, never as the empty string", () => {
    // Firestore rejects an undefined field, so it is written as "" and dropped
    // on read. A round-tripped event must not grow a falsy lastError that a
    // later reader treats as "this failed once".
    const doc = toDoc(event);
    assert.equal(doc.lastError, "");
    assert.equal("lastError" in fromDoc(doc), false);

    const failed = { ...event, lastError: "boom" } as UsageEvent;
    assert.equal(toDoc(failed).lastError, "boom");
    assert.equal(fromDoc(toDoc(failed)).lastError, "boom");
  });

  test("tenant sharding is deterministic and stays inside the shard range", () => {
    assert.equal(tenantShard("u-1"), tenantShard("u-1"));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(tenantShard(`uid-${i}`));
    assert.ok(seen.size > 1, "sharding should actually spread");
    for (const p of seen)
      assert.match(p, /^lisa-outbox-tenants\/[0-7]$/, `shard out of range: ${p}`);
  });

  test("readIds keeps only strings and never throws on a malformed field", () => {
    assert.deepEqual(readIds({ open: ["a", "b"] }), ["a", "b"]);
    assert.deepEqual(readIds({ open: ["a", 1, null, { x: 1 }, "b"] }), ["a", "b"]);
    assert.deepEqual(readIds({ open: "not-an-array" }), []);
    assert.deepEqual(readIds({}), []);
    assert.deepEqual(readIds(null), []);
    assert.deepEqual(readIds({ other: ["a"] }, "other"), ["a"]);
  });

  test("only a real FirestoreError 409/412 counts as 'already appended'", () => {
    // The append is idempotent by id via an exists:false precondition, so those
    // statuses mean "already durable". Anything else is a real failure and has
    // to fail the settlement closed — including a look-alike error object.
    class LookAlike extends Error {
      status = 409;
    }
    assert.equal(isAlreadyExists(new Error("nope")), false);
    assert.equal(isAlreadyExists(null), false);
    assert.equal(isAlreadyExists(undefined), false);
    assert.equal(isAlreadyExists(new LookAlike()), false, "duck typing must not pass");
  });

  test("the default store is memoized, and the test reset forgets it", () => {
    _resetOutboxStoreForTests();
    const a = defaultOutboxStore();
    assert.equal(defaultOutboxStore(), a, "memoized within an edition");
    _resetOutboxStoreForTests();
    assert.notEqual(defaultOutboxStore(), a, "reset must forget the adapter");
  });
});
