# App Review response — Guideline 2.1(b) "cannot locate the In-App Purchases" (Lisa Pocket)

**Rejection** (Submission `2c1916e0-9ff9-4507-a295-855ef47ba81a`, submitted
2026-08-02, reviewed **2026-08-04** on an **iPad Air 11-inch (M3)**, v1.1 build
`1784948923`). ASC shows the version under *2.1.0 Performance: App Completeness*;
the message body is **Guideline 2.1(b) – Information Needed**:

> We have started the review of the app, but we are not able to continue because
> we cannot locate the In-App Purchases, such as Starter Credits, Plus Credits,
> and Max Credits, within the app at this time.

Apple asks only for **a reply with the steps to find them** — no new binary is
required to answer. The three IAPs show "Rejected / Other" purely as collateral
("returned because the associated app was rejected").

This is **not** the 4.1(a) copycat issue from July (see
[`REVIEW_RESPONSE_4.1a.md`](REVIEW_RESPONSE_4.1a.md)); the name is no longer
being contested.

## What actually triggered it

Not metadata, and not Apple's side. Verified on 2026-09-07:

| Suspected cause | Checked | Verdict |
|---|---|---|
| Product ids don't match | ASC has `ai.meetlisa.main.credits.5` / `.10` / `.20`, Consumable — identical to `CreditsStore.productIDs` | ✅ fine |
| Paid Apps Agreement not accepted (Apple's boilerplate) | ASC → 商务: **Paid Apps 有效** 2026-05-10 → 2027-02-12, bank account active, W-8BEN in use | ✅ fine |
| Demo backend down (the July 2.1 sign-in failure) | `GET https://cloud.meetlisa.ai/health` → `200 {"ok":true}` | ✅ fine |
| iPad-specific layout hides Settings | no `userInterfaceIdiom` / `NavigationSplitView` branch anywhere in `Sources/` | ✅ fine |

**The cause is our own conditional UI.** Before this fix the app had exactly one
route to the packs — Settings → LISA account → "Add credits…" — and that button
was nested *inside* the quota block in `Sources/AccountViews.swift`:

```swift
if let q = quota, q.available, let window = q.windowMicroUSD, window > 0 {
    …allowance / tier / credits rows…
    Button { showPaywall = true } label: { Label("Add credits…", …) }   // ← only here
} else {
    LabeledContent("Plan", value: …)                                    // ← no route at all
}
```

`quota` comes from `try? await app.client.billingQuota()`. A timeout, a 401 on a
session not yet attached, or the server's own 503 `billing_state_unavailable`
all collapse it to `nil` — and then **the app contains no way to reach the
In-App Purchases**, exactly as the reviewer reported. Our own review notes
admitted the flakiness ("If they have not populated yet, switch to another tab
and back to Settings once").

Two amplifiers: `PaywallSheet` showed "Loading packs…" forever, with no error and
no retry, when StoreKit returned an empty product list; and the chat-side 402
message pointed the user at the very Settings row that may not have rendered.

## Fixed in the next build (v1.2)

1. **The purchase entry point is unconditional.** "Add credits…" now renders
   whenever an account is signed in; the allowance/tier/credits rows are the only
   thing the quota fetch can affect. (`Sources/AccountViews.swift`)
2. **A second, independent route.** When a turn is refused for lack of credits
   (HTTP 402), the chat bubble itself offers "Add credits…" and opens the same
   sheet — no Settings trip. (`Sources/ChatView.swift`)
3. **The sheet can no longer look empty.** An empty StoreKit response now counts
   as a failure: the sheet says so and offers "Try again" instead of spinning
   forever. (`Sources/StoreView.swift`)

## Also fixed server-side: the reviewer's sandbox purchase now succeeds

App Review buys in **Apple's sandbox**. The cloud edition rejected every
non-Production StoreKit JWS (B5 anti-minting), so a reviewer who *did* reach the
sheet and bought a pack would have seen
`Couldn't credit the purchase (sandbox_rejected)` — a near-certain 2.1 / 3.1.1
rejection on the next round.

`sandboxCreditAllowed()` (`src/billing/iap.ts`) now allows sandbox transactions
for a **named allowlist** instead of blanket-opening the hole:

```bash
gcloud run services update lisa-cloud --region <region> \
  --update-env-vars LISA_IAP_SANDBOX_ACCOUNTS=reviewer@meetlisa.ai
```

`LISA_IAP_ALLOW_SANDBOX=1` still opens a whole staging deploy; with neither set
the behaviour is unchanged (reject). **Do this before resubmitting**, and drop
the variable once the app is approved.

## ✅ Paste-ready reply (App Store Connect → the message → 回复 App 审核)

```
Re: Submission ID 2c1916e0-9ff9-4507-a295-855ef47ba81a — Guideline 2.1(b)

Hello, and thank you for the review.

Sorry for the trouble locating the three credit packs. They are reached from
the signed-in account screen, and we have confirmed the exact steps below on
build 1.1 (1784948923).

STEPS TO REACH THE IN-APP PURCHASES
  1. Launch the app. On the welcome screen tap "Get started" and choose
     "LISA Cloud" (marked Recommended) — or tap "Not now" at the top right to
     skip onboarding and open the "Settings" tab.
  2. In Settings, make sure the segmented control at the top is set to
     "LISA Cloud". The cloud URL is pre-filled: https://cloud.meetlisa.ai
  3. Tap the row labelled "Use a password instead" — it expands to reveal the
     password field.
  4. Sign in with the email and password in the App Review Information for
     this version, then tap "Sign in".
  5. Settings now shows a "LISA account" section headed
     "Signed in as <the review account>". Inside that section, tap
     "Add credits…".
  6. The purchase sheet ("Add credits") opens and lists all three consumables
     with their prices: Starter Credits, Plus Credits and Max Credits.

WHY YOU MAY NOT HAVE SEEN IT
We found the bug and it is ours. In build 1.1 the "Add credits…" row was drawn
only after a background call to our billing service returned the account's
allowance. If that call timed out or failed, the row was silently omitted and
the app offered no other way to reach the purchases. The next build makes the
"Add credits…" entry unconditional for any signed-in account, adds a second
entry point directly in the chat screen when a session's allowance runs out,
and shows an explicit error with a "Try again" button if the App Store does not
return the products.

The purchases are not restricted by storefront, device or account
configuration. We have also confirmed that our Paid Apps Agreement is active
and that the three products (ai.meetlisa.main.credits.5, .credits.10 and
.credits.20, all Consumable) are the ones submitted with this version.

We are happy to provide a screen recording of the steps above, or to submit the
updated build, whichever you prefer.

Thank you for your time.
Best regards,
<your name>
```

> Replace `<your name>`. If you have already uploaded v1.2, swap the last
> paragraph for "The updated build is attached to this version."

## Before you resubmit — three things

- [ ] `LISA_IAP_SANDBOX_ACCOUNTS=<review account email>` set on the review-facing
      Cloud Run service (see above), so a sandbox purchase actually credits.
- [ ] **社交媒体年龄分级 / social-media age-rating questions** in ASC → App 信息.
      The banner's grace period ends **2026-09-07**, and answering becomes
      mandatory the moment you submit again.
- [ ] Sign in on a real device with the review account and confirm
      Settings → "Add credits…" is present **and** that killing the network
      before opening Settings no longer removes it.

> **Reply vs. resubmit:** 2.1(b) asks for information, so the reply alone is
> what Apple requested. If the submission still reads "问题未解决" a day later,
> use "重新提交至 App 审核" on the submission page — as with the 4.1(a) round, a
> reply on its own did not requeue the review.
