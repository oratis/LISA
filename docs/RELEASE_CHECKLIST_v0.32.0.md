# v0.32.0 release checklist

Updated November 16, 2026. Baseline: `01563b84` (PR #510 merged), followed by the complete-extension candidate. This checklist separates implemented work, verified behavior and channel publication; an unchecked item is not a passing result.

## Three-phase scope

- [x] Host timelines, recovery/approval fixes and cursor catch-up (#473, #498).
- [x] Explicit read-only Pocket task sharing and reconnect catch-up (#504).
- [x] Isolated worktrees, per-turn checkpoints, bounded diff viewing and cleanup (#505).
- [x] Effective capabilities and previewed Claude/Codex handoffs (#508).
- [x] Preserve the merged Pocket Room/iPad refresh and structured-error handling (#509, #508).
- [x] Restore v0.30.2 release notes, document all changes since v0.31.0, update both READMEs and correct stale publishing instructions.

## Baseline validation (before the complete-extension candidate)

- [x] Full Node suite: 4,341 passed, zero skipped/failed, including the installed Codex CLI with a deterministic local Responses fixture. No live paid inference is claimed.
- [x] API contract, server/client/E2E type checks and backend build.
- [x] Fleet Chromium regression suite: 11 passed.
- [x] Documentation/link/format and changelog checks; ESLint has zero errors and 72 existing warnings. Temporary UI/backend fixtures are now excluded from lint.
- [x] iPhone: 132 logic tests (one opt-in production-relay skip), zero failures; 3 keyboard/navigation UI tests passed. The skipped production check was then run separately and passed.
- [x] iPad: 132 logic tests (one opt-in skip), zero failures; all 8 Room UI flows passed against an isolated real backend, including the verified one-time file-edit approval.
- [x] Native Mac: 11 account-flow tests passed; arm64 Lisa.app built with bundled Node 22.23.2/backend 0.32.0. This local build is ad-hoc signed, not the release notarization.
- [x] Current relay Worker type checks, dry-run build and four integration tests passed.
- [x] Latest Pocket source passed signed-simulator URLSession against the deployed production relay: Cloud → LAN → Cloud on blocked LAN → LAN after recovery. Worker version tested: `62681223-d843-4da5-b773-6fe8fff4657a`; verify again after publishing the updated Worker.
- [x] Native Fleet Claude adapter with the configured live provider: Read/Edit requested separate approvals, and the expected disposable-workspace file edit was verified.
- [x] Independent physical-Mac Control lifecycle acceptance on PR #516: production relay, v2 pairing, one-worktree grant, live Claude Read/Edit approvals, actual denied Edit, follow-up, matching file/diff results, receipt recovery without replay, disconnect/reconnect, cancellation and revocation. Original source stayed clean; temporary test instances and credentials were removed. The tested CLI exposed Read/Edit; live remote Codex, new-file Write and physical sleep/wake are not claimed.
- [ ] Physical iPhone Wi-Fi → cellular → Wi-Fi, Mac sleep/wake and firewall-denial acceptance. The available iPhone was reported unavailable; simulator tests do not replace this.
- [ ] Feishu real-account OAuth callback and selected document read. Automated coverage is available; the last documented live attempt did not acquire credentials.

## Publication

- [x] Control integration/localization PR #516 passed Node 22/24, coverage, browser, website, audit and docs CI. Local validation: 4,377 default Node tests plus two opt-in native Codex fixtures; 129 browser tests; 25 final Control/Fleet regressions.
- [x] Local Mac acceptance candidate built as a universal 0.32.0 app and installed over 0.31.0 after backing up the app, user data and previous backend override. All 39 native tests passed; bundled backend health reports 0.32.0, sessions and remote identity are retained, and the existing account connection is online.
- [x] Native-window upgrade verification exposed stale cached Fleet assets. Content-versioned paths fixed the mismatch; 29 server tests and 33 Control/Fleet/mobile browser tests passed, including an installed-app offline-cache regression. The rebuilt app's Control → Remote Macs layout was visually verified in the native window.
- [ ] Owner acceptance of the locally installed 0.32.0 candidate, then merge PR #516 before tagging.

- [x] Complete-extension PR #511 reviewed locally, CI passed and merged. Devin full review was unavailable (expired credits).
- [ ] Final knowledge-base Git isolation follow-up PR CI/review and merge.
- [ ] v0.32.0 tag points at the reviewed merge commit.
- [ ] GitHub artifacts/checksums and npm publication verified.
- [ ] Signed/notarized Mac DMG verified.
- [ ] Homebrew formula updated from the published npm tarball.
- [ ] Cloud Run backend and relay published and smoke-tested, with existing deployment configuration retained.
- [ ] Website rebuilt after the GitHub release exists, deployed and checked.
- [x] Pocket 1.4 (1794678341) uploaded successfully through CI on November 15.
- [x] Apple API verified build 1794678341 as `VALID`, `IN_BETA_TESTING` (internal), `READY_FOR_BETA_SUBMISSION` (external).
- [ ] Pocket App Store submission (explicitly requested); Apple approval remains a separate external outcome. Public version at the audit was 1.3, released November 7, 2026. A separate UI-release task submitted an earlier 1.4 build (1794650503) at November 14 23:39 Asia/Shanghai; it is waiting for review with automatic release after approval. The complete-extension build 1794678341 is not that submission. Preserve the existing review until the owner chooses replacement versus a subsequent version.

## Complete-extension scope and final validation

The owner explicitly included the deferred proposals on November 14. Implementation and slice-level evidence are tracked in the [complete release execution log](EXECUTION_FLEET_COMPLETE_RELEASE_2026-11-14.md).

- [x] Pocket multi-Mac profiles and independent per-task approval grants.
- [x] Selected-file rollback, confirmed source-branch merge and optional owned-worktree removal.
- [x] Cross-task checkpoint quota/retention and full ledger/receipt cleanup.
- [x] New-session continuation after verifying the previous process stopped; no orphan-process reattachment or uncertain tool replay.
- [x] Codex workspace List/Read/Edit/Write with fresh Fleet approvals, alongside existing packet review.
- [x] Authenticated T3 selected-project/thread-list connector with local disconnect and upstream revocation detection.
- [x] Optional screenshot window/accessibility context, previewed and separately selected before Send.
- [x] Final local validation: 4,379 Node tests after the final KB isolation fix, 124 Chromium tests, 145 iPhone logic tests (one existing opt-in relay skip), three iPhone UI tests, 11 Mac tests and four relay tests passed; types/contracts/build/docs/format pass, lint has zero errors / 72 existing warnings. Focused review found and fixed a multi-backend cleanup race with a red-to-green regression.
- [x] Complete-extension candidate CI passed on PR #511.
- [ ] Final knowledge-base isolation follow-up CI/review.
- [ ] Real T3 authorization and selected-project read; the environment URL is still needed.

Earlier baseline checks above are retained as evidence, not presented as full validation of these new changes. The second-Mac Control workflow is now verified as scoped above. Physical iPhone, remote sleep/wake and outstanding real-account acceptance remain unchecked until actually observed.
