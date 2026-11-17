# v0.32.0 publication verification

Verified November 17, 2026, after owner acceptance. [PR #516](https://github.com/oratis/LISA/pull/516) merged as `30769980`; [PR #517](https://github.com/oratis/LISA/pull/517) completed the release notes. The immutable `v0.32.0` tag points to reviewed merge `47cd9a0568ac0785b68e574b69b11e7a61611de7`. Publication-record edits do not change that tag or rebuild its artifacts.

## Published channels

| Channel | Published result | Verification |
| --- | --- | --- |
| GitHub | [v0.32.0 release](https://github.com/oratis/LISA/releases/tag/v0.32.0) | [Release workflow](https://github.com/oratis/LISA/actions/runs/44009132261) passed; all three CLI/source packages match `SHA256SUMS.txt`; bundled CLI reports 0.32.0. |
| Mac | Universal, signed and notarized `Lisa-Suite-v0.32.0.dmg` | [Mac workflow](https://github.com/oratis/LISA/actions/runs/44009132180) passed Apple notarization for the app and DMG. Download checksum, deep signature verification, stapled ticket and Gatekeeper assessment passed locally. |
| Local installation | Official 0.32.0 app installed over the accepted candidate | Prior app and user data backed up. Bundled backend version, native UI, existing session files, remote identity and online account connection verified after restart. |
| npm | `@oratis/lisa@0.32.0`, `latest` | Download matches registry SHA-512 integrity and the GitHub source artifact byte-for-byte. Isolated installation, CLI version/help and packaged Box, Obsidian and motion assets passed. |
| Homebrew | [Live tap formula](https://github.com/oratis/homebrew-tap/blob/main/Formula/lisa.rb) points to 0.32.0 | [Tap workflow](https://github.com/oratis/LISA/actions/runs/44010729800) passed. Live formula URL and SHA-256 match the downloaded npm package. |
| Hosted backend | `lisa-cloud-v0-32-0`, 100% production traffic | Canary and production health/version, existing account authentication, unauthenticated API refusal, Cloud-only restrictions and new assets passed. Existing environment, secrets, storage and service settings retained. |
| Relay | Worker version `1faddc46-b866-4176-bcca-69b3a1db01a4` | Pinned Wrangler type checks, four tests and dry run passed. Production account authentication, v2 pairing, encrypted round trips, heartbeat and revocation passed both before and after backend promotion. Disposable test identities and grants were removed. |
| Website | `lisa-web-v0-32-0-notes`, 100% production traffic | Rebuilt after the GitHub release was public. Canary and [production](https://meetlisa.ai) checks passed for both homepages, changelogs, privacy pages and linked CSS. Existing traffic tags retained. |

The registry initially served stale metadata and returned 404 for the new tarball. The release was not republished: bounded download retries completed before the Homebrew formula update, and the package was subsequently downloaded and independently installed locally.

## Artifact identity

| Artifact | SHA-256 |
| --- | --- |
| npm tarball / GitHub source package | `d70d8031ff3bbe407bd7a4044614d1c855cdc842a13da496cbe3402a15a080e7` |
| Mac CLI bundle | `e92a4c1c28754ecf23fb4807a146a110fd8a0dcda9a4408141bef46270eb9c7f` |
| Linux CLI bundle | `cb30d1db39c367fab6b26ab3f32b3fde8dc58bb6ed150458a4f78bf7bdfe267f` |
| Notarized Mac DMG | `4a0cbb48c8e7d00288fb25c0514f2434541db37b848cc64c1f12b8b7d1fe738b` |

The backend image was built from clean source commit `7509d5d0ef05c99992845af0319ee626bfe7499a`, whose tree is identical to the tagged merge. Cloud Build `cc8bca99-c97b-4f0d-86dc-61910d97488d` succeeded, and Cloud Run was deployed by immutable image digest.

## Retained rollback targets

| Service | Previous production target |
| --- | --- |
| Cloud Run backend | `lisa-cloud-v0-31-0` |
| Cloud Run website | `lisa-web-gmail-privacy-1108` |
| Cloudflare relay | `62681223-d843-4da5-b773-6fe8fff4657a` |

Both Cloud Run services remain in project `oratis-491316`, region `us-central1`. No rollback was needed. Local installation backups and private deployment snapshots are retained outside version control.

## Pocket and remaining acceptance

A [read-only Apple status workflow](https://github.com/oratis/LISA/actions/runs/44010021669) confirms public Pocket **1.4**, build **1794650503**, is `READY_FOR_DISTRIBUTION`. The public listing records its November 15 release. Complete-extension build **1794678341** is separately `VALID`, `IN_BETA_TESTING` internally and `READY_FOR_BETA_SUBMISSION` externally; it is not the public binary. This release did not upload or replace an iOS build.

The accepted physical second-Mac workflow covered live Claude Read/Edit approvals, denied edits, follow-ups, results/diffs, receipt recovery, reconnect, cancellation and revocation. It does not establish remote Codex, new-file Write, physical sleep/wake or physical iPhone Wi-Fi/cellular acceptance. Real Feishu, T3 and Box account checks remain outstanding; Obsidian acceptance used disposable vaults. These limits remain explicit in the [release checklist](RELEASE_CHECKLIST_v0.32.0.md).
