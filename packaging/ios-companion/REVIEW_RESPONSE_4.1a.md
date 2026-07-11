# App Review response — Guideline 4.1(a) Copycats (Lisa Pocket)

**Rejection** (Submission `cb80235c-cf2f-4245-817c-ba80d9c8929d`, 2026-07-08, v1.0
build 1782924012): *"The metadata appears to contain potentially misleading
references to third-party content … content that resembles Lisa.ai without the
necessary authorization."*

## What actually triggered it

Not a code issue — **metadata**. There are several pre-existing AI apps that
share the common name "Lisa" (e.g. *Lisa Chat: AI Bot Assistant* `id6448847169`,
*Lisa AI: Dance Video Maker* `id6443832829`, `lisaai.app`). The reviewer sees a
new AI app named **"Lisa Pocket"** and flags it as resembling **"Lisa.ai."** The
`lisa.ai` substring the reviewer likely spotted is inside our **own** domain,
**meetlisa.ai**.

## Why we win this (the differentiators — all publicly verifiable)

LISA is **our own original product**, not an impersonation, and is categorically
different from the cloud "Lisa" chatbots:

| | Other "Lisa" apps | **LISA / Lisa Pocket** |
|---|---|---|
| Type | Hosted cloud chatbot / media generator | **Self-hosted, open-source (MIT)** agent on the user's own Mac |
| Ours since | — | Website + **public GitHub (2026-05-02)** + npm (2026-05-13) |
| App role | Standalone service | **Thin companion client** — connects only to the user's machine |
| Brand | — | **meetlisa.ai** (our domain), GitHub `oratis/LISA` |

Evidence links (all public, consistent branding — "An AI agent with a real self"):
- Website: https://meetlisa.ai · Privacy: https://meetlisa.ai/privacy
- Source (public, MIT, since 2026-05-02): https://github.com/oratis/LISA
- Package (public): https://www.npmjs.com/package/@oratis/lisa
- Install: https://github.com/oratis/homebrew-tap

## Recommended path: reply with evidence, keep the name

4.1(a) explicitly offers an "attach documentary evidence of your rights" path.
Reply to the review message (no resubmit needed to send a reply). If Apple
approves, done. If they still insist, fall back to a rename (below).

### ✅ Paste-ready reply (App Store Connect → the review message → Reply)

```
Re: Submission ID cb80235c-cf2f-4245-817c-ba80d9c8929d — Guideline 4.1(a)

Hello, and thank you for reviewing Lisa Pocket.

Lisa Pocket is the official companion app for LISA, our own original,
independently developed product. It is not affiliated with — and contains no
references to or content from — "Lisa.ai" or any other third party. "Lisa" is a
common given name and the name of our own software; any similarity to other apps
that share this common name is coincidental.

Please also note: the string "lisa.ai" in our metadata is part of our own
domain name, meetlisa.ai, which we own and operate. It is not a reference to any
third-party service.

LISA is also meaningfully different from other "Lisa"-named apps: it is a free,
open-source (MIT-licensed), self-hosted AI agent that runs locally on the user's
own Mac. Lisa Pocket is a thin client that connects only to the user's own
machine (or an instance the user chooses) — it is not a standalone cloud chatbot
or media-generation service.

Documentary evidence that this is our own product:
- Official website: https://meetlisa.ai
- Open-source code (public, MIT, first published May 2026):
  https://github.com/oratis/LISA
- Public software package: https://www.npmjs.com/package/@oratis/lisa
- Installation tap: https://github.com/oratis/homebrew-tap

We are the sole developer of both LISA and this app, and we are glad to adjust
any specific element you identify. If a particular word, image, or field is the
concern, please let us know exactly which one and we will revise it right away.

Thank you for your time.
Best regards,
<your name>
```

> Replace `<your name>`. Keep the tone factual and cooperative — the closing
> offer to change a specific element is what usually converts a 4.1(a) hold.

### One thing to check before replying — identity match

Apple may check that the **developer account owns the brand**. The account is
**Telloria / wangharp@gmail.com**; the brand is **meetlisa.ai / oratis**. If
those aren't obviously the same entity to a reviewer, add a line to the reply:
*"I am the sole developer and operator of both the Lisa Pocket app account and
meetlisa.ai / the oratis GitHub organization."*  (Optional booster: add an
"iOS companion app" mention/link on meetlisa.ai so the marketing URL itself
ties the app to the brand.)

## Fallback (only if Apple rejects the appeal): differentiate the name

Display name is metadata-only — the bundle id `ai.meetlisa.main` stays. Ranked:

1. **`LISA — Agent Console`** (or `Lisa Agent Console`) — names the true category
   (dev/agent tool), clearly not a generic "Lisa AI" chatbot. Strongest signal.
2. **`meetlisa`** — matches the domain exactly; unmistakably our brand.
3. **`LISA Pocket`** (all-caps LISA) — smallest change; weakest differentiation.

If we rename, also drop the generic keyword **`assistant`** (it's what the cloud
"Lisa" chatbots rank on) and lead the subtitle with the self-hosted angle, e.g.
`Self-hosted AI agent, on the go`.

## Not the trigger, but worth knowing

Keywords/description name **Claude, Codex, Aider** (real integrations). Factual
interoperability references are generally fine; the reviewer flagged "Lisa.ai,"
not these. Leave them unless a future reviewer objects.
