# Lisa v0.20.0

The **"Lisa Cloud"** release — accounts, billing, cloud inference, and mobile
in-app purchases. Everything through v0.19 ran on the user's own keys, on the
user's own machine; v0.20 adds an opt-in hosted path so someone can sign in, get
a free window, top up, and run Lisa without bringing a key — while the local,
bring-your-own-key experience stays exactly as it was.

Typecheck green · full test suite green (**1123 tests**) · no breaking changes for
existing local users (all cloud/billing is opt-in behind sign-in + `LISA_*` flags).

## ✨ Accounts & auth (B0–B1, B8)

- **Email + password** accounts (scrypt, HMAC sessions, auth endpoints,
  in-app deletion) and **Sign in with Apple** — on iOS (primary flow) and on the
  web login page (Services-ID audience).
- **Email verification** via Resend; a verified account levels the free window
  from $1 → $5.
- **Sign in to LISA Cloud** from the Mac menu-bar app; anomaly alerts reach the
  phone.

## ✨ Billing (B3–B6, B8c)

- **Usage meter + face-value price table** and a **quota engine**: a 12-hour
  session window, paid tiers, a 402 paywall, and a per-turn budget breaker.
- **StoreKit 2 consumable credits** on iOS with **server-side JWS receipt
  verification** (Apple G3 root pinned) and ASN refund clawback.
- **Stripe top-up** for desktop/web + a `/account` self-service page.
- **Inference gateway (B6)** — a uid-authed gateway so signed-in Macs/CLI run
  **key-free**; metered per turn.

## ✨ Cloud & multi-tenancy (B2, B9)

- **Per-uid home isolation** via an AsyncLocalStorage seam + lazy per-user birth,
  and **per-tenant SSE fan-out + mood state** — one process serves many accounts
  without crosstalk.
- **Firestore state backend + per-uid turn lease** (behind `LISA_FIRESTORE=1`) so
  the service can run **multi-instance** with one metered turn per account at a
  time.

## 🛡️ Operations + review hardening

- **B7 controls:** per-uid rate limits, a global daily spend cap, a kill switch,
  anomaly alerting, and a reviewer-account seed. Operator runbook in
  [`docs/`](.) (Apple portal, App Store Connect, DNS, deploy, 1.1 submission).
- **Adversarial review pass (#276)** closed the ways the stack could lose money,
  stay up under load, or trust something it shouldn't:
  - metered turns can't ship free (meter/gateway/limits fail **closed**, and a
    debit on an unwritable balance store retries + logs loudly + refuses new
    turns rather than silently dropping the charge);
  - a transient lease-renewal blip no longer strands the lease into a peer
    double-run; concurrent login guesses can't outrun the lockout; the gateway
    body cap can't be disabled by a mistyped env; the per-IP limiter fails
    **open** so a spoofed-header flood can't lock out real users;
  - the Apple IAP certificate chain pins the G3 root on every path.

## 📱 iOS 1.1 (accounts / IAP)

`MARKETING_VERSION 1.1` ships the accounts + in-app-purchase flow to TestFlight.
Note: the Sign-in-with-Apple **nonce** path is compile-verified but not yet
exercised against a live Apple sign-in, so `LISA_CLOUD_APPLE_REQUIRE_NONCE` stays
**default-off** until a TestFlight build confirms it — a present nonce is always
verified regardless.

## 📝 Notes

- **Local users are unaffected:** no sign-in, no gateway, no Firestore ⇒ Lisa
  behaves exactly as in v0.19 on your own keys and your own machine.
- Cloud paths activate only behind an account + the relevant `LISA_*` flags.
