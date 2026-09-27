# Lisa Pocket — App Store metadata (2026-09-27)

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
Before sending a chat message, the app explains which configured AI services can process your message and relevant context and asks for permission. Local mode may also use a remote AI provider, depending on your setup. Read the privacy policy, unpair your Mac, or delete your cloud account from Settings. AI can make mistakes; review important results.

Learn more at meetlisa.ai.

## Review notes

1. Launch → Continue with LISA Cloud. Expand “Use a password instead” for the existing demo credentials in App Review Information. No Mac, QR code, emailed OTP, or purchase is required to review cloud chat.
2. Open Chat, enter a message, tap Send. Review the configured AI recipients and choose Allow and send this message. Cancel sends no message.
3. Home offers editable daily-planning, writing and goal-planning starters. Settings shows which connection is active.
4. To inspect in-app purchases, open Settings → LISA account → Add credits. Starter, Plus and Max packs are consumable credits. This entry does not depend on the allowance request succeeding. The review account must be sandbox-allowlisted on the backend before submission.
5. Account deletion: Settings → LISA account → Delete account → Delete account and data. Mac unpairing is separate.
6. My Mac features require the user's own reachable Mac. In cloud mode this tab explains the optional setup; it does not attempt unsupported host-control APIs.

## Submission gates

- Update ASC App Privacy to cover Email Address, User ID, user content (chat/assistant memory), purchases, and product interaction used for usage metering, linked to the account for app functionality; no tracking. The binary manifest alone does not change ASC disclosures. Verify the precise content category against the ASC questionnaire.
- Answer the current age-rating questions from the actual AI/chat and web-tool capabilities; do not reuse the old assumed 4+ answer.
- Replace screenshots with the current UI on iPhone and iPad.
- Verify the real review account, StoreKit products, sandbox credit delivery and the live support/privacy pages. Do not place credentials in Git.
- Record the current rejection reason and address it explicitly; historical 2.1(b)/4.1(a) notes are not proof of the latest reason.
