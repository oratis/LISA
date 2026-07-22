import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-quota-"));
process.env.LISA_HOME = TMP;

const quota = await import("./quota.js");
const {
  precheckTurn, debitTurn, quotaStatus, creditPurchase, clawbackPurchase,
  WINDOW_MS, FREE_WINDOW_FULL, FREE_WINDOW_UNVERIFIED, TIER1_WINDOW, TIER2_WINDOW,
} = quota;
import type { AccountRecord } from "../web/accounts.js";

const T0 = 1_750_000_000_000;

const APPLE: AccountRecord = {
  uid: "apple-1", kind: "apple", createdAt: T0, lastLoginAt: T0, verified: true, sessionVersion: 0,
};
const EMAIL_UNVERIFIED: AccountRecord = {
  uid: "em-1", kind: "email", email: "a@b.co", createdAt: T0, lastLoginAt: T0, verified: false, sessionVersion: 0,
};

beforeEach(() => {
  fs.rmSync(path.join(TMP, "billing"), { recursive: true, force: true });
});

describe("quota engine", () => {
  test("first standard turn opens a 12h window with the tier allowance", async () => {
    const pre = await precheckTurn(APPLE, "glm-4.6", T0);
    assert.ok(pre.ok);
    const q = await quotaStatus(APPLE, T0 + 1);
    assert.equal(q.tier, "free");
    assert.equal(q.windowMicroUSD, FREE_WINDOW_FULL);
    assert.equal(q.resetAt, T0 + WINDOW_MS);
  });

  test("unverified email gets the reduced window", async () => {
    await precheckTurn(EMAIL_UNVERIFIED, "glm-4.6", T0);
    const q = await quotaStatus(EMAIL_UNVERIFIED, T0 + 1);
    assert.equal(q.tier, "free-unverified");
    assert.equal(q.windowMicroUSD, FREE_WINDOW_UNVERIFIED);
  });

  test("debit draws free window first, then paid; exhaustion → 402 shape; window reset restores", async () => {
    await creditPurchase({ at: T0, microUSD: 2_000_000, transactionId: "t1" }, T0);
    await precheckTurn(APPLE, "glm-4.6", T0);
    // burn the whole free window + $1 of paid
    await debitTurn(APPLE, "glm-4.6", FREE_WINDOW_FULL + 1_000_000, T0 + 1000);
    let q = await quotaStatus(APPLE, T0 + 2000);
    assert.equal(q.remainingMicroUSD, 0);
    assert.equal(q.paidMicroUSD, 1_000_000);
    // still ok: paid remains
    let pre = await precheckTurn(APPLE, "glm-4.6", T0 + 3000);
    assert.ok(pre.ok);
    // burn the paid too → exhausted
    await debitTurn(APPLE, "glm-4.6", 1_000_000, T0 + 4000);
    pre = await precheckTurn(APPLE, "glm-4.6", T0 + 5000);
    assert.ok(!pre.ok && pre.error === "quota_exhausted");
    assert.equal(pre.ok === false && pre.resetAt, T0 + WINDOW_MS);
    // window rolls → fresh allowance
    pre = await precheckTurn(APPLE, "glm-4.6", T0 + WINDOW_MS + 1);
    assert.ok(pre.ok);
  });

  test("premium models never touch the free window", async () => {
    let pre = await precheckTurn(APPLE, "claude-sonnet-4-6", T0);
    assert.ok(!pre.ok && pre.error === "premium_requires_balance");
    await creditPurchase({ at: T0, microUSD: 5_000_000, transactionId: "t2" }, T0);
    pre = await precheckTurn(APPLE, "claude-sonnet-4-6", T0 + 1);
    assert.ok(pre.ok);
    await debitTurn(APPLE, "claude-sonnet-4-6", 2_000_000, T0 + 2);
    const q = await quotaStatus(APPLE, T0 + 3);
    assert.equal(q.paidMicroUSD, 3_000_000);
    // free window untouched by the premium debit
    assert.equal(q.spentMicroUSD, 0);
  });

  test("30d purchases raise the tier window; old purchases age out", async () => {
    await creditPurchase({ at: T0, microUSD: 4_990_000, transactionId: "t3" }, T0);
    let q = await quotaStatus(APPLE, T0 + 1);
    assert.equal(q.tier, "tier1");
    assert.equal(q.windowMicroUSD, TIER1_WINDOW);
    await creditPurchase({ at: T0 + 2, microUSD: 15_000_000, transactionId: "t4" }, T0 + 2);
    q = await quotaStatus(APPLE, T0 + 3);
    assert.equal(q.tier, "tier2");
    assert.equal(q.windowMicroUSD, TIER2_WINDOW);
    // 31 days later the tier decays (balance itself remains)
    const later = T0 + 31 * 24 * 60 * 60 * 1000;
    q = await quotaStatus(APPLE, later);
    assert.equal(q.tier, "free");
    assert.equal(q.paidMicroUSD, 19_990_000);
  });

  test("refund clawback reverses the purchase and can go negative; premium locks, standard window survives", async () => {
    await creditPurchase({ at: T0, microUSD: 5_000_000, transactionId: "t5" }, T0);
    await debitTurn(APPLE, "claude-sonnet-4-6", 4_000_000, T0 + 1);
    assert.equal(await clawbackPurchase("t5"), true);
    const q = await quotaStatus(APPLE, T0 + 2);
    assert.equal(q.paidMicroUSD, -4_000_000);
    // premium locked
    const prePremium = await precheckTurn(APPLE, "claude-sonnet-4-6", T0 + 3);
    assert.ok(!prePremium.ok);
    // standard free window still works
    const preStd = await precheckTurn(APPLE, "glm-4.6", T0 + 4);
    assert.ok(preStd.ok);
    // unknown transaction → false
    assert.equal(await clawbackPurchase("nope"), false);
  });
});

test("M1: an unwritable balance store fails CLOSED — precheck refuses, debit retries+throws, then recovers", { skip: process.platform === "win32" }, async () => {
  const billing = path.join(TMP, "billing");
  // Plant a FILE where the billing DIR belongs, so every balance-store write
  // fails fast (ensureDir / atomicWrite) — a full disk / unwritable store.
  fs.rmSync(billing, { recursive: true, force: true });
  fs.writeFileSync(billing, "not a dir");

  const pre = await precheckTurn(APPLE, "glm-4.6", T0);
  assert.equal(pre.ok, false);
  assert.equal((pre as { error: string }).error, "billing_unavailable");
  assert.equal(quota.billingStoreHealthy(), false);
  // The debit (post-answer) must NOT be silently lost: it throws after retries.
  await assert.rejects(debitTurn(APPLE, "glm-4.6", 1_000_000, T0 + 1));

  // Store recovers → serving resumes, health restored.
  fs.rmSync(billing, { force: true });
  const ok = await precheckTurn(APPLE, "glm-4.6", T0 + 2);
  assert.equal(ok.ok, true);
  assert.equal(quota.billingStoreHealthy(), true);
});
