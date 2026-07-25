# Lisa v0.21.0

The **"open the doors"** release — the sign-in surface that makes v0.20's Lisa
Cloud usable by anyone (a mailed code or a Google button, no key), a **Knowledge
Base v2.0** that turns the web into Lisa's memory, and the production hardening
that lets the hosted service take real traffic. The local, bring-your-own-key
experience is unchanged; everything cloud/KB is opt-in.

Typecheck green · full test suite green (**1383 tests**) · no breaking changes for
existing local users.

## ✨ Sign in & sign up (A-series)

- **Mailed one-time codes** — type an address, get six digits, you're in.
  Registering and signing in are the same act, because reading the mail is the
  proof; passwords still work behind "Use a password instead."
- **Sign in with Google** on the web login page (GIS button, id-token verified
  against the web/iOS client ids) and in the iOS app.
- The account model binds Google/Apple/OTP/password entrances to **one** account
  per verified inbox — a later sign-in never forks the balance, and proving inbox
  ownership drops any password set before ownership was proven (pre-hijacking
  guard).

## ✨ Signup abuse gates (S3)

- **Cloudflare Turnstile** bot-gate on registration (opt-in; degrades gracefully
  when unconfigured), a **disposable-email blocklist**, and a per-IP registration
  cap — every signup ignites an LLM birth, so the signup path gets its own screws.
- **Transactional birth** — the soul's `seed.json` (the "is-born" flip) is written
  **last**, after the whole soul is on disk, so a crash mid-birth just re-runs
  instead of wedging a half-born soul. A **single-flight ceremony hub** means two
  concurrent requests share one birth, never two racing LLM calls.

## ✨ Knowledge Base v2.0 (K-series)

- **Ingest engine**: any URL → provenance-stamped, CJK-safe Layer-1 markdown,
  with **site adapters** for WeChat, Bilibili, and YouTube.
- **Link graph**: `[[links]]` parse into a real graph; `index.md` becomes a ranked
  map-of-content, and memories ⇄ KB cross-link with inline titles + autolink.
- **Daily feeds brief**: sweep, classify, and personally rank sources into a
  daily digest.
- Ingest surfaces everywhere: a web paste bar, a chat chip, an API route, and
  `lisa kb` on the CLI.

## ✨ Per-uid autonomy (S4)

- The cloud edition finally gives **signed-in tenants** the heartbeat a Mac gets:
  a scheduled sweep walks recently-active accounts and runs one reflection per
  due soul, at a **tier cadence** (free 24h / tier-1 6h / tier-2 1h).
- Autonomy is a **free perk with a floor**: it never charges the user, but it
  bows to the global kill switch (`LISA_BILLING_KILL`) and the $200/day cap, and
  its face cost is metered to the audit ledger — a large cohort can't quietly run
  the bill away. Birth honors the same floor.

## ✨ Production hardening (S6)

- **Secret Manager mode** for `deploy/deploy.sh` (`SECRETS_MODE=sm`) — sensitive
  values ship to Secret Manager and reach the container by reference, never as
  console-visible env vars; the master token no longer echoes into deploy logs.
- **B9 Firestore import** script (with an empty-source guard so a misinvocation
  can't wipe accounts) for the file→Firestore cutover that unlocks multi-instance.
- A **production runbook** (`docs/RUNBOOK_CLOUD_PROD.md`) covering the deploy,
  the third-party consoles, the domain mapping, and the Cloud Scheduler sweep.

## 🔒 Security & fixes

- **CSRF-guard on auth POSTs** — a `Content-Type: application/json` requirement
  closes a cross-site login/register vector (session fixation via a `text/plain`
  form POST).
- **Mail**: real IMAP auth rejections are told apart from host/network errors, so
  a flaky server no longer blames the user's password.
- iOS: `CFBundleShortVersionString` pinned to `$(MARKETING_VERSION)` so version
  bumps actually ship; StoreKit config so the simulator renders the paywall.

## For existing local users

Nothing changes. All cloud, accounts, billing, autonomy, and Secret-Manager
behavior is behind sign-in and `LISA_*` flags; the Knowledge Base is opt-in. Run
Lisa on your own key, on your own machine, exactly as before.
