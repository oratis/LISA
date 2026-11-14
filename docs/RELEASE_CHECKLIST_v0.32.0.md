# v0.32.0 release checklist

Updated November 14, 2026. Source baseline: `70fb2cb1` (PR #508 merged), following v0.31.0. This checklist separates implemented work, verified behavior and channel publication; an unchecked item is not a passing result.

## Three-phase scope

- [x] Host timelines, recovery/approval fixes and cursor catch-up (#473, #498).
- [x] Explicit read-only Pocket task sharing and reconnect catch-up (#504).
- [x] Isolated worktrees, per-turn checkpoints, bounded diff viewing and cleanup (#505).
- [x] Effective capabilities and previewed Claude/Codex handoffs (#508).
- [x] Preserve the merged Pocket Room/iPad refresh and structured-error handling (#509, #508).
- [x] Restore v0.30.2 release notes, document all changes since v0.31.0, update both READMEs and correct stale publishing instructions.

## Validation

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
- [ ] Independent remote-Mac acceptance from the original Fleet release plan. Multiple local backend processes do not replace a second physical Mac.
- [ ] Physical iPhone Wi-Fi → cellular → Wi-Fi, Mac sleep/wake and firewall-denial acceptance. The available iPhone was reported unavailable; simulator tests do not replace this.
- [ ] Feishu real-account OAuth callback and selected document read. Automated coverage is available; the last documented live attempt did not acquire credentials.

## Publication

- [ ] Release PR reviewed, CI passed and merged.
- [ ] v0.32.0 tag points at the reviewed merge commit.
- [ ] GitHub artifacts/checksums and npm publication verified.
- [ ] Signed/notarized Mac DMG verified.
- [ ] Homebrew formula updated from the published npm tarball.
- [ ] Cloud Run backend and relay published and smoke-tested, with existing deployment configuration retained.
- [ ] Website rebuilt after the GitHub release exists, deployed and checked.
- [ ] Pocket 1.4 uploaded and processed in TestFlight.
- [ ] Pocket App Store submission/approval, if selected for this release. Public version at the audit was 1.3, released November 7, 2026.

## Separate follow-up proposals

These were explicitly deferred by the three-phase design and are not represented as complete: Pocket multi-Mac profiles and Fleet approval grants; file rollback, auto-merge and automatic worktree removal; cross-task storage quotas and full ledger/receipt cleanup; orphan-process resume; Codex source-project editing/browsing; an optional T3 read-only connector; optional screenshot window/accessibility context. Scope confirmation is pending before expanding this release to include them.
