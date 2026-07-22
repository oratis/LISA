import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-iap-"));
process.env.LISA_HOME = TMP;

const { verifyAppleJWS, validateTransaction, creditTransaction, refundTransaction, PRODUCTS, IapError } =
  await import("./iap.js");
const { homeScope, homeForUid } = await import("../paths.js");
const { readBalance } = await import("./quota.js");

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

beforeEach(() => {
  fs.rmSync(path.join(TMP, "iap-transactions.json"), { force: true });
  fs.rmSync(path.join(TMP, "users"), { recursive: true, force: true });
});

describe("JWS shape validation", () => {
  test("garbage / missing x5c / wrong alg → malformed_jws", async () => {
    for (const bad of [
      "not-a-jws",
      "a.b",
      `${b64({ alg: "ES256" })}.${b64({})}.sig`, // no x5c
      `${b64({ alg: "RS256", x5c: ["a", "b"] })}.${b64({})}.sig`, // wrong alg
    ]) {
      await assert.rejects(verifyAppleJWS(bad, { now: 0 }), (e: unknown) => (e as InstanceType<typeof IapError>).code === "malformed_jws");
    }
  });
});

describe("transaction payload validation", () => {
  const good = { transactionId: "1000000123", productId: "ai.meetlisa.main.credits.10", bundleId: "ai.meetlisa.main" };

  test("accepts a known product on our bundle", () => {
    const tx = validateTransaction(good);
    assert.equal(tx.productId, "ai.meetlisa.main.credits.10");
  });

  test("wrong bundle / unknown product / missing id → typed errors", () => {
    assert.throws(() => validateTransaction({ ...good, bundleId: "com.evil.app" }), (e: unknown) => (e as InstanceType<typeof IapError>).code === "wrong_bundle");
    assert.throws(() => validateTransaction({ ...good, productId: "ai.meetlisa.main.credits.999" }), (e: unknown) => (e as InstanceType<typeof IapError>).code === "unknown_product");
    assert.throws(() => validateTransaction({ ...good, transactionId: "" }), (e: unknown) => (e as InstanceType<typeof IapError>).code === "malformed_jws");
  });
});

describe("credit + dedup + refund", () => {
  const tx = validateTransaction({
    transactionId: "tx-1",
    productId: "ai.meetlisa.main.credits.10",
    bundleId: "ai.meetlisa.main",
  });

  test("credits the uid's balance once; a replay is rejected globally", async () => {
    const credited = await creditTransaction("em-alpha", tx, 1000);
    assert.equal(credited, PRODUCTS["ai.meetlisa.main.credits.10"]);
    await homeScope.run(homeForUid("em-alpha"), async () => {
      const b = await readBalance();
      assert.equal(b.paidMicroUSD, 10_500_000);
      assert.equal(b.purchases[0]!.transactionId, "tx-1");
    });
    // Same transaction, same OR different account → duplicate.
    await assert.rejects(creditTransaction("em-alpha", tx, 2000), (e: unknown) => (e as InstanceType<typeof IapError>).code === "duplicate_transaction");
    await assert.rejects(creditTransaction("em-beta", tx, 3000), (e: unknown) => (e as InstanceType<typeof IapError>).code === "duplicate_transaction");
    await homeScope.run(homeForUid("em-beta"), async () => {
      const b = await readBalance();
      assert.equal(b.paidMicroUSD, 0);
    });
  });

  test("refund claws back from the owning account; unknown tx → null", async () => {
    await creditTransaction("em-gamma", { ...tx, transactionId: "tx-2" }, 1000);
    const undone = await refundTransaction("tx-2");
    assert.equal(undone?.uid, "em-gamma");
    assert.equal(undone?.microUSD, 10_500_000);
    await homeScope.run(homeForUid("em-gamma"), async () => {
      const b = await readBalance();
      assert.equal(b.paidMicroUSD, 0);
      assert.equal(b.purchases.length, 0);
    });
    assert.equal(await refundTransaction("tx-never"), null);
    // The index entry survives the refund, so a replayed credit stays deduped.
    await assert.rejects(creditTransaction("em-gamma", { ...tx, transactionId: "tx-2" }, 2000), (e: unknown) => (e as InstanceType<typeof IapError>).code === "duplicate_transaction");
  });
});
