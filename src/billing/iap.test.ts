import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-iap-"));
process.env.LISA_HOME = TMP;

const {
  verifyAppleJWS,
  validateTransaction,
  creditTransaction,
  refundTransaction,
  PRODUCTS,
  IapError,
  PaymentStateError,
  oidToDer,
} =
  await import("./iap.js");
const { homeScope, homeForUid } = await import("../paths.js");
const { creditPurchase, readBalance } = await import("./quota.js");

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

describe("OID DER encoding (#265)", () => {
  test("encodes Apple's marker OIDs to the bytes the chain walk looks for", () => {
    // Verified against real Apple certs: these exact TLVs appear in the leaf
    // and the WWDR intermediate respectively.
    assert.equal(oidToDer("1.2.840.113635.100.6.11.1").toString("hex"), "060a2a864886f76364060b01");
    assert.equal(oidToDer("1.2.840.113635.100.6.2.1").toString("hex"), "060a2a864886f76364060201");
    // multi-byte base-128 arcs and the packed first two arcs
    assert.equal(oidToDer("2.5.29.19").toString("hex"), "0603551d13"); // basicConstraints
    assert.equal(oidToDer("1.2.840.113549").toString("hex"), "06062a864886f70d"); // RSADSI
  });

  test("refuses an OID needing long-form DER length instead of emitting invalid DER", () => {
    // >127 content bytes. Emitting the length byte unchecked would produce DER
    // that parses as something else entirely, so the needle would never match
    // and the role check would silently always fail — refuse loudly instead.
    const huge = "1.2." + Array.from({ length: 40 }, () => "268435456").join(".");
    assert.throws(() => oidToDer(huge), IapError);
    // and malformed input is still rejected
    assert.throws(() => oidToDer("1"), IapError);
    assert.throws(() => oidToDer("1.x.3"), IapError);
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
    const replayedRefund = await refundTransaction("tx-2");
    assert.equal(replayedRefund?.uid, "em-gamma");
    await homeScope.run(homeForUid("em-gamma"), async () => {
      assert.equal((await readBalance()).paidMicroUSD, 0, "refund replay must not claw back twice");
    });
    assert.equal(await refundTransaction("tx-never"), null);
    // The index entry survives the refund, so a replayed credit stays deduped.
    await assert.rejects(creditTransaction("em-gamma", { ...tx, transactionId: "tx-2" }, 2000), (e: unknown) => (e as InstanceType<typeof IapError>).code === "duplicate_transaction");
  });

  test("a pending transaction safely resumes after balance credit without double-crediting", async () => {
    fs.writeFileSync(
      path.join(TMP, "iap-transactions.json"),
      JSON.stringify([
        {
          transactionId: "tx-resume",
          uid: "em-resume",
          productId: tx.productId,
          microUSD: PRODUCTS[tx.productId],
          at: 1000,
          status: "pending",
        },
      ]),
    );
    await homeScope.run(homeForUid("em-resume"), () =>
      creditPurchase({
        at: 1000,
        microUSD: PRODUCTS[tx.productId]!,
        transactionId: "tx-resume",
      }),
    );

    assert.equal(
      await creditTransaction("em-resume", { ...tx, transactionId: "tx-resume" }, 2000),
      PRODUCTS[tx.productId],
    );
    await homeScope.run(homeForUid("em-resume"), async () => {
      const balance = await readBalance();
      assert.equal(balance.paidMicroUSD, PRODUCTS[tx.productId]);
      assert.equal(balance.purchases.length, 1);
    });
    const index = JSON.parse(fs.readFileSync(path.join(TMP, "iap-transactions.json"), "utf8")) as Array<{ status: string }>;
    assert.equal(index[0]?.status, "credited");
  });

  test("a corrupt transaction index fails closed without crediting or overwriting it", async () => {
    const indexFile = path.join(TMP, "iap-transactions.json");
    fs.writeFileSync(indexFile, "{corrupt");
    await assert.rejects(
      creditTransaction("em-safe", { ...tx, transactionId: "tx-corrupt" }, 1000),
      PaymentStateError,
    );
    assert.equal(fs.readFileSync(indexFile, "utf8"), "{corrupt");
    await homeScope.run(homeForUid("em-safe"), async () => {
      assert.equal((await readBalance()).paidMicroUSD, 0);
    });
  });

  test("a Firestore outage is surfaced as retryable payment-state unavailability", async () => {
    const originalFetch = globalThis.fetch;
    process.env.LISA_FIRESTORE = "1";
    process.env.LISA_FIRESTORE_TOKEN = "test-token";
    process.env.LISA_FIRESTORE_PROJECT = "test-project";
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    try {
      await assert.rejects(
        creditTransaction("em-firestore", { ...tx, transactionId: "tx-firestore" }, 1000),
        (err: unknown) =>
          err instanceof PaymentStateError &&
          err.code === "transaction_store_unavailable",
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.LISA_FIRESTORE;
      delete process.env.LISA_FIRESTORE_TOKEN;
      delete process.env.LISA_FIRESTORE_PROJECT;
    }
  });

  test("a conflicting pending owner is rejected without leaking a second credit", async () => {
    fs.writeFileSync(
      path.join(TMP, "iap-transactions.json"),
      JSON.stringify([
        {
          transactionId: "tx-conflict",
          uid: "em-owner",
          productId: tx.productId,
          microUSD: PRODUCTS[tx.productId],
          at: 1000,
          status: "pending",
        },
      ]),
    );
    await assert.rejects(
      creditTransaction("em-attacker", { ...tx, transactionId: "tx-conflict" }, 2000),
      (err: unknown) =>
        err instanceof PaymentStateError && err.code === "transaction_conflict",
    );
    await homeScope.run(homeForUid("em-attacker"), async () => {
      assert.equal((await readBalance()).paidMicroUSD, 0);
    });
  });

  test("a refund arriving during pending credit fails retryably", async () => {
    const indexFile = path.join(TMP, "iap-transactions.json");
    fs.writeFileSync(
      indexFile,
      JSON.stringify([
        {
          transactionId: "tx-pending-refund",
          uid: "em-owner",
          productId: tx.productId,
          microUSD: PRODUCTS[tx.productId],
          at: 1000,
          status: "pending",
        },
      ]),
    );
    await assert.rejects(
      refundTransaction("tx-pending-refund"),
      (err: unknown) =>
        err instanceof PaymentStateError &&
        err.code === "transaction_store_unavailable",
    );
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as Array<{ status: string }>;
    assert.equal(index[0]?.status, "pending");
  });
});
