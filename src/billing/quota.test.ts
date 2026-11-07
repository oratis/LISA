import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-quota-"));
process.env.LISA_HOME = TMP;

const quota = await import("./quota.js");
const {
  precheckTurn,
  debitTurn,
  quotaStatus,
  creditPurchase,
  clawbackPurchase,
  readBalance,
  BillingStateError,
  WINDOW_MS,
  FREE_WINDOW_FULL,
  FREE_WINDOW_UNVERIFIED,
  TIER1_WINDOW,
  TIER2_WINDOW,
  SIGNUP_GRANT,
} = quota;
import type { AccountRecord } from "../web/accounts.js";

const T0 = 1_750_000_000_000;

const APPLE: AccountRecord = {
  uid: "apple-1",
  kind: "apple",
  createdAt: T0,
  lastLoginAt: T0,
  verified: true,
  sessionVersion: 0,
};
const EMAIL_UNVERIFIED: AccountRecord = {
  uid: "em-1",
  kind: "email",
  email: "a@b.co",
  createdAt: T0,
  lastLoginAt: T0,
  verified: false,
  sessionVersion: 0,
};

beforeEach(() => {
  fs.rmSync(path.join(TMP, "billing"), { recursive: true, force: true });
  // Each test starts as a person who has never had a welcome grant.
  fs.rmSync(path.join(TMP, "welcome-grants.json"), { force: true });
});

describe("quota engine", () => {
  test("a corrupt balance fails closed and is never reset or overwritten", async () => {
    const dir = path.join(TMP, "billing");
    const file = path.join(dir, "balance.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "{corrupt");
    await assert.rejects(readBalance(), BillingStateError);
    await assert.rejects(precheckTurn(APPLE, "glm-4.6", T0), BillingStateError);
    assert.equal(fs.readFileSync(file, "utf8"), "{corrupt");
  });

  test("purchase transaction ids are idempotent at the balance boundary", async () => {
    assert.equal(
      await creditPurchase({ at: T0, microUSD: 5_000_000, transactionId: "idem-1" }, T0),
      true,
    );
    assert.equal(
      await creditPurchase({ at: T0, microUSD: 5_000_000, transactionId: "idem-1" }, T0 + 1),
      false,
    );
    const balance = await readBalance();
    assert.equal(balance.paidMicroUSD, 5_000_000);
    assert.equal(balance.purchases.length, 1);
    await assert.rejects(
      creditPurchase({ at: T0, microUSD: 6_000_000, transactionId: "idem-1" }, T0 + 2),
      (err: unknown) => err instanceof BillingStateError && err.code === "purchase_conflict",
    );
  });

  test("first standard turn opens a 24h window with the tier allowance", async () => {
    const pre = await precheckTurn(APPLE, "glm-4.6", T0);
    assert.ok(pre.ok);
    const q = await quotaStatus(APPLE, T0 + 1);
    assert.equal(q.tier, "free");
    assert.equal(q.windowMicroUSD, FREE_WINDOW_FULL);
    assert.equal(q.resetAt, T0 + WINDOW_MS);
  });

  test("Gemini Flash admits a new account without paid credits and debits its free window", async () => {
    assert.equal((await readBalance()).paidMicroUSD, 0);
    const pre = await precheckTurn(APPLE, "gemini-2.5-flash", T0);
    assert.ok(pre.ok);
    await debitTurn(APPLE, "gemini-2.5-flash", 10_000, T0 + 1);
    const q = await quotaStatus(APPLE, T0 + 2);
    assert.equal(q.paidMicroUSD, 0);
    assert.equal(q.spentMicroUSD, 10_000);
    assert.equal(q.remainingMicroUSD, FREE_WINDOW_FULL - 10_000);
  });

  test("unverified email gets the reduced window", async () => {
    await precheckTurn(EMAIL_UNVERIFIED, "glm-4.6", T0);
    const q = await quotaStatus(EMAIL_UNVERIFIED, T0 + 1);
    assert.equal(q.tier, "free-unverified");
    assert.equal(q.windowMicroUSD, FREE_WINDOW_UNVERIFIED);
  });

  test("debit draws free window, then welcome grant, then paid; exhaustion → 402 shape; window reset restores", async () => {
    await creditPurchase({ at: T0, microUSD: 2_000_000, transactionId: "t1" }, T0);
    await precheckTurn(APPLE, "glm-4.6", T0);
    // burn the whole free window, the whole welcome grant and $1 of paid
    await debitTurn(APPLE, "glm-4.6", FREE_WINDOW_FULL + SIGNUP_GRANT + 1_000_000, T0 + 1000);
    const q = await quotaStatus(APPLE, T0 + 2000);
    assert.equal(q.remainingMicroUSD, 0);
    assert.equal(q.grantMicroUSD, 0);
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

  test("a verified account gets the welcome grant once, for standard models only", async () => {
    // Shown before first use, issued at the first admission.
    assert.equal((await quotaStatus(APPLE, T0)).grantMicroUSD, SIGNUP_GRANT);
    assert.ok((await precheckTurn(APPLE, "glm-4.6", T0)).ok);
    let balance = await readBalance();
    assert.equal(balance.grantMicroUSD, SIGNUP_GRANT);
    assert.equal(balance.signupGrantAt, T0);
    // Window first, then the grant.
    await debitTurn(APPLE, "glm-4.6", FREE_WINDOW_FULL + 500_000, T0 + 1);
    assert.equal((await quotaStatus(APPLE, T0 + 2)).grantMicroUSD, SIGNUP_GRANT - 500_000);
    // Premium models never draw on it.
    const premium = await precheckTurn(APPLE, "claude-sonnet-5-5", T0 + 3);
    assert.ok(!premium.ok && premium.error === "premium_requires_balance");
    // Spend the rest: exhausted until the window rolls, and a new window
    // does not re-issue the grant.
    await debitTurn(APPLE, "glm-4.6", SIGNUP_GRANT - 500_000, T0 + 4);
    const spent = await precheckTurn(APPLE, "glm-4.6", T0 + 5);
    assert.ok(!spent.ok && spent.error === "quota_exhausted");
    assert.ok((await precheckTurn(APPLE, "glm-4.6", T0 + WINDOW_MS + 1)).ok);
    balance = await readBalance();
    assert.equal(balance.grantMicroUSD, 0);
    assert.equal(balance.signupGrantAt, T0);
  });

  test("deleting the account and signing in again does not issue a second welcome grant (#447 review)", async () => {
    const first: AccountRecord = { ...APPLE, uid: "apple-first", appleSub: "001.sub" };
    assert.ok((await precheckTurn(first, "glm-4.6", T0)).ok);
    assert.equal((await readBalance()).grantMicroUSD, SIGNUP_GRANT);
    // Account deletion erases the balance; the same Apple ID then signs in
    // again and is minted a new uid.
    fs.rmSync(path.join(TMP, "billing"), { recursive: true, force: true });
    const again: AccountRecord = { ...first, uid: "apple-again" };
    assert.equal((await quotaStatus(again, T0 + 1)).grantMicroUSD, 0);
    assert.ok((await precheckTurn(again, "glm-4.6", T0 + 2)).ok);
    let balance = await readBalance();
    assert.equal(balance.grantMicroUSD ?? 0, 0);
    // Recorded as settled, so later turns do not claim again.
    assert.equal(balance.signupGrantAt, T0 + 2);
    // The same inbox under another sign-in method is the same person too.
    fs.rmSync(path.join(TMP, "billing"), { recursive: true, force: true });
    const viaEmail: AccountRecord = {
      ...EMAIL_UNVERIFIED,
      uid: "em-first",
      email: "Person@Example.com",
      verified: true,
    };
    assert.ok((await precheckTurn(viaEmail, "glm-4.6", T0 + 3)).ok);
    assert.equal((await readBalance()).grantMicroUSD, SIGNUP_GRANT);
    fs.rmSync(path.join(TMP, "billing"), { recursive: true, force: true });
    const viaGoogle: AccountRecord = {
      ...viaEmail,
      uid: "g-second",
      kind: "google",
      googleSub: "1234",
      email: "person@example.com",
    };
    assert.ok((await precheckTurn(viaGoogle, "glm-4.6", T0 + 4)).ok);
    balance = await readBalance();
    assert.equal(balance.grantMicroUSD ?? 0, 0);
    // The claim file holds hashes only, never an identity.
    const claims = fs.readFileSync(path.join(TMP, "welcome-grants.json"), "utf8");
    for (const secret of ["001.sub", "person@example.com", "1234", "apple-first"]) {
      assert.ok(!claims.toLowerCase().includes(secret), secret);
    }
  });

  test("an unreachable claim store leaves the welcome grant pending, not lost (#447 review)", async () => {
    // A directory where the claim file should be: every read fails.
    fs.mkdirSync(path.join(TMP, "welcome-grants.json"));
    try {
      assert.ok((await precheckTurn(APPLE, "glm-4.6", T0)).ok);
      const balance = await readBalance();
      assert.equal(balance.grantMicroUSD ?? 0, 0);
      assert.equal(balance.signupGrantAt, undefined);
    } finally {
      fs.rmSync(path.join(TMP, "welcome-grants.json"), { recursive: true, force: true });
    }
    assert.ok((await precheckTurn(APPLE, "glm-4.6", T0 + 1)).ok);
    assert.equal((await readBalance()).grantMicroUSD, SIGNUP_GRANT);
  });

  test("an unverified account earns no welcome grant until it is verified", async () => {
    assert.equal((await quotaStatus(EMAIL_UNVERIFIED, T0)).grantMicroUSD, 0);
    await precheckTurn(EMAIL_UNVERIFIED, "glm-4.6", T0);
    assert.equal((await readBalance()).signupGrantAt, undefined);
    await precheckTurn({ ...EMAIL_UNVERIFIED, verified: true }, "glm-4.6", T0 + 1);
    assert.equal((await readBalance()).grantMicroUSD, SIGNUP_GRANT);
  });

  test("a malformed welcome grant fails closed", async () => {
    const dir = path.join(TMP, "billing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "balance.json"),
      JSON.stringify({ paidMicroUSD: 0, purchases: [], grantMicroUSD: -1 }),
    );
    await assert.rejects(readBalance(), BillingStateError);
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
