/**
 * Stripe top-up — the DESKTOP/WEB purchase path
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §8 B7 follow-up, milestone B8c).
 *
 * Same packs and face values as the IAP consumables, sold through Stripe
 * Checkout with zero Apple involvement. The iOS app NEVER links here (App
 * Store 3.1.1 anti-steering hygiene outside the US); entry points are the web
 * /account page and the website.
 *
 * Flow: POST /api/billing/stripe/checkout (account session) → hosted Checkout
 * → Stripe webhook `checkout.session.completed` → credit through the SAME
 * global transaction index the IAP path uses (`stripe-<sessionId>`), so
 * replays and cross-account double-credits are impossible by construction.
 * `charge.refunded` claws back via a session lookup.
 *
 * Zero deps: Checkout sessions via form-encoded REST; webhook signatures are
 * HMAC-SHA256 over `${t}.${payload}` (Stripe-Signature v1 scheme).
 *
 * Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
 */
import crypto from "node:crypto";

export interface StripeConfig {
  secretKey: string | null;
  webhookSecret: string | null;
}

export function stripeConfig(env: Record<string, string | undefined> = process.env): StripeConfig {
  return {
    secretKey: env.STRIPE_SECRET_KEY?.trim() || null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null,
  };
}

/** Same face economics as the IAP packs (see billing/iap.ts PRODUCTS). */
export const STRIPE_PACKS: Record<string, { usdCents: number; faceMicroUSD: number; name: string }> = {
  "5": { usdCents: 499, faceMicroUSD: 5_000_000, name: "LISA Credits — $5.00" },
  "10": { usdCents: 999, faceMicroUSD: 10_500_000, name: "LISA Credits — $10.50 (+5%)" },
  "20": { usdCents: 1999, faceMicroUSD: 22_000_000, name: "LISA Credits — $22.00 (+10%)" },
};

/**
 * Create a hosted Checkout session for `uid`/`pack`. Returns the redirect URL.
 * Ad-hoc price_data — no dashboard products to maintain.
 */
export async function createCheckoutSession(
  uid: string,
  pack: string,
  baseUrl: string,
  cfg: StripeConfig = stripeConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string; url: string } | null> {
  const p = STRIPE_PACKS[pack];
  if (!p || !cfg.secretKey) return null;
  const form = new URLSearchParams({
    mode: "payment",
    success_url: `${baseUrl}/account?paid=1`,
    cancel_url: `${baseUrl}/account`,
    client_reference_id: uid,
    "metadata[uid]": uid,
    "metadata[pack]": pack,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(p.usdCents),
    "line_items[0][price_data][product_data][name]": p.name,
  });
  const res = await fetchFn("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  if (!res.ok) {
    console.error(`[stripe] checkout create failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const body = (await res.json()) as { id?: string; url?: string };
  if (!body.id || !body.url) return null;
  return { id: body.id, url: body.url };
}

/**
 * Verify a Stripe-Signature header over the RAW request payload. v1 scheme:
 * HMAC-SHA256(`${t}.${payload}`, webhookSecret), 5-minute default tolerance.
 */
export function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  now: number = Date.now(),
  toleranceSec = 300,
): boolean {
  let t = "";
  const v1s: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k?.trim() === "t" && v) t = v.trim();
    if (k?.trim() === "v1" && v) v1s.push(v.trim());
  }
  if (!t || v1s.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest();
  for (const v1 of v1s) {
    let presented: Buffer;
    try {
      presented = Buffer.from(v1, "hex");
    } catch {
      continue;
    }
    if (presented.length === expected.length && crypto.timingSafeEqual(presented, expected)) return true;
  }
  return false;
}

/** The bits of a webhook event we act on. */
export interface StripeEventSummary {
  kind: "credit" | "refund" | "ignore";
  /** checkout session id (credit) or payment_intent id (refund). */
  id: string;
  uid?: string;
  pack?: string;
}

/** Classify a parsed webhook event (pure). */
export function classifyStripeEvent(evt: Record<string, unknown>): StripeEventSummary {
  const type = String(evt.type ?? "");
  const object = ((evt.data as Record<string, unknown> | undefined)?.object ?? {}) as Record<string, unknown>;
  if (type === "checkout.session.completed") {
    const meta = (object.metadata ?? {}) as Record<string, unknown>;
    return {
      kind: "credit",
      id: String(object.id ?? ""),
      uid: typeof meta.uid === "string" ? meta.uid : undefined,
      pack: typeof meta.pack === "string" ? meta.pack : undefined,
    };
  }
  if (type === "charge.refunded") {
    return { kind: "refund", id: String(object.payment_intent ?? "") };
  }
  return { kind: "ignore", id: "" };
}

/** Find the checkout session id behind a payment_intent (refund clawback). */
export async function sessionIdForPaymentIntent(
  paymentIntent: string,
  cfg: StripeConfig = stripeConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  if (!cfg.secretKey || !paymentIntent) return null;
  const res = await fetchFn(
    `https://api.stripe.com/v1/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntent)}&limit=1`,
    { headers: { authorization: `Bearer ${cfg.secretKey}` } },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return body.data?.[0]?.id ?? null;
}
