# PLAN — LISA Cloud (GCP) v1.0

**Status: DESIGN, for review. Nothing built yet.**

## Why

Today LISA is a **local-first** companion: the iOS app (Lisa Pocket) is a thin
client that pairs to *the user's own Mac* running `lisa serve`. That's great for
power users but blocks two things:

1. **People without a Mac** can't use LISA at all.
2. **App Store review** — reviewers have no Mac to pair, so the app looks
   non-functional (Guideline 2.1 rejection risk).

LISA Cloud is a **hosted LISA backend on GCP** so a phone-only user (and an App
Store reviewer) can sign in and use LISA with no Mac. The iOS app stays the same
client; it just points at a cloud URL instead of a LAN Mac.

## Non-goals (v1)

- **Not** a replacement for the Mac edition. The Mac stays the "full power"
  tier (local agent control plane, PTY, dispatch to your real `claude`/`codex`,
  Sense/screen, mail on your machine).
- **Not** running arbitrary user CLIs in the cloud (no PTY / no spawning the
  user's `claude` binary in a shared sandbox — security + cost).
- **Not** a team/multi-seat product. One account = one private LISA.

## The core tension

LISA is **stateful** (a soul, memory, sessions, desires that evolve over months
— the whole thesis) and **spawns local processes** (dispatch/PTY/Sense). Neither
fits a stateless autoscaling box directly. So v1 makes two decisions:

- **Per-user persistent state**, isolated. Each user's `~/.lisa` equivalent
  lives in their own durable store; a cloud instance hydrates it on start and
  persists changes.
- **Feature delta**: the cloud edition is the *chat + companion + cloud-agent*
  subset. Local-machine features (PTY adopt, dispatch to local CLIs, Sense
  screen/voice, on-device mail sweep) are **Mac-only** and hidden/disabled in
  cloud mode.

## Feature matrix — Mac vs Cloud (v1)

| Capability | Mac | Cloud v1 |
| --- | --- | --- |
| Chat with Lisa (soul, mood, memory, desires) | ✓ | ✓ |
| Rêve (recap, advisor, while-you-were-away) | ✓ | ✓ |
| Managed agents (LISA's own agent loop, cloud-side) | ✓ | ✓ (sandboxed, no shell) |
| Mail module (IMAP/Gmail digest + alerts) | ✓ | ✓ (runs in the cloud instance) |
| Proactive / autonomy (idle + heartbeat) | ✓ | ✓ |
| Push (APNs) | ✓ | ✓ |
| PTY / adopt real claude·codex CLIs | ✓ | ✗ (no shell sandbox) |
| dispatch_agent to local CLIs | ✓ | ✗ |
| Sense (screen / voice / clipboard) | ✓ | ✗ (no host) |
| Agent control plane over your terminals | ✓ | ✗ |

The cloud edition advertises itself (`/api/edition` → `cloud`) so the client
hides Mac-only surfaces (Control tab's PTY/adopt, Sense capture toggles).

## Architecture (GCP)

```
 iOS app ──HTTPS──▶  [ Cloud Load Balancer + Cloud Armor ]
                              │
                     [ API Gateway / router ]  ◀─ Firebase Auth (Sign in with Apple)
                       │ resolves user → instance
                       ▼
                 [ Cloud Run service: lisa-cloud ]   (the lisa serve --web container,
                       │  one revision, autoscaled,    edition=cloud, per-request user ctx)
                       │  scale-to-zero per-user via concurrency=1 sessions)
            ┌──────────┼───────────────┐
            ▼          ▼               ▼
   [ GCS / Filestore ] [ Firestore ]  [ Secret Manager ]
    per-user LISA_HOME   accounts,      per-user API keys,
    (soul/memory/        billing,       APNs key, IMAP creds
     sessions/mail)      device tokens
                              │
                        [ APNs ]  ◀ push from the instance
```

### Components

- **Cloud Run** runs the existing `lisa serve --web` container with
  `LISA_EDITION=cloud`. The image is the repo's Node server, containerized
  (`website/Dockerfile` already exists for the site; we add `deploy/Dockerfile`
  for the server).
- **Identity: Firebase Auth / Identity Platform** with **Sign in with Apple**
  (required by Apple if we offer any third-party login; for v1 Apple-only is
  simplest + privacy-friendly). The ID token authorizes every `/api/*` call
  (replaces the loopback/LISA_WEB_TOKEN gate with a verified `uid`).
- **Per-user state**: each `uid` maps to a durable `LISA_HOME`. Two options to
  pick in review:
  - **(A) GCS-backed home** — sync the user's `~/.lisa` tree to a per-user GCS
    prefix; hydrate on session start, flush on change/idle. Cheapest, scale-to-
    zero friendly; needs a small sync layer + careful write ordering.
  - **(B) Filestore (NFS)** per-user dir — closest to "it's just a filesystem",
    no LISA refactor, but always-on cost + a mount per instance.
  - Recommendation: **A** for v1 (cost), behind a `CloudHome` abstraction so the
    file-based modules (`paths.ts`, soul/memory/sessions/mail stores) are
    untouched — they read/write a local temp dir that's hydrated/flushed.
- **Accounts + metadata: Firestore** — `users/{uid}`: plan, created, APNs
  device tokens, push prefs, mail-account *metadata* (secrets in Secret
  Manager), billing status.
- **Secrets: Secret Manager** — the model API key and any IMAP/OAuth tokens,
  per user, never in Firestore. (v1: **bring-your-own Anthropic key** — the user
  pastes it in the app → stored in Secret Manager → the instance uses it. Avoids
  us reselling tokens; revisit a LISA-billed tier later.)
- **Routing / isolation**: Cloud Run is multi-tenant (one service). Isolation is
  **logical**: every request carries the verified `uid`; the server scopes all
  state access to that user's hydrated home. A misrouted/missing `uid` ⇒ 401.
  (Stronger isolation — a Cloud Run *instance per user* via a router — is a v2
  option if logical isolation proves insufficient.)
- **Push**: the instance sends APNs exactly as the Mac does (`src/web/push.ts`),
  using the LISA APNs key from Secret Manager. Digest/alert/agent pushes work.
- **Edge**: HTTPS LB + **Cloud Armor** (rate-limit, WAF) in front; Cloud Run
  ingress restricted to the LB.

### Concurrency / cost model

- Cloud Run **scales to zero** — idle users cost nothing. A request (chat,
  refresh, push-triggered wake) spins an instance, hydrates the user's home,
  serves, flushes, and can shut down.
- The expensive part is the **LLM loop** (Anthropic). v1 = **user's own API
  key** → the user pays Anthropic directly; LISA Cloud charges only for hosting
  (or is free/beta). A later **managed tier** (LISA-billed tokens) needs metering
  + Stripe — out of scope for v1.
- Heartbeat/idle autonomy in the cloud: gated behind a per-user **budget** +
  only when the user has opted in, so a paused tab can't run up cost.

## Auth + account lifecycle

- **Sign in with Apple** → Firebase `uid`. First sign-in provisions an empty
  LISA (birth ritual runs in the cloud).
- The iOS app gets a long-lived session; every API call sends the Firebase ID
  token; the server verifies it (Admin SDK) and resolves the user's home.
- **Account deletion (Apple-required)**: an in-app "Delete my LISA" → server
  endpoint that wipes the user's GCS home + Firestore doc + Secret Manager
  secrets + APNs tokens. (Also satisfies the App Store account-deletion rule.)
- **Mode switch in the app**: Settings → "Connect to" → *My Mac* (LAN pairing,
  today) or *LISA Cloud* (sign in). Same client, two backends.

## App Store reviewability (the unlock)

- Provide a **demo account** (or let review use Sign in with Apple to a seeded
  sandbox) so reviewers exercise the full app with **no Mac**. Put the creds +
  a 30-sec flow in App Review Notes.
- This converts the app from "needs hardware we can't test" → "works on its
  own," clearing Guideline 2.1.

## Security + privacy

- Per-user logical isolation enforced server-side on the verified `uid`;
  add a test that a token for user A can never read user B's home.
- Secrets only in Secret Manager; never logged. Mail stays metadata+snippet.
- TLS everywhere (LB). Cloud Armor rate-limits + blocks abuse.
- Data residency: single region v1 (us-central1, matching the existing
  `<your-gcp-project>` project / Cloud Run site deploy).
- Privacy policy must disclose: account (Apple uid), chat content stored to
  provide the service, the user's API key, optional mail metadata. Feeds the App
  Privacy nutrition label.

## What it costs us to build (rough phases)

- **C1 — containerize + edition flag**: `deploy/Dockerfile` for the server;
  `LISA_EDITION=cloud` hides Mac-only features + flips the auth gate to "verify
  Firebase token." Deploy one shared instance (single test user) on Cloud Run.
- **C2 — per-user home (`CloudHome`)**: hydrate/flush a per-`uid` GCS home behind
  the existing `LISA_HOME`; the file stores stay unchanged. Logical isolation +
  the cross-user test.
- **C3 — auth + accounts**: Firebase Auth (Sign in with Apple), Firestore user
  docs, Secret Manager for the API key, in-app sign-in + "Cloud vs Mac" switch +
  account deletion.
- **C4 — push + mail in cloud**: APNs from the instance; mail sweep on a Cloud
  Scheduler tick per active user.
- **C5 — harden + demo**: Cloud Armor, budgets, the App-Review demo account, the
  privacy policy page.

## Open questions for review

1. **API key model** — bring-your-own (v1, simplest) vs LISA-billed managed tier
   (needs metering + Stripe). Confirm v1 = BYO key?
2. **State store** — GCS-backed home (A, cheap, scale-to-zero) vs Filestore (B,
   simplest, always-on). Recommend A.
3. **Login** — Sign in with Apple only (simplest, Apple-friendly) vs also
   email/Google (more friction + Apple then *requires* Sign in with Apple too).
4. **Autonomy in cloud** — allow proactive/idle loops (cost) or chat-only until a
   paid tier?
5. **Region / project** — reuse `<your-gcp-project>` + us-central1?
6. **Pricing** — free beta, or a hosting fee from day one?

---

*Once you've picked answers to the open questions, I'll turn the chosen path into
a build plan (C1–C5) and start with C1 (containerize + edition flag), which is
also the smallest step that yields a reviewer-usable demo backend.*
