# Fleet completion and coordinated release

The owner confirmed on November 14, 2026 that this release includes the follow-up proposals, not only the first three phases, and that Pocket should proceed through App Store submission. Baseline: `01563b84` (release preparation #510). No published tag will be moved; 0.32.0 remains a candidate until implementation and acceptance finish.

## Implementation and regression checklist

- [x] Pocket: multiple saved Macs, explicit switching, per-profile credentials, account isolation and safe migration; show shared task entry points from Room.
- [x] Pocket: separately granted Fleet approval authority with exact-request binding, expiry and server-side revalidation; read-only shares stay read-only.
- [x] Checkpoints: preview and restore selected files with concurrent-edit protection.
- [x] Worktrees: preview/confirm automatic merge into the source branch, refuse conflicts or changed source state, optionally clean up owned worktrees safely.
- [x] Storage: cross-task checkpoint quotas, retention controls and complete content/receipt cleanup with an explicit operation generation so old retries cannot restart deleted tasks.
- [x] Recovery: explicit continuation from saved task context after the previous process has been verified stopped; never silently replay uncertain tool calls.
- [x] Codex: scoped workspace browsing/editing and fresh approval requests, preserving the existing packet-only review option.
- [x] T3: authenticated read-only project/thread-list connector, exact selected-project scoping, pagination, cancellation, local disconnect and upstream revocation detection.
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

## Implementation evidence: selected-file restore

- Restore previews bind the selected turn/file, current bytes/inode/permissions/parent identity, snapshot and expiry. Only idle hosts and finished tasks are eligible; the initiating controller must still hold control and workspace access.
- Restore changes one regular file, supports deletion/recreation, leaves the index/source checkout untouched and rejects links. The receipt is stored before filesystem I/O; partial/I/O failure stays unknown and is not replayed.
- Ten checkpoint tests passed, including content/inode races, grants, expiry, links, deletion/recreation, index preservation and unknown-receipt retry. Thirteen browser regressions passed, including explicit confirmation and a late preview after switching Macs. Logs: `/private/tmp/lisa-complete-restore.log`, `/private/tmp/lisa-complete-restore-browser.log`.

- Combined Fleet/host suite after restore: 64 passed, zero skips, including the installed native Codex fixture. Log: `/private/tmp/lisa-complete-fleet-all.log`.

## Implementation evidence: storage and full cleanup

- Default 512 MiB across checkpoint repositories; owner-configurable quota and optional retention. New snapshots that exceed quota are discarded while older refs and the running agent remain intact. A minute maintenance pass removes only ended-task checkpoints older than the configured interval.
- Full cleanup requires an idle host and a signed preview bound to the database revision. It rotates the operation generation before deleting task contents, shares and all receipts, removes snapshots, then securely deletes/compacts SQLite and truncates WAL. Workspace registrations/files and pairings remain.
- Regression verifies cleanup leaves no sentinel task content in SQLite/WAL, old retries are rejected even after restart, explicit new-generation tasks work, active snapshots survive retention, and quota applies across multiple tasks.
- Combined Fleet/host suite: 67 passed, zero skips. Browser: 15 passed, including preview/confirmation, emptying old timeline DOM and preserving the old generation on uncertain retries. Types/contracts pass; lint remains zero errors / 72 pre-existing warnings. Logs: `/private/tmp/lisa-complete-storage-all.log`, `/private/tmp/lisa-complete-storage-browser.log`, `/private/tmp/lisa-complete-storage-final.log`.

## Implementation evidence: explicit continuation

- A durable verified-stopped marker is written only after process tracking proves exit/termination or the local owner explicitly verifies it. Ambiguous live/reused processes remain reserved and cannot continue.
- The initiating controller must supply a new instruction and confirm a ten-minute signed preview. A new session receives the original requirement and last stored result excerpt, clearly labeled unverified; no previous approval/tool call or provider state is transferred. The source remains unknown and both tasks receive a linking event.
- Tests cover unverified-process refusal, control revocation, changed instructions/context, restart/expiry invalidation, exact receipt retry, fresh approvals and stale browser previews. Fleet/host: 69 passed, zero skips. Browser: 17 passed. Logs: `/private/tmp/lisa-complete-continuation-all.log`, `/private/tmp/lisa-complete-continuation-browser.log`.

## Implementation evidence: merge and owned cleanup

- Creation provenance binds the original workspace, Git directory, branch and commit. Both workspace grants are rechecked before merging. Immutable snapshot bytes generate the preview and private candidate objects; hooks/filters/signing are disabled, and the original index is never used for preparation.
- Confirmation requires a clean unchanged source and matching worktree/checkpoint. One commit is fast-forwarded; optional cleanup rechecks ownership/content and refuses ignored files. Removed workspaces retain historical diffs and cannot start new tasks.
- Durable unknown receipts and host maintenance reservations prevent duplicate writes across backend instances. Uncertain merge receipts retain the proposed commit for inspection. Only explicit local-owner verification releases uncertain/dead-backend operations; no old operation is retried. Restore and full ledger cleanup use the same reservation.
- Fleet/host: 74 passed, zero skips before the final two fault/restart regressions. Final checkpoint suite: 20 passed, including a human edit during merge preserving the worktree even after the source commit succeeded. Browser: 19 passed, including cleanup selection invalidating previews and late Mac-switch responses. Type checks/contracts pass; lint has zero errors / 72 existing warnings. Logs: `/private/tmp/lisa-complete-merge-all.log`, `/private/tmp/lisa-complete-merge-final.log`, `/private/tmp/lisa-complete-merge-browser.log`, `/private/tmp/lisa-complete-merge-static.log`.

## Implementation evidence: Codex workspace mode

- `codex-workspace` is separate from existing `codex` packet review. Native app-server starts an ephemeral thread in empty Seatbelt-protected scratch; only Fleet-mediated List/Read/Edit/Write reaches the selected project, each through a fresh five-minute approval. Follow-up turns and cancellation use the existing durable task receipts.
- Tools reject escapes/dot paths/links/hardlinks/special files, require existing parents, bound text/payload/directory size, bind file/directory identity and content, and consume the operation before I/O. Partial writes cannot replay. Expired/invalid/withdrawn approvals do not authorize later calls.
- The installed native Codex fixture completed Read → Edit → denied Write → rejected traversal, followed by a directory listing through its actual code-mode tool entry and a rejected native patch against the source. Tests now inspect both legacy tool arrays and modern `additional_tools` messages; the original packet-review fixture also remains green. This is native-protocol acceptance against a local Responses fixture, not live OpenAI inference.
- Fleet/host: 82 passed, zero skips. Browser: 20 passed. Types/contracts and scoped lint pass. Logs: `/private/tmp/lisa-complete-codex-all.log`, `/private/tmp/lisa-complete-codex-browser.log`, `/private/tmp/lisa-complete-codex-final-static.log`.

## Implementation evidence: T3 selected-project reader

- Reviewed against T3 commit `e89abadaee70e0d73fb19a5ce40a686b1a92310e`. OAuth uses dynamic registration, PKCE and issuer/state-bound loopback callback; only exact `orchestration:read` grants are accepted. The configured environment is bound to the grant, and identity/scope are rechecked before and after buffered reads.
- Only `t3_project_list` and explicitly selected-project `t3_thread_list` are callable. No thread contents, linked environments, links, source files or writes are exposed. Metadata is projected, bounded and paginated. Public HTTPS is DNS-pinned; explicitly configured HTTP loopback is pinned without DNS and rejects redirects.
- T3 does not expose refresh or self-revocation for this grant. Local disconnect deletes credentials and cancels pending work; users revoke the upstream session in T3 Settings → Sharing & access. Revoked/expired upstream grants fail closed.
- Seven T3 protocol/lifecycle/transport regressions pass, including revocation during a buffered read and disconnect during an in-flight continuation. Two browser regressions cover callback, project selection, original-task resumption exactly once, reuse, disconnect and cancellation. Shared MCP/API/type checks pass. Logs: `/private/tmp/lisa-complete-t3-tests.log`, `/private/tmp/lisa-complete-t3-service.log`, `/private/tmp/lisa-complete-t3-browser.log`.
- These use deterministic protocol fixtures. Real-account authorization remains an explicit acceptance item; no T3 environment URL has been supplied yet.
