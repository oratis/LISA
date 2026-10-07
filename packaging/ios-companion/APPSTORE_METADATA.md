# Lisa Pocket — App Store metadata (2026-10-07)

This replaces the obsolete “thin client / collects nothing” listing. Bundle ID stays `ai.meetlisa.main`. The independent LISA brand belongs to the open-source project at https://github.com/oratis/LISA; no affiliation with Meta Muse or other similarly named apps is claimed.

| Field | Value |
| --- | --- |
| Name | Lisa Pocket |
| Subtitle | Your personal AI assistant |
| Promotional text | Plan your day, draft a message, and work through ideas with Lisa. Sign in to LISA Cloud or connect your own Mac, with separate saved connections. |
| Keywords | assistant,productivity,planning,writing,ideas,chat,personal,Mac,open-source |
| Support | https://meetlisa.ai/support |
| Privacy | https://meetlisa.ai/privacy |
| Marketing | https://meetlisa.ai/ |
| Primary category | Productivity |

## Description

Lisa Pocket is the mobile app for LISA, an independent, open-source personal AI assistant.

MAKE A START
Plan your day, write a first draft, or turn an idea into manageable next steps. Suggested starting points open editable messages so you decide what to send. Chat with Lisa, see tool activity, and retry or stop a response.

LISA CLOUD
Sign in with your LISA account and use the assistant without setting up a Mac or an AI API key. Available sign-in options include Apple, Google and email. AI use is subject to your account allowance; optional consumable credit packs are available in Settings.

CONNECT YOUR MAC
Pair your own Mac running LISA to chat with that instance and manage its coding agents. Local integrations, agent controls, activity notifications, widgets and Live Activities depend on your Mac configuration and permissions. Your Mac needs to be reachable over your network or tailnet.

TWO SAVED CONNECTIONS
Switch between Cloud and My Mac without re-entering the other connection. Each instance has its own conversations and assistant data; switching does not automatically copy them.

YOUR DATA AND CHOICES
Before sending a chat message, the app explains which configured AI services can process your message and relevant context and asks for permission. Cancel keeps your draft unsent. Withdraw AI consent in Settings to stop an active chat and require permission again. Local mode may also use a remote AI provider, depending on your setup. Read the privacy policy, unpair your Mac, or delete your cloud account from Settings. For adults 18 and older. AI can make mistakes; review important results.

Learn more at meetlisa.ai.

## Review notes

1. Launch → Continue with LISA Cloud. Expand “Use a password instead” for the existing demo credentials in App Review Information. No Mac, QR code, emailed OTP, or purchase is required to review cloud chat.
2. Open Chat, enter a message, tap Send. The AI data sharing sheet lists the data (message, relevant history, assistant memory, tool results) and actual recipients (currently Google Gemini in cloud mode). Check the AI data-sharing permission and 18-or-older confirmations, then choose Allow AI sharing and send. Cancel sends no message and keeps the draft. Settings → AI data sharing → Withdraw AI consent stops an active chat and requires permission for the next message. The privacy policy identifies paid Gemini processing, equal-protection requirements, retention and deletion.
3. Home offers editable daily-planning, writing and goal-planning starters. Settings shows which connection is active.
4. To inspect in-app purchases, open Settings → LISA account → Add credits. Starter, Plus and Max packs are consumable credits. This entry does not depend on the allowance request succeeding. Refresh credit balance reads the remaining balance from the LISA account without Apple authentication. Unused credits remain with that account across devices/reinstalls; spent consumables are not restored. Unfinished verified transactions reconcile automatically. The review account must be sandbox-allowlisted on the backend before submission.
5. Account deletion: Settings → LISA account → Delete account → Delete account and data. Successful deletion removes the cloud account and its data and signs out. Apple authorization is revoked when a saved authorization token is available; earlier Apple sign-ins display the official manual unlinking instructions after Lisa data is deleted. A failed cleanup remains retryable. Mac unpairing is separate.
6. My Mac features require the user's own reachable Mac. In cloud mode this tab explains the optional setup; it does not attempt unsupported host-control APIs.

## Submission gates

- ASC App Privacy now covers Email Address, User ID, Purchase History, Emails or Text Messages, Other User Content, Other Usage Data, and Other Diagnostic Data. All are linked, used for app functionality, and not used for tracking; the two content categories also support product personalization (assistant memory). The manifest uses the same categories. The binary manifest alone does not change ASC disclosures.
- Age rating override: 18+ (17+ for OS versions before 26, as mapped by Apple). The app requires adult confirmation before AI chat. General writing can occasionally involve mature language/themes, horror, substance references, fictional/realistic conflict or weapons; lifestyle suggestions are declared. There is no social feed, user-to-user chat, advertising, gambling, or explicit-content feature.
- Replace screenshots with the current UI on iPhone and iPad.
- Verify the real review account, StoreKit products, sandbox credit delivery and the live support/privacy pages. Do not place credentials in Git.
- The September 11 review of 1.2 (1788854713) cited 5.1.1(i) and 5.1.2(i): clear AI data/recipient disclosure, prior permission and equal third-party privacy protection. Three IAPs were returned with the rejected app, with no independent purchase defect stated. See [remediation evidence](../../docs/REVIEW_REMEDIATION_2026-09-28.md).

The additional account-lifecycle and StoreKit audit is tracked in [self-audit evidence](../../docs/REVIEW_SELF_AUDIT_2026-09-28.md). Do not claim a real sandbox transaction passed until the payment and server credit have been observed.

October 5 rejected build 1790567703 under 3.1.1 and 5.1.1/5.1.2. The next binary removes Apple consumable restore and strengthens explicit AI consent. See [current remediation](../../docs/REVIEW_2026-10-07.md) for verified status; these notes do not mean a new binary has been submitted.
