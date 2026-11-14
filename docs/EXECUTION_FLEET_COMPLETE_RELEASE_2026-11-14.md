# Fleet completion and coordinated release

The owner confirmed on November 14, 2026 that this release includes the follow-up proposals, not only the first three phases, and that Pocket should proceed through App Store submission. Baseline: `01563b84` (release preparation #510). No published tag will be moved; 0.32.0 remains a candidate until implementation and acceptance finish.

## Implementation and regression checklist

- [x] Pocket: multiple saved Macs, explicit switching, per-profile credentials, account isolation and safe migration; show shared task entry points from Room.
- [x] Pocket: separately granted Fleet approval authority with exact-request binding, expiry and server-side revalidation; read-only shares stay read-only.
- [ ] Checkpoints: preview and restore selected files with concurrent-edit protection.
- [ ] Worktrees: preview/confirm automatic merge into the source branch, refuse conflicts or changed source state, optionally clean up owned worktrees safely.
- [ ] Storage: cross-task checkpoint quotas, retention controls and complete content/receipt cleanup with an explicit operation generation so old retries cannot restart deleted tasks.
- [ ] Recovery: explicit continuation from saved task context after the previous process has been verified stopped; never silently replay uncertain tool calls.
- [ ] Codex: scoped workspace browsing/editing and fresh approval requests, preserving the existing packet-only review option.
- [ ] T3: authenticated read-only project/thread-list connector, exact selected-project scoping, pagination, cancellation and revocation.
- [ ] Screenshots: opt-in window/accessibility context in the attachment preview, with useful fallback when permission is absent or the user excludes text.
- [ ] Update API contracts, Web/Pocket/Mac UI, translations, guides, README and release notes to match implemented behavior.

## Acceptance and publication

- [ ] Run targeted regressions for each change, then full Node/native/browser/relay checks and independent review of the final diff.
- [ ] Physical iPhone network handoff, Mac sleep/wake/firewall and independent remote-Mac Fleet acceptance. The owner is connecting devices; the first refreshed inventory still reported the iPhone unavailable.
- [ ] Feishu real-account authorization and selected-document read; live T3 authorization for its new connector.
- [ ] Verify live provider paths and production relay after deployment.
- [ ] Merge reviewed PRs; tag the reviewed release commit; publish GitHub/npm/notarized Mac/Homebrew/backend/relay/website, verifying each channel.
- [ ] Build Pocket, verify current screenshots/privacy/review login and StoreKit, upload/process TestFlight, attach the build and submit to App Store review. Submission is distinct from Apple's approval.

## Implementation decisions

New destructive product actions require a user-visible preview and explicit confirmation at runtime. The task owner has authorized implementing and publishing these controls; this is not an additional development approval gate. Restoration and merging must refuse changed files/source branches and must never erase unrelated working changes. Cleanup must not weaken idempotency or silently restore an old pairing's authority.

## Implementation evidence: Pocket slice

- Eight multi-Mac regressions cover upgrade, account/origin isolation, independent credentials, locked Keychain migration, failed writes, removal and capacity.
- Five native approval regressions cover capability/preview/expiry, exact receipt retries, unknown outcomes, stale previews and navigation races.
- iPhone simulator: 145 logic tests, one existing opt-in production-relay skip, zero failures; three UI tests passed. Logs: `/private/tmp/lisa-complete-pocket-final2.log`.
- Fleet service and encrypted Pocket → LAN/cloud → Mac integration: nine tests passed, including a real isolated file edit through Pocket approval and receipt retrieval over a different transport. The broader Fleet/host suite previously passed 60 tests with one native-Codex opt-in skip; final full-suite verification remains scheduled after all extensions.
- Browser: 11 Fleet regressions passed, including separate approval opt-in, cancellation and revocation. API/server/client/E2E type checks passed; lint has zero errors and 72 existing warnings.
- Physical acceptance remains open: Xcode reports the iPhone offline and USB inventory does not show it; the account lists only `OratisdeMacBook-Pro.local`. This is not physical-device validation.
