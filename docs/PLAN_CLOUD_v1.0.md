# PLAN — LISA Cloud (GCP) v1.0

**Status: M0 DEPLOYED — reviewer demo, live on GLM.** Project `oratis-491316`.
C1 (edition flag + cloud auth gate + `/api/edition`) and M0 (Cloud Run service
`lisa-cloud`, us-central1, a GLM-`glm-4.6`-birthed demo soul) are live and
verified (401/401/200 auth gate, cloud edition, end-to-end chat). The live URL +
demo token are NOT committed — they live in the Cloud Run env. Includes a 正反方
debate (below) whose verdict is a **Conditional GO — M0 (reviewer demo) only,
defer public multi-tenant**. Still in force: **C2 (`CloudHome` GCS persistence)
is required before any real (non-reviewer) user**, since the demo soul is held in
a single warm instance and resets on cold start.

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

## 正反方辩论 / Pro–Con debate (should we build LISA Cloud at all?)

A steelman of each side before committing, because this decision touches the
product's founding thesis — not just engineering.

### 正方 — FOR building it

- **It's the only thing that unblocks the App Store.** Reviewers can't pair a
  Mac, so without a no-Mac path the iOS app is effectively un-shippable
  (Guideline 2.1). If shipping iOS matters, this is on the critical path.
- **Market.** Mac-only caps LISA to Mac power users; the overwhelming majority of
  phone users can't touch it. Cloud is the on-ramp — and an upsell funnel to the
  Mac "full power" tier.
- **Small delta, not a rewrite.** The server + iOS client already exist; cloud is
  *containerize + verify-token + per-user home*, and Cloud Run scale-to-zero
  keeps idle cost ≈ $0. We're reusing `oratis-491316`, already wired for deploys.
- **Forcing function for multi-user hygiene** (auth, isolation, account deletion)
  that the product will eventually need anyway.

### 反方 — AGAINST (the honest risks)

- **It contradicts the founding thesis.** LISA's whole identity — and the
  research framing (a *local*, long-horizon, privacy-first evolving companion) —
  is "your soul/memory stays on your machine." Storing users' soul + chat + API
  keys on Google servers is the opposite promise. This is the heaviest weight,
  and it's a *narrative/credibility* cost, not just a technical one.
- **You become a data processor.** Holding chat + provider API keys in a
  multi-tenant box = a breach target + real legal surface (GDPR/CCPA, deletion,
  incident response, a privacy policy you must honor). v1's isolation is
  *logical only* (one Cloud Run service) — a single cross-tenant bug leaks
  everyone.
- **Ops drift for a solo researcher.** Even scale-to-zero, you now run prod
  infra (LB, Cloud Armor, Firestore, Secret Manager, monitoring, on-call). Time
  spent here is time not spent on the thesis/paper.
- **The cloud edition is the gutted edition.** No PTY / dispatch / Sense / agent
  control plane — i.e. none of the differentiators. Cloud LISA risks being
  judged as "another chat app with memory," anchoring perception to the weakest
  tier.
- **The unblock has cheaper alternatives.** (a) ship iOS *later*, TestFlight-only
  for Mac owners now; (b) expose a seeded demo Mac backend to App Review over a
  tunnel; (c) frame the app honestly as "a companion to your Mac" (remote-desktop
  -style apps do pass review). None of these require running a business.
- **Stateful soul vs stateless box.** Hydrate/flush a per-user `~/.lisa` to GCS
  on every cold start is fiddly + race-prone — and continuity-over-months is
  exactly the property the thesis cares most about getting right.

### 裁决 / Synthesis — Conditional GO, scoped tight

The App-Store-unblock is real but overstated as a *forcing* reason (cheaper
paths exist). The brand/thesis + liability tension is the dominant consideration.
Net recommendation:

1. **Build M0 only, now** — the smallest thing that yields a **reviewer-usable
   demo**: C1 (containerize + `LISA_EDITION=cloud` + verify-token gate) + a single
   **seeded demo account**. **Do NOT open public multi-tenant signups yet.** This
   gets the App Store unblock without committing to a data-processor business.
2. **Re-evaluate the full multi-tenant cloud (C2–C5) separately**, only after the
   iOS app is otherwise ready and you've explicitly accepted the brand/liability
   trade. It's a real fork, not an automatic follow-on.
3. **Guardrails if it proceeds past M0** — BYO API key only (never resell
   tokens); a cross-tenant isolation test in CI; keep **local-first the flagship
   and cloud the explicitly-"lite" tier** in all copy; in-app account deletion;
   move to a dedicated `lisa-cloud-prod` project before real signups; published
   privacy policy.

This keeps the thesis intact (local stays the headline), clears review, and
defers the heavy commitment until it's a deliberate choice.

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
  `oratis-491316` project / Cloud Run site deploy — where meetlisa.ai's
  `lisa-web` service already runs).
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

## M0 deploy runbook (C1 — reviewer demo) ✅ scaffolded

The C1 code is merged (`src/edition.ts` edition flag, the cloud auth gate that
drops loopback trust, `GET /api/edition`). The container + deploy glue lives in
`deploy/`:

| File | Role |
| --- | --- |
| `deploy/Dockerfile` | multi-stage `node:22-slim`; builds `dist/`, ships assets, `ENV LISA_EDITION=cloud LISA_HOME=/data`, runs `entrypoint.sh`. |
| `deploy/entrypoint.sh` | first-boot: seed a demo soul (`lisa birth`, idempotent via `isBorn()`) using whichever provider key is set, then `lisa serve --web --host 0.0.0.0`. |
| `deploy/deploy.sh` | `gcloud run deploy lisa-cloud --source .` to `oratis-491316/us-central1`, `--min-instances 1` (keep the demo warm + stateful on the ephemeral Cloud Run FS), secrets via env (comma-safe `^##^` delimiter). |

**State caveat.** Cloud Run's container FS is ephemeral. `--min-instances 1`
keeps one warm instance so the seeded soul/sessions survive between requests; a
cold start (or scale-to-2) re-births a fresh demo soul. That's acceptable for an
M0 *reviewer demo* but **not** for real users — C2 (`CloudHome` on GCS) is the
prerequisite before anyone but a reviewer touches it.

**Auth.** Cloud Run IAM is `--allow-unauthenticated` (the reviewer needs to reach
the URL), and the *app's own* `LISA_WEB_TOKEN` gate is the real auth — in cloud
edition loopback is no longer trusted, so every request needs the token. Hand the
reviewer `https://<service-url>/?token=<LISA_WEB_TOKEN>` (opens authed, pins a
cookie). The two secrets are `LISA_WEB_TOKEN` + one rate-limited LLM key.

**Provider/model.** The birth + run gates are provider-aware
(`hasCredentialsForModel`), so any one of these funds the demo and picks the
model: `ZHIPU_API_KEY` → GLM (`LISA_MODEL=glm-4.6`, defaulted), `ANTHROPIC_API_KEY`
→ Claude, `OPENAI_API_KEY` → GPT. **The M0 demo runs on GLM** (`glm-4.6`,
bigmodel.cn OpenAI-compatible endpoint, LISA's built-in Zhipu preset).

**Run it (you, with your secrets — this is real prod GCP + spends money):**

```sh
# GLM (the M0 demo):
LISA_WEB_TOKEN='<demo-password>' \
ZHIPU_API_KEY='<rate-limited-glm-key>' \
deploy/deploy.sh
```

Overrides: `PROJECT` (default `oratis-491316`), `REGION` (`us-central1`),
`SERVICE` (`lisa-cloud`), `LISA_MODEL`. For production-grade secret handling,
swap the `--set-env-vars` for Secret Manager (`--set-secrets`) before M1.

## Open questions for review

1. **API key model** — bring-your-own (v1, simplest) vs LISA-billed managed tier
   (needs metering + Stripe). Confirm v1 = BYO key?
2. **State store** — GCS-backed home (A, cheap, scale-to-zero) vs Filestore (B,
   simplest, always-on). Recommend A.
3. **Login** — Sign in with Apple only (simplest, Apple-friendly) vs also
   email/Google (more friction + Apple then *requires* Sign in with Apple too).
4. **Autonomy in cloud** — allow proactive/idle loops (cost) or chat-only until a
   paid tier?
5. **Region / project** — ✅ DECIDED: reuse **`oratis-491316` + us-central1** for
   v1 (a new Cloud Run service `lisa-cloud` next to `lisa-web`). Graduate to a
   dedicated `lisa-cloud-prod` project before opening real multi-tenant signups,
   to isolate user secrets + agent workloads from the marketing site.
6. **Pricing** — free beta, or a hosting fee from day one?

---

*Once you've picked answers to the open questions, I'll turn the chosen path into
a build plan (C1–C5) and start with C1 (containerize + edition flag), which is
also the smallest step that yields a reviewer-usable demo backend.*
