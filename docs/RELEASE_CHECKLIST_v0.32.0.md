# v0.32.0 release checklist

Updated November 17, 2026. Baseline: `01563b84` (PR #510 merged), followed by the complete-extension candidate. This checklist separates implemented work, verified behavior and channel publication; an unchecked item is not a passing result.

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
- [x] Owner accepted the updated local 0.32.0 build on November 17, 2026; PR #516 merged as `30769980`. The final source passed Node 22/24, coverage, 135 browser tests, website, audit and docs CI. Local Node suite: 4,382 passed and two opt-in native Codex skips. Native verification covered 12 stickers, 24 expressions, 22 connector statuses, Rêve, Control and the new seated animation; existing sessions, identity and account connection were preserved.

- [x] Complete-extension PR #511 reviewed locally, CI passed and merged. Devin full review was unavailable (expired credits).
- [x] Knowledge-base Git isolation follow-up PR #512 passed CI/review and merged as `0aadbf40`.
- [x] v0.32.0 tag points at reviewed release-notes merge `47cd9a05` (PR #517), including accepted PR #516. The published tag remains unchanged.
- [x] GitHub artifacts/checksums and npm publication verified; the npm tarball matches the GitHub source artifact and registry integrity. An isolated npm install reports 0.32.0 and passes CLI help.
- [x] Signed/notarized universal Mac DMG verified, including checksum, signature, stapled ticket and Gatekeeper. The final official app replaced the local acceptance candidate after backup; backend 0.32.0, native UI, existing sessions, remote identity and account connection were verified.
- [x] Homebrew formula updated from the published npm tarball; its live URL and SHA-256 match the downloaded package.
- [x] Cloud Run backend and relay published and smoke-tested, with existing deployment configuration retained. Backend `lisa-cloud-v0-32-0` serves 100% of traffic; relay version `1faddc46-b866-4176-bcca-69b3a1db01a4` passed account authentication, encrypted pairing/requests, heartbeat and revocation after backend promotion.
- [x] Website rebuilt after the GitHub release exists, deployed as `lisa-web-v0-32-0-notes` and checked at canary and production URLs. Both languages, changelogs, privacy pages and linked styles passed.
- [x] Pocket 1.4 (1794678341) uploaded successfully through CI on November 15.
- [x] Apple API verified build 1794678341 as `VALID`, `IN_BETA_TESTING` (internal), `READY_FOR_BETA_SUBMISSION` (external).
- [x] Read-only Apple status check on November 17 confirms public Pocket **1.4**, build **1794650503**, is `READY_FOR_DISTRIBUTION`; the public listing records its November 15 release. This was the separate UI-release submission, not a new upload during the Mac release.
- [ ] Complete-extension Pocket build **1794678341** remains in internal TestFlight and is not the public 1.4 build. Its physical-device acceptance and subsequent App Store publication remain separate work; the existing public binary was preserved.

Channel evidence, artifact checksums and retained rollback revisions are recorded in [v0.32.0 publication verification](RELEASE_VERIFICATION_v0.32.0.md).

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
- [x] Final knowledge-base isolation follow-up PR #512 passed CI/review and merged.
- [ ] Real T3 authorization and selected-project read; the environment URL is still needed.
- [ ] Real Box account authorization and file read; a configured Box OAuth application is still needed. Offline consent/read/refresh regressions passed. Obsidian filesystem acceptance used disposable vaults.

Earlier baseline checks above are retained as evidence, not presented as full validation of these new changes. The second-Mac Control workflow is now verified as scoped above. Physical iPhone, remote sleep/wake and outstanding real-account acceptance remain unchecked until actually observed.
