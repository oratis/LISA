# PLAN — Identity & connection model: "one identity, two data planes" (v1.0)

**Status: DESIGN, for review.** Resolves three questions raised about how the
iOS app connects and whether a cloud user system is warranted. Builds on the
shipped pieces: per-device tokens ([devices.ts](../src/web/devices.ts)),
scheme-aware iOS config (#161), the cloud edition flag
([edition.ts](../src/edition.ts)), and the durable cloud M0
([PLAN_CLOUD_v1.0.md](PLAN_CLOUD_v1.0.md)).

## The thesis: decouple *who you are* from *where your LISA lives*

LISA has two legitimate deployment shapes, and they must not be conflated:

- **Your Mac** = the full-power, local-first, private edition (spawns/steers your
  local `claude`/`codex`, Sense, dispatch). Data lives in `~/.lisa`.
- **LISA Cloud** = the no-Mac on-ramp (chat + companion + cloud agents). Data
  lives per-user in the cloud.

The mistake would be to put a cloud account *in front of the local connection* —
that adds a third party to "your AI on your machine" without removing the need to
reach the Mac. The right model:

```
                 Identity (who you are)
                         │
          ┌──────────────┴───────────────┐
   Data plane A: your Mac          Data plane B: LISA Cloud
   token / Tailscale, E2E          per-uid home, hosted
   data NEVER leaves the Mac       data in your cloud account
   = full power                    = on-ramp, no Mac needed
```

One identity; the **user chooses the data plane**. This maps directly onto the
`LISA_EDITION` flag we already ship.

## Where we are today (recap)

- **iOS ↔ Mac**: phone is a thin client that talks **directly** to the Mac's
  `lisa serve --web` over LAN IP or a **Tailscale** tailnet name. Pairing
  (`lisa pair`) mints a **per-device token** (only its SHA-256 hash is stored in
  `~/.lisa/devices.json`; revocable per device) and shows a `lisa-pair://` QR.
  Auth = loopback-trusted, else a valid device token / `LISA_WEB_TOKEN`. **No
  cloud, no accounts.** This is correct for the local edition — keep it.
- **iOS ↔ Cloud**: since #161 the app can point at an HTTPS cloud URL; the M0 demo
  uses a single shared `LISA_WEB_TOKEN` and a **single shared soul** (not yet
  per-user).

## Decision 1 — Cloud needs a real user system (C3). ✅ Yes.

For the *cloud* data plane, accounts are not optional — a hosted multi-tenant
LISA must authenticate users and isolate their souls.

- **Login: Sign in with Apple.** Simplest, native on iOS, and Apple *requires* it
  once you offer any third-party login — so starting here avoids rework. (Add
  email/Google later only if needed.)
- **Token verification**: the iOS app obtains an Apple identity token (JWT); the
  server verifies it (RS256 against Apple's JWKS; validate `iss`/`aud`/`exp`) →
  a stable `uid` (Apple's `sub`). Two implementation choices:
  - **A. Firebase Auth** — handles Apple/Google verification + a user directory +
    revocation out of the box; matches the cloud plan's C3. Adds a GCP dependency.
  - **B. Custom verifier** — a small `src/cloud/identity.ts` that fetches Apple's
    JWKS and verifies the JWT (via `jose`), no extra service. Leaner, but we own
    session issuance + a user record store.
  - **Recommendation: B (custom verifier)** for v1 — fewer moving parts, no vendor
    lock, and the verification is ~80 lines + tests. Graduate to Firebase only if
    we add multiple providers / need its directory.
- **Session**: after verifying the Apple token once, issue a LISA session cookie
  (HMAC-signed, `uid`-scoped, expiring) so every later request is cheap. This
  replaces the shared `LISA_WEB_TOKEN` in cloud edition (the shared token stays
  the *reviewer-demo* fallback behind a flag).

### The hard part — per-uid isolation (the multi-tenant core)

Today `LISA_HOME` is **process-global** ([paths.ts](../src/paths.ts) computes it
once), so the whole codebase reads one soul. Multi-tenant requires a **per-request
home context**:

1. **Home seam**: introduce `homeFor(uid)` → `${LISA_HOME}/users/<uid>` and thread
   a request-scoped home through the soul/session stores (today they import the
   global). This is the largest refactor in the plan — every `store.ts` call gains
   a home/uid context. Do it behind the cloud edition so the Mac edition is
   untouched (it keeps the single global home).
2. **Per-uid GCS**: the C2 bucket already mounts at `/data`; per-uid just uses the
   `/data/users/<uid>` subtree — no new infra, only the seam.
3. **Birth-on-first-login**: a new user's first authenticated request births
   *their* soul under their home (the entrypoint's one-shot birth becomes
   per-user, lazy).

This is genuinely multi-PR work; it is the gate before *any* real cloud user
beyond a reviewer. Until it lands, cloud stays single-shared-soul (M0).

## Decision 2 — Local reachability: Tailscale now, relay later (maybe never).

The local data plane's only real friction is *reachability* (same Wi-Fi, or set
up Tailscale). Options:

- **Tailscale (recommend now)**: already solves private NAT traversal with E2E
  encryption and **zero data in any cloud** — exactly the local-first property we
  want. Action: make it a first-class, documented, near-one-tap path (the Mac
  app's pairing screen detects/links Tailscale; `lisa pair --host <tailnet>` is
  already supported).
- **A custom cloud relay (defer)**: a LISA-run rendezvous so the phone reaches the
  Mac with no user network setup. To keep the thesis it must be a *blind* E2E
  tunnel (the relay never sees plaintext) — which is ~rebuilding Tailscale.
  **Not worth it pre-PMF.** Revisit only if Tailscale friction provably blocks
  adoption.

**Verdict**: no relay in v1. Lean into Tailscale + smooth the pairing UX.

## Decision 3 — iOS surfaces the choice: a "connection mode".

A first-class **`ConnectionMode` = { My Mac, LISA Cloud }** in the app:

- **My Mac** — the existing pairing (QR / `lisa-pair://` / manual host+port+token),
  over LAN/Tailscale. Data stays on the Mac.
- **LISA Cloud** — Sign in with Apple (interim: paste a cloud URL+token). Hosted.

The mode is the stable UX primitive; Sign in with Apple just fills the cloud
mode's auth in I2. Settings shows only the fields relevant to the chosen mode.

## Phasing

| Phase | What | Needs |
| --- | --- | --- |
| **I1 (now)** | iOS `ConnectionMode` scaffold (My Mac / Cloud) — forward-compatible UX | — |
| **I2** | Cloud **Sign in with Apple**: `src/cloud/identity.ts` verifier + session cookie + iOS Sign-in button | Apple: enable "Sign in with Apple" capability + a Services ID/key (you) |
| **I3** | **Per-uid home** refactor + per-uid GCS subtree + lazy per-user birth (the multi-tenant core) | the home-seam refactor |
| **I4** | Account lifecycle (sign-out, deletion per App Store 5.1.1(v)), abuse limits; revisit relay | — |
| **(local)** | Make Tailscale a one-tap pairing path in the Mac app | — |

## Security / privacy invariants (must hold)

- The **local data plane never sends user data to any LISA-run cloud** — token/
  Tailscale only; the cloud account (if signed in) is identity, not a data pipe.
- Cloud souls are **isolated per uid**; no cross-tenant read (a test gates this).
- Account **deletion removes the cloud home** (Apple requirement + privacy).
- Reviewer-demo shared token survives only behind an explicit flag, off for real
  users once I2/I3 land.

## What this turn ships

- This doc.
- **I1**: the iOS connection-mode scaffold (below). I2/I3 are sequenced; I2 is
  blocked on you enabling "Sign in with Apple" for `ai.meetlisa.pocket` in the
  Apple Developer portal.
