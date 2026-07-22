import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { stripeConfig, STRIPE_PACKS, createCheckoutSession, verifyStripeSignature, classifyStripeEvent } =
  await import("./stripe.js");

describe("stripe config + packs", () => {
  test("unset env → nulls; packs mirror the IAP face economics", () => {
    assert.deepEqual(stripeConfig({}), { secretKey: null, webhookSecret: null });
    assert.equal(STRIPE_PACKS["5"]!.faceMicroUSD, 5_000_000);
    assert.equal(STRIPE_PACKS["10"]!.faceMicroUSD, 10_500_000);
    assert.equal(STRIPE_PACKS["20"]!.faceMicroUSD, 22_000_000);
  });
});

describe("checkout session creation", () => {
  test("builds the form-encoded request with metadata + ad-hoc price", async () => {
    let captured: { url: string; body: string } | null = null;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body) };
      return new Response(JSON.stringify({ id: "cs_123", url: "https://checkout.stripe.com/x" }), { status: 200 });
    }) as typeof fetch;
    const s = await createCheckoutSession("em-abc", "10", "https://cloud.meetlisa.ai",
      { secretKey: "sk_test", webhookSecret: null }, fakeFetch);
    assert.equal(s?.id, "cs_123");
    const body = new URLSearchParams(captured!.body);
    assert.equal(body.get("metadata[uid]"), "em-abc");
    assert.equal(body.get("metadata[pack]"), "10");
    assert.equal(body.get("line_items[0][price_data][unit_amount]"), "999");
    assert.match(body.get("success_url")!, /\/account\?paid=1/);
  });

  test("unknown pack or missing key → null, no network call", async () => {
    const boom = (async () => { throw new Error("no"); }) as unknown as typeof fetch;
    assert.equal(await createCheckoutSession("u", "99", "https://x", { secretKey: "sk", webhookSecret: null }, boom), null);
    assert.equal(await createCheckoutSession("u", "5", "https://x", { secretKey: null, webhookSecret: null }, boom), null);
  });
});

describe("webhook signature", () => {
  const secret = "whsec_test";
  const sign = (payload: string, t: number) =>
    `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

  test("valid signature within tolerance passes; wrong secret fails", () => {
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    const t = 1_753_000_000;
    const header = sign(payload, t);
    assert.equal(verifyStripeSignature(payload, header, secret, t * 1000), true);
    assert.equal(verifyStripeSignature(payload, header, "whsec_other", t * 1000), false);
    assert.equal(verifyStripeSignature(payload + "x", header, secret, t * 1000), false);
  });

  test("stale timestamp / malformed header fail", () => {
    const payload = "{}";
    const t = 1_753_000_000;
    assert.equal(verifyStripeSignature(payload, sign(payload, t), secret, (t + 600) * 1000), false);
    assert.equal(verifyStripeSignature(payload, "v1=deadbeef", secret, t * 1000), false);
    assert.equal(verifyStripeSignature(payload, "", secret, t * 1000), false);
  });
});

describe("event classification", () => {
  test("completed checkout → credit with uid/pack; refund → payment_intent; else ignore", () => {
    const credit = classifyStripeEvent({
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", metadata: { uid: "em-x", pack: "20" } } },
    });
    assert.deepEqual(credit, { kind: "credit", id: "cs_1", uid: "em-x", pack: "20" });
    const refund = classifyStripeEvent({ type: "charge.refunded", data: { object: { payment_intent: "pi_9" } } });
    assert.equal(refund.kind, "refund");
    assert.equal(refund.id, "pi_9");
    assert.equal(classifyStripeEvent({ type: "invoice.paid", data: { object: {} } }).kind, "ignore");
  });
});
