# LISA v0.27.0 — personal assistant and reliable iOS connections

Lisa Pocket now opens with a cloud sign-in path and an optional Mac connection. Home offers editable prompts for daily planning, writing, and breaking down a goal. Mac-only agent and integration controls explain their requirements in cloud mode.

- Cloud and Mac configurations use separate Keychain credentials. Existing connections migrate, switching resets private view state and widgets, and failed secure storage does not report a saved connection.
- Chat identifies configured AI recipients and asks for consent before sending. The server's public auth configuration provides recipient names without exposing credentials or URL query strings. The updated mobile app requires this disclosure response; update the connected server before using chat.
- New StoreKit purchases bind to a LISA account, preventing a mode/account switch from crediting the wrong account. Pending purchases are retried after cloud sign-in, and receipts are not forwarded to the paired Mac. Legacy receipts remain supported by existing deduplication.
- Cloud sign-in requires HTTPS. Local network pairing stays available. Cloud and Mac histories remain separate; automatic memory sync is not part of this release.
- English and Chinese privacy pages describe cloud processing accurately, with dedicated support pages and revised store/review copy.
- The missing-agent regression test now isolates PATH instead of accidentally launching a real installed Codex.

Research and acceptance tracking: [Muse research](RESEARCH_MUSE_2026-09-27.md), [implementation plan](PLAN_PERSONAL_ASSISTANT_2026-09-27.md).

App Store availability requires a separate Apple review. A package release or TestFlight upload does not establish approval. Hosted email/integration/push capabilities remain constrained by the server's tenant boundaries.
