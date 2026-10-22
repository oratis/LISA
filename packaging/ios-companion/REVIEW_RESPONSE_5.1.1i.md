# App Review response — Guidelines 5.1.1(i) + 5.1.2(i) (Lisa Pocket)

**Rejection** (Submission `1f0010d4-7318-44c7-b292-90ac1d8eb248`, reviewed
**2026-09-11** on an iPhone 17 Pro Max, v**1.2** build `1788854713`):

> The app appears to share the user's personal data with a third-party AI
> service but the app does not clearly explain what data is sent, identify who
> the data is sent to, and ask the user's permission before sharing the data.

The three credit IAPs came back "Rejected" only as collateral ("returned because
the associated app was rejected") — same as the 2.1(b) round, nothing is wrong
with them.

This is **not** an information request like
[`REVIEW_RESPONSE_2.1b.md`](REVIEW_RESPONSE_2.1b.md). Apple asked for a **code
change**, and says so explicitly: *"only including this information in the app's
Terms of Service or Privacy Policy is not sufficient."* A reply alone cannot
clear it.

## What actually triggered it

The reviewer is right, and it was not a near-miss. Verified 2026-09-22:

| Requirement | v1.2 (rejected) |
|---|---|
| Disclose what data is sent | **Nothing in the app.** `grep -i "third.party\|AI provider"` over `Sources/` returned zero hits. |
| Identify who receives it | **Nothing.** The name of the receiving company appeared nowhere in the binary. |
| Ask permission before sending | **No.** The composer's send button called `chatStream` directly. |
| Privacy policy covers it | Partly — meetlisa.ai/privacy did list "Zhipu/GLM" among sub-processors, but with no equal-protection statement, and a policy alone is not sufficient. |

And the data really does go to a third party. The reviewer signs into **LISA
Cloud**, which is what `deploy/deploy.sh` puts on Cloud Run. Its live
configuration (`gcloud run services describe lisa-cloud`) is:

```
LISA_MODEL = glm-4.6        ZHIPU_API_KEY = <set>
```

So every word the reviewer typed was forwarded to **Zhipu AI, `open.bigmodel.cn`,
processed in China**, with no notice of any kind. That is exactly the shape of
5.1.1(i) that reviewers are instructed to stop.

Worse, `Sources/PrivacyInfo.xcprivacy` *asserted the opposite* — its comment read
"no tracking, **no third parties**" and it declared only Email + User ID. If the
reviewer read the manifest, the app contradicted itself.

## Fixed in the next build

### 1. An in-app disclosure that names the real recipient

`Sources/AIDisclosure.swift` (pure, unit-tested) + `Sources/AIConsentView.swift`
render the four things Apple asks for: **what** is sent (messages, the
conversation so far, Lisa's memory, tool results), **what never is** (contacts,
photos, calendar, location, health, device/ad identifiers), **who** receives it,
and a link to that company's own privacy policy plus ours.

The recipient is **not hardcoded**. The backend serves it from
`GET /api/ai/disclosure` (`src/providers/disclosure.ts`), derived from the live
model by mirroring `resolveProvider()` branch for branch — so it names
`Zhipu AI (GLM) · glm-4.6 · open.bigmodel.cn · processed in China` today, and
follows a provider swap on the server without an app update. The route is
unauthenticated on purpose: the consent screen must be readable *before*
sign-in. A backend too old to have the route makes the app say "this server did
not report which AI company it uses" — it never guesses a name.

### 2. Permission is asked before anything is sent — and enforced in the transport

Two layers, deliberately:

- **UI.** The disclosure is a step in first-run onboarding (right after the user
  picks LISA Cloud or their own Mac, before either is configured), and the
  composer, the quick-reply chips, the retry button and the "delegate a task"
  sheet all route through one gate that presents the same screen if consent is
  missing. Declining leaves the typed message in the box, unsent.
- **Transport.** `AIConsentGate` in `Sources/LisaClient.swift` fails
  `chatStream`, `managedStart`, `managedSend`, `ptyStart`, `ptySend` and `adopt`
  with `LisaError.aiConsentRequired` before a socket is opened. A screen added
  later that forgets to ask still cannot send. This is what makes "the app
  cannot transmit without permission" a property of the build rather than a
  promise about its buttons.

Consent is recorded **per destination** (`mac:<host>` / `cloud:<host>`), so
agreeing to send to your own Mac never silently authorises LISA Cloud, and
re-pairing to a different backend asks again. A `currentVersion` on the record
lets a future change to the disclosure re-ask everyone.

### 3. Withdrawable, and always re-readable

*Settings › Privacy › AI processing & data sharing* shows the same disclosure
with the current state ("Agreed" / "Not agreed — nothing is sent") and a
**Withdraw permission** button that closes the gate immediately.

### 4. The privacy manifest now tells the truth

`Sources/PrivacyInfo.xcprivacy` adds `NSPrivacyCollectedDataTypeOtherUserContent`
(linked, App Functionality, no tracking) and the comment no longer claims "no
third parties". **The ASC App Privacy answers must be updated to match** — see
the checklist.

### 5. The privacy policy states the sharing and the protection

meetlisa.ai/privacy (+ the zh-CN page) gains a "Third-party AI processing"
section naming what is sent, the recipient for each mode, and the
equal-protection commitment Apple's text asks for. It is not a substitute for
the in-app screen — both now exist.

## ✅ Paste-ready reply (App Store Connect → the message → Reply)

```
Re: Submission ID 1f0010d4-7318-44c7-b292-90ac1d8eb248 — Guidelines 5.1.1(i)
and 5.1.2(i)

Hello, and thank you for the review.

You are correct, and we have fixed it in the build attached to this version.
Lisa Pocket does send user content to a third-party AI service, and the
previous build disclosed neither that fact nor the recipient, and did not ask
permission first. Here is what the app does now.

WHAT DATA IS SENT
The messages the user types and anything attached to them; the earlier
messages of that conversation; the notes Lisa has saved for that user when
they relate to the request; and the output of any tool run to answer it.
Nothing else: no contacts, photo library, calendar, location or health data,
and no device or advertising identifiers. The app contains no analytics,
advertising or tracking SDK.

WHO IT IS SENT TO
For the hosted "LISA Cloud" mode the reviewer uses, the message goes to our
server (Google Cloud, us-central1) and is forwarded, using our own account, to
the AI provider that instance is configured with. Today that is Zhipu AI
(GLM), model glm-4.6, endpoint open.bigmodel.cn, processed in China. The app
does not hard-code this: it reads the current provider from the server and
displays the company name, model, endpoint, processing region and a link to
that company's privacy policy. For the "My Mac" mode, the message goes to the
user's own Mac and from there to whichever provider the user configured with
their own API key; we never receive it.

HOW PERMISSION IS OBTAINED, AND WHERE TO SEE IT
  1. Launch the app. Tap "Get started", then choose "LISA Cloud".
  2. The next screen is the disclosure described above. It requires an
     explicit tap on "I agree — send my messages". Nothing has been
     transmitted at this point, and "Not now" continues setup with sending
     still blocked.
  3. If the user skipped onboarding, the same screen appears the first time
     they press send — the typed message is held on the device and is only
     transmitted after they agree. Declining leaves it in the text box.
  4. The disclosure is re-readable at any time, and the permission can be
     withdrawn, at Settings › Privacy › "AI processing & data sharing".
Permission is recorded per backend, so agreeing to use a personal Mac does not
authorise the hosted service, or vice versa.

The refusal is enforced in our network layer, not only in the interface: with
no agreement recorded, the request is rejected locally before any connection
is opened.

PRIVACY POLICY
https://meetlisa.ai/privacy now identifies what we collect, how, every use of
it, the AI provider we share it with, and states that we only use providers
whose terms require protections equivalent to our own policy — to process the
data solely to generate the reply, and not to sell, disclose or use it for
advertising. We have also corrected the app's privacy manifest and our App
Privacy answers to declare that user content is collected for app
functionality.

We are happy to provide a screen recording of the flow above if that is
useful.

Thank you for your time.
Best regards,
<your name>
```

> Replace `<your name>`.

## Before you resubmit — the parts that are not in the app binary

- [ ] **Deploy the backend.** `GET /api/ai/disclosure` ships in this change; the
      currently-deployed `lisa-cloud` revision does not have it, and against an
      old revision the consent screen reads "this server did not report which AI
      company it uses" — technically honest, but it throws away the strongest
      part of the answer. `deploy/deploy.sh` (remember `LISA_PUBLIC_ORIGIN`).
      Verify with:
      `curl -s https://cloud.meetlisa.ai/api/ai/disclosure`
- [ ] **Update ASC → App Privacy** to declare **User Content** (App
      Functionality, linked to the user, not used for tracking) alongside Email
      Address and User ID. The manifest and the ASC answers disagreeing is its
      own rejection.
- [ ] **Publish the website** so meetlisa.ai/privacy carries the new section
      before the reviewer opens it.
- [ ] **Verify each provider's terms actually support the equal-protection
      sentence** the policy now makes. It is a factual claim about Zhipu AI's
      commitments; check their terms (or sign a DPA) before publishing, and
      soften the wording if they do not support it.
- [ ] **Answer in App Review Information** — see `APPSTORE_METADATA.md`, which
      now carries the disclosure text to paste there.
- [ ] Upload a new build under the **existing 1.2** version rather than creating
      a new one, and remember the three IAPs must be re-attached as
      `inAppPurchaseVersion` items or they are silently dropped from the review.

## Worth deciding before the next round

The reviewer-facing cloud runs on **glm-4.6 (Zhipu, China)**. The disclosure is
now accurate and compliant, but "US App Store app forwards everything you type
to a provider in China" is a sentence a reviewer reads twice, and it is the
recurring risk in this app's review history. `deploy/deploy.sh` already accepts
`ANTHROPIC_API_KEY` (and there is an Anthropic relay in front of
api.anthropic.com), so pointing the review-facing deployment at Claude is a
one-variable change that makes the same screen say "Anthropic PBC ·
api.anthropic.com · processed in the United States". Worth weighing against the
inference cost — the code is indifferent either way.
