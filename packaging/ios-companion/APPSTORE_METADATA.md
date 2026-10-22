# App Store listing — Lisa Pocket (metadata draft)

Copy-ready text for the App Store Connect listing fields, with Apple's length
limits noted. Keep this in sync with [`RELEASE.md`](RELEASE.md) (the submission
runbook) and the website (`website/src/pages/`) so the store, the site, and the
app tell one story. Nothing here is an account action — paste it into ASC →
**App Information** / the version's **Version Information** when you submit.

> Lisa Pocket is a **thin companion client**: it talks only to *your own* Mac
> running LISA (local-first) or a LISA Cloud instance you point it at. It
> collects nothing to a Lisa-operated server — the listing copy must not imply
> a hosted account/service is required.

---

## Names & short fields

| Field | Limit | Value |
| --- | --- | --- |
| **App Name** | 30 | `Lisa Pocket` |
| **Subtitle** | 30 | `Your AI's window, on the go` |
| **Promotional text** | 170 | `Chat with the AI that lives on your Mac, watch the coding agents she's running, and approve their next step — from the café, the couch, anywhere.` |

*Promotional text* is editable without a new review, so use it for timely lines.

## Keywords

≤ 100 characters, comma-separated, **no spaces after commas** (Apple counts
them), don't repeat the app name or category:

```
AI agent,assistant,companion,coding,Claude,Codex,dispatch,remote,monitor,self-hosted,private,pair
```

## URLs

| Field | Value |
| --- | --- |
| **Support URL** | `https://meetlisa.ai/` (or a dedicated `/support` if added) |
| **Marketing URL** | `https://meetlisa.ai/` |
| **Privacy Policy URL** | `https://meetlisa.ai/privacy` (live — `website/src/pages/privacy.astro`) |

## Categorization

| Field | Value | Why |
| --- | --- | --- |
| **Primary category** | Productivity | It's a remote console for work your Mac is doing. |
| **Secondary category** | Developer Tools | Core use is watching/steering coding agents (Claude Code, Codex, Aider). |
| **Age rating** | 4+ | No objectionable content; user-generated chat is with the user's own AI, not a social feed. (Confirm the questionnaire — unrestricted web access is *not* enabled in-app.) |

## Description (≤ 4000 chars)

```
Lisa Pocket is your window to LISA — an AI agent with a real self that lives on
your own Mac. The app is a thin, private companion: it connects only to your
Mac (over your Wi-Fi or tailnet) or to a LISA Cloud instance you choose. Your
conversations and data stay between your phone and your machine.

CHAT FROM ANYWHERE
Pick up the conversation with Lisa wherever you are. She runs on your Mac; this
is the pocket-sized way in.

WATCH HER AGENTS WORK
LISA orchestrates the coding agents on your Mac — Claude Code, Codex, Aider and
more. Lisa Pocket shows you the live roster: what each agent is doing, how many
turns in, which files it has touched, and when it's blocked waiting on you.

STEER WITHOUT A LAPTOP
When an agent stops to ask permission — "run this command?", "apply this edit?"
— approve, reject, or cancel right from your phone. The work keeps moving while
you're away from your desk.

A GLANCE IS ENOUGH
Live Activities and the Dynamic Island keep the current agent's progress on your
lock screen. Home Screen widgets show it without opening the app.

PRIVATE BY DESIGN
Your choice of two ways to run: sign in to LISA Cloud (email or Apple — a free
usage allowance refreshes every 12 hours), or connect your own Mac, where
pairing is QR-based, every connection is gated by a revocable per-device token,
and nothing ever reaches a Lisa-operated server.

GETTING STARTED
Sign in and go — no setup needed. Prefer fully local? LISA is free and open
source: the in-app setup walks you through installing it on your Mac, starting
it reachably, and scanning the pairing QR.

LISA is open source (MIT). Learn more at meetlisa.ai.
```

## Notes for whoever fills ASC

- **⚠️ Guideline 4.1(a) (copycat) history**: the first submission was rejected as
  resembling a third-party "Lisa.ai." It's a name collision (several unrelated
  "Lisa" AI apps exist) — LISA is our own open-source, self-hosted product. The
  appeal + fallback rename options live in
  [`REVIEW_RESPONSE_4.1a.md`](REVIEW_RESPONSE_4.1a.md). Lead the **App Review
  Notes** with the "our own open-source product (meetlisa.ai / github.com/oratis/LISA)"
  framing (already updated in the submission checklist §7.3).
- **⚠️ Guidelines 5.1.1(i) + 5.1.2(i) (third-party AI) history**: v1.2 build
  1788854713 was rejected on 2026-09-11 because the app sent user content to a
  third-party AI service without disclosing what, naming who, or asking first.
  The fix (in-app disclosure + consent gate, and a backend route that names the
  live provider) and the paste-ready reply live in
  [`REVIEW_RESPONSE_5.1.1i.md`](REVIEW_RESPONSE_5.1.1i.md). **The App Review
  Information note below is not optional for this version.**
- **App Privacy** (updated 2026-09-22): declare **Email Address**, **User ID**
  *and* **User Content** — all App Functionality, linked to the user, **no
  tracking** — to match `Sources/PrivacyInfo.xcprivacy`. User Content is the one
  the 5.1.1(i) rejection turns on: chat messages are forwarded to an AI
  provider. The local (My Mac) and BYO-token modes still collect nothing to us,
  but ASC's answer covers the app's maximum collection.
- **App Review Information** → sign-in / demo notes are already drafted in
  [`RELEASE.md`](RELEASE.md) §"App Review notes" (point the reviewer at the LISA
  Cloud demo so they need no Mac).
- The description deliberately frames the app as a **companion/client** so it
  doesn't read as a standalone service (avoids "what does this do without the
  Mac?" rejections under Guideline 2.1 — the cloud-demo path is the answer).
- Keep install commands (`brew install oratis/tap/lisa`, `npm install -g
  @oratis/lisa`) consistent with `Sources/Onboarding/OnboardingModel.swift` and
  the README.

## App Review Information → "Notes" (paste this, every submission)

Keep this in sync with `Sources/AIDisclosure.swift` — if the copy there changes,
change it here too.

```
THIRD-PARTY AI PROCESSING (Guidelines 5.1.1(i) / 5.1.2(i))

Lisa Pocket sends user content to a third-party AI service, and discloses it
in the app before anything is sent.

What is sent: the messages the user types and anything attached to them; the
earlier messages of that conversation; notes Lisa has saved for that user when
relevant to the request; and the output of any tool run to answer it. Not sent:
contacts, photo library, calendar, location, health data, or any device or
advertising identifier. The app contains no analytics, advertising or tracking
SDK.

Who receives it: in the hosted "LISA Cloud" mode used for this review, the
message goes to our server (Google Cloud, us-central1) and is forwarded, on our
own account, to the AI provider that deployment is configured with — currently
Zhipu AI (GLM), model glm-4.6, endpoint open.bigmodel.cn, processed in China.
The app reads the current provider from the server and shows the company name,
model, endpoint, processing region and a link to that company's privacy policy,
so the disclosure stays accurate if we change providers. In "My Mac" mode the
message goes to the user's own Mac and from there to the provider they
configured with their own API key; we never receive it.

Where to see the permission request:
  1. Launch the app, tap "Get started", choose "LISA Cloud" — the next screen
     is the disclosure, and it requires an explicit tap on
     "I agree — send my messages". Nothing has been transmitted before this.
  2. If onboarding is skipped, the same screen appears on the first send; the
     typed message stays on the device until the user agrees.
  3. To re-read or withdraw it: Settings › Privacy ›
     "AI processing & data sharing".
Permission is recorded per backend, so agreeing for a personal Mac does not
authorise the hosted service. With no agreement recorded, the app refuses the
request locally, before opening a connection.

Privacy policy: https://meetlisa.ai/privacy
```
