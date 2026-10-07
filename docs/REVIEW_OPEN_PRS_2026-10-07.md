# LISA open PR integration and App Store audit — 2026-10-07

LISA is an **AI Personal Assistant** for planning, writing and personal knowledge, with account-based Cloud access and an independently configured Mac instance. Cloud/Mac histories, memory and credentials do not automatically sync. This audit follows [the native remediation and review receipt](REVIEW_2026-10-07.md); it does not replace that historical record.

## Scope and implementation

The original checkout and its untracked work were preserved. A managed worktree was updated from `origin/main`; each of the eight open PRs was examined, individually commented, corrected where necessary, and required to pass fresh applicable CI before merging.

| PR | Review result and corrections | Evidence |
| --- | --- | --- |
| [#379](https://github.com/oratis/LISA/pull/379) | Reviewed Actions v7 compatibility; resolved main integration and release-workflow formatting. | Merged `039d712`; all 10 checks passed, including both native surfaces. |
| [#384](https://github.com/oratis/LISA/pull/384) | IMAP envelope dates can be Date, string or absent. Normalize valid values and use a finite fallback for invalid/missing values; exercise actual connector fetch and lock release. | Merged `83cfca2`; 11 targeted tests and applicable CI passed. |
| [#394](https://github.com/oratis/LISA/pull/394) | Reviewed Astro 7 migration against this static site; aligned Node minimum to 22.19. | Merged `6487d28`; 14-page build and applicable CI passed. |
| [#412](https://github.com/oratis/LISA/pull/412) | Reviewed SDK/minor dependency updates; preserved the October security lockfile fixes rather than downgrading transitive dependencies. | Merged `5a21b85`; 2,521 passed / 1 PTY skip; production audit 0 vulnerabilities; applicable CI passed. |
| [#381](https://github.com/oratis/LISA/pull/381) | Fixed dynamic model/disclosure updates. Removed duplicate health handling and corrected public health runbook path. Firestore registry removal and missing-document pruning could strand cross-process usage writes; retained registration and pending IDs. | Merged `dd58295`; 97 targeted tests, final integration rerun and all 10 CI checks passed. |
| [#404](https://github.com/oratis/LISA/pull/404) | Reviewed SSRF/DNS pinning/redirect/port/tenant limits. Abort before work and after DNS prevents cancelled requests from starting a transport. Added bilingual privacy disclosure for future enabled web tools. | Merged `5335218`; 359 targeted tests, website build and applicable CI passed. |
| [#403](https://github.com/oratis/LISA/pull/403) | Fixed repeat execution of unknown side effects after resume; capped busy tenant cache; resolved runtime-model, CLI, contract and Warden integration; single-flight renewals and draining release fix in-flight lease cleanup. A bounded, referenced test deadline prevents Node 22 from cancelling an assertion that waits on the intentionally unreferenced renewal timer. | Merged `f234bd7`; Node 22/24, coverage, audit, browser E2E and docs passed. Full task-integrated suite: 2,814 passed / 1 PTY skip; Node 22 lease regression: 18/18 passed. |
| [#407](https://github.com/oratis/LISA/pull/407) | Reviewed routing, fallback costs and Gemini gateway. Fixed cumulative usage overcharging and missing final usage undercharging. Preserved nested approval + budget inheritance; removed unsupported hard-ceiling/unknown-price-upper-bound claims. | Standalone 3,122 passed / 1 PTY skip. Combined #403/#407 tree: **3,393 passed / 1 PTY skip / 0 failed**. Merged `cb8308e`; Node 22/24, coverage, audit, browser E2E and docs passed. |

Tests distinguish behavior from configuration: hosted task and web-tool flags remain disabled. Task side effects without an approval integration fail closed. Warden is opt-in for web chat, not universal coverage. The cost-cap API remains opt-in; tokenization, framing, multimodal input, missing usage and prices outside the table can cause overruns. The current production Gemini model remains unchanged by smaller-model routing.

The Firestore fix favors durable billing discovery over registry compaction. Historical tenant registrations and missing event IDs can remain; safe compaction needs an atomic multi-document protocol. Local filesystem task lease tests do not establish GCS/FUSE or multi-instance safety. These are explicit follow-up limits, not claims of complete hosted autonomy.

## Product positioning and website

- English/Chinese README lead with everyday personal-assistant use and distinguish tagged releases, current source, production flags and the submitted iOS binary.
- Package metadata, Homebrew seed description, GitHub About/homepage and `.codex` product context use the same positioning.
- Rebuilt bilingual Home and Cloud pages around planning, writing, memory and actual Cloud/Mac boundaries. Removed claims of a real person, unconditional local-only processing, instant deletion of all third-party records, and a future Mac bridge presented as available.
- Preserved Lisa's existing character; generated a new share card with the imagegen skill. It is marketing artwork, not an App Store screenshot or evidence of a shipped interface. Saved as `website/public/og-assistant-v2.png`, with a versioned URL and matching dimensions.
- Checked English desktop and Chinese mobile pages in a browser. Fixed top navigation wrapping; 390px and 1160px viewports have document width equal to viewport width. The comparison table scrolls within its own region. Astro builds all 14 routes, including privacy/support in both languages.

## App Store evidence and unresolved gates

The authenticated Apple API was checked again during this audit:

| Item | Observed state |
| --- | --- |
| App | Lisa Pocket, `ai.meetlisa.main`, App ID `6784690058` |
| Version/build | **1.2 (1791346539)**; build already VALID and selected |
| Submission | `1f0010d4-7318-44c7-b292-90ac1d8eb248` — **WAITING_FOR_REVIEW** |
| Release setting | **AFTER_APPROVAL** |
| Store description | Personal assistant; Cloud and My Mac; separate instance data; named AI processing/consent; consumable credit behavior |

The queued binary already fixes the actual October 5 rejection: no `AppStore.sync()` for consumable balance refresh, and an immutable consent sheet naming AI recipients/data with unchecked sharing and age controls, Cancel and withdrawal. Existing native evidence includes 73 passing XCTest cases on each of three iPhone/iPad simulator configurations and a real review-account chat/consent/credit-refresh walkthrough. Those checks were not repeated merely to inflate this audit's test count. No native code in this integration requires cancelling the current queue.

**Still unverified or blocked:**

1. **Apple authorization revocation key.** Production has no `LISA_APPLE_TEAM_ID`, `LISA_APPLE_KEY_ID` or `LISA_APPLE_PRIVATE_KEY`. The code can exchange/store/revoke when configured, but configuration is still required. The App Store Connect upload key is not a Sign in with Apple key. Apple Developer browser login expired; user sign-in is needed before configuring the Lisa-specific key. UI credential creation requires confirmation at that action under the computer-use policy.
2. **Interactive Apple/Google sign-in.** Configured buttons/client IDs and mock tests do not prove the real interactive flows. Finish these with the user's authenticated device/session.
3. **StoreKit sandbox purchase → backend credit.** Product visibility, balance refresh and synthetic signed-transaction tests do not prove a real sandbox purchase. Finish on an authenticated sandbox/TestFlight device and verify one settlement plus idempotent replay.
4. **Apple's decision.** Waiting for review is not approval. The reviewer response and approved storefront availability remain external outcomes.

The current production service was checked without exposing secrets: `lisa-cloud-00030-lut` served 100% of backend traffic; `lisa-web-00020-hev` was the initial website revision. Public `/health` works; `/healthz` is not the public health URL. Rollout receipts are recorded below as they become verified. No production task/web opt-in, model key, price, territory or native review selection is changed by this audit.

## Verified rollout receipts

All eight original PRs are merged. The positioning and audit changes are tracked in [#415](https://github.com/oratis/LISA/pull/415). The source used for release passed [CI](https://github.com/oratis/LISA/actions/runs/37643627660), including Node 22/24, coverage, audit, browser E2E, website build and docs. The final documentation-only receipt update is separately gated before merge.

| Surface | Published result | Verification / rollback |
| --- | --- | --- |
| Cloud backend | `lisa-cloud-00033-meq`, 100% traffic at 2026-10-07 15:30 UTC | Zero-traffic canary and public `cloud.meetlisa.ai`: health, actual review-account login, nonempty AI chat completion without error, and account quota before/after all passed. No ERROR-level entries for this revision at the post-release check. Previous revision `lisa-cloud-00030-lut` retained for rollback. |
| Website | `lisa-web-00023-gew`, 100% traffic at 2026-10-07 15:31 UTC | All 14 public routes return HTML, homepage contains the new positioning, and the served share-image hash matches the reviewed asset. Previous revision `lisa-web-00020-hev` retained for rollback. |
| GitHub | About, homepage and topics updated | About leads with “Open-source AI Personal Assistant”; homepage is `https://meetlisa.ai`; added assistant/knowledge topics and removed the self-evolving topic. |
| App Store | Rechecked 2026-10-07 15:30 UTC | Version and review submission still `WAITING_FOR_REVIEW`; release remains `AFTER_APPROVAL`. No cancellation or replacement. |

The backend was built from tracked source `0105dbcecb08052031f05271c56d0753b5d815e3` by Cloud Build `d09f9add-0743-4e3e-b98c-ac7d6e091b7f`. Container digest: `sha256:e2f5a4a0228926f43c41287141a61c1dc54ff9d1ccc1ad15eb929d1d644d57c5`. The runtime source/configuration files are identical after merging the final main ancestry; subsequent changes only update audit text. The service runtime configuration was compared before/after in memory: credentials, volume, model, account settings and feature flags were preserved. Hosted tasks and web tools remain disabled. Both temporary canary tags were removed after promotion.

These production chat checks use the existing review account, not a real Apple/Google interactive login or StoreKit purchase. They do not close the unresolved gates above. No new npm tag, Mac binary or iOS binary was released by this integration.

## References

- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — privacy disclosure and consent.
- [Anthropic streaming usage](https://platform.claude.com/docs/en/build-with-claude/streaming) — message_delta counters are cumulative.
- [Gemini generateContent schema](https://ai.google.dev/api/generate-content) — finish reason and usage metadata are separate fields.
- [Task engine design](DESIGN_TASK_ENGINE.md), [provider configuration and budget limits](PROVIDERS.md), [Warden design](DESIGN_WARDEN.md).
