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
Lisa Pocket is a client, not a service. Pairing is QR-based and every connection
is gated by a per-device token you can revoke. Nothing is collected to a
Lisa-operated server; the app stores no account.

GETTING STARTED
You'll need LISA running on a Mac (free and open source — install with Homebrew,
npm, or the Mac app). The in-app setup walks you through installing it, starting
it reachably, and scanning the pairing QR. No Mac yet? Point the app at a LISA
Cloud URL instead.

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
- **App Privacy** answer must be **"Data Not Collected"** to match
  `Sources/PrivacyInfo.xcprivacy` — see [`RELEASE.md`](RELEASE.md) §"From
  TestFlight to App Store".
- **App Review Information** → sign-in / demo notes are already drafted in
  [`RELEASE.md`](RELEASE.md) §"App Review notes" (point the reviewer at the LISA
  Cloud demo so they need no Mac).
- The description deliberately frames the app as a **companion/client** so it
  doesn't read as a standalone service (avoids "what does this do without the
  Mac?" rejections under Guideline 2.1 — the cloud-demo path is the answer).
- Keep install commands (`brew install oratis/tap/lisa`, `npm install -g
  @oratis/lisa`) consistent with `Sources/Onboarding/OnboardingModel.swift` and
  the README.
</content>
</invoke>
