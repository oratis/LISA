# Lisa 0.32.0 — A more expressive companion, connected workspaces

Lisa gains natural seated animations, a shared chat sticker collection, a clearer Rêve and Control layout, and a Dashboard catalog of 22 connectors including Box and Obsidian. Fleet now carries work from an isolated task through per-turn review, selected-file rollback and confirmed merge into its source branch. Pocket can switch between saved Macs, catch up on shared timelines and decide explicitly granted approvals. Codex gains an approved workspace mode alongside packet review. This release also adds full Fleet cleanup and storage controls, explicit continuation of verified-stopped tasks, selected-project T3 reads, optional screenshot context, steadier connections and selected Feishu document reads.

The local Mac build was accepted on November 17, 2026, and PR #516 is merged. GitHub artifacts, the signed/notarized Mac app, npm, Homebrew, the hosted backend, relay and website are published and verified. See the [publication record](RELEASE_VERIFICATION_v0.32.0.md) and the [release checklist](RELEASE_CHECKLIST_v0.32.0.md) for channel evidence and remaining live-account/device checks.

## Companion animation and chat stickers

- Working, reading and tea use dedicated seated animation loops with matching hip and foot positions in both room themes. Resting keeps its fitted pose and gentle breathing; hidden windows and reduced-motion preferences stop animation.
- Four new expressions — Got it, Hug, Good night and Curious — bring the collection to 12 animated stickers plus 24 mood portraits. Choose a sticker in the chat composer, optionally add text, and send it to Lisa. Both user and Lisa stickers survive history reloads; the gallery offers transparent WebP and animated GIF downloads.
- Rêve pairs memory with knowledge, reflection with pursuits, and dreams with capacity in a balanced layout that adapts to the pane width. Authored controls follow the Chinese or English locale; saved user content retains its original language.

## Box, Obsidian and the connector dashboard

- Dashboard lists all 22 read-only connectors with search, filters, configuration actions, saved authorization state and selected-resource counts. Authorization status describes a saved grant, not a live provider health check.
- Box uses read-only OAuth and explicit file selection. Version-pinned reads support bounded text files; PDF and Office extraction are not included. A locally configured Box OAuth application is required. Offline OAuth/read/refresh tests pass; a real Box account has not been tested.
- Obsidian discovers local vaults and asks which ones Lisa may read. It lists, searches and reads bounded Markdown content without a community plugin or local HTTP server. Hidden files, symlinks, hard-linked content and attachments are excluded. Tests use disposable vaults.
- Setup, scope and read limits are in [Box and Obsidian connectors](CONNECTORS_BOX_OBSIDIAN.md).

## Control and remote Mac workflows

- Remote Macs is now part of **Control**, alongside **This Mac**, instead of a separate link above the navigation grid. The interface follows the system language, displaying Chinese or English, while task content stays as written.
- A device → workspace → task flow keeps progress, approvals, results and per-turn diffs together. Tabs preserve drafts, share the app theme and pause hidden polling; desktop and mobile layouts use the same controls.
- The executing Mac's setup section updates connection status and incoming pairing requests automatically without clearing selected workspace grants or interrupting a settings load.
- Fleet scripts and styles use content-versioned paths, so upgrading an installed app loads matching assets even when its offline cache still contains an older release.
- Physical second-Mac acceptance with a live Claude provider passed pairing, scoped grants, approved Read/Edit, denied edits, follow-up approvals, result/diff retrieval, lost-response reconciliation, relay reconnect, cancellation and revocation. The tested CLI exposed Read/Edit; new-file Write and live remote Codex are not included in this acceptance.

## Fleet timelines and read-only Pocket sharing

- The executing Mac records task events and operation receipts together. Retrying a request cannot start the work twice; reconnecting clients page from their last sequence number. Missing or expired history is marked rather than silently hidden.
- Task recovery releases an execution slot only after checking the old process identity. Approval outcomes remain visible after the request closes; revocation removes access on the next read and closes live device streams.
- The owner can share a specific task with a v2-paired Pocket, including a finished task. Pocket receives the task state, agent, turn summaries and approval outcomes, with no source-code diff or tool arguments under the default read-only grant. A separate approval grant is described below. Revocation and re-pairing invalidate the old grant.
- Pocket keeps its last received timeline in memory across temporary disconnections, catches up on reconnect, and clears it when the account, Mac or authorization changes. Pocket features require a compatible Pocket binary; the public and complete-extension TestFlight builds are distinguished below.

## Pocket multi-Mac and task approvals

- Pocket saves up to 32 Macs with separate credentials and pinned identities. Switching replaces the active connection and clears the old task view; account changes remove all account-based Macs. Single-Mac upgrades wait safely if Keychain is locked.
- Pocket task shares remain read-only by default. A separate per-task approval grant enables complete tool-input preview and exact-request Allow/Deny decisions. The host rechecks expiry, controller authority and remote-control policy; pairing-scoped receipts and one-decision-per-request guards prevent repeated execution after lost replies. Room and Fleet include the saved-Mac switcher.

## Per-turn checkpoints and file diffs

- Create an isolated worktree from a registered Git repository's current commit, then explicitly grant it to a controller. Uncommitted source-directory changes stay in the source directory.
- Fleet captures the start and end of each turn in a private Git store without changing the user's index or branch. Cancellation records partial changes; restart marks unfinished boundaries as interrupted.
- Inspect added, changed and deleted files, with bounded text diffs and binary-change indicators. Concurrent workspace changes are labelled: a diff shows the workspace's change, not proof that the agent made every edit.
- Checkpoints cover the first 100 turns, at most 2,000 entries / 16 MiB per snapshot and 64 KiB per displayed diff. Unsupported or oversized snapshots show an unavailable state without stopping the task.
- Owners can delete a finished task's checkpoint objects. This clears displayed diffs but retains workspace files, task history and operation receipts. Selected-file rollback now has a signed preview and explicit confirmation, with current-content, inode, permission and workspace checks. It preserves the Git index and unrelated files; receipts prevent retrying over later edits.

## Confirmed merge, cleanup and storage limits

- Preview a finished task's selected snapshot as one commit into its original source branch. Both workspace grants, original branch/base, clean source checkout and unchanged selected snapshot are checked again at confirmation. Hooks, filters and signing are disabled during controlled preparation and checkout.
- Optional worktree removal is a separate checkbox bound to the preview. It only removes an owned, unchanged worktree and refuses ignored files; source files and historical task diffs remain. Existing worktrees without recorded source provenance cannot use automatic merge.
- The default cross-task checkpoint quota is 512 MiB. Owners can adjust it and optionally retain only a chosen number of days of ended-task checkpoints. Active work is preserved.
- Full ledger cleanup previews what it will erase, rotates the operation generation, clears task contents/shares/receipts and snapshots, then compacts SQLite/WAL. Old retries cannot recreate deleted tasks. Pairings and registered source workspaces remain.
- Uncertain filesystem results reserve the host until the local owner verifies them. Receipts retain proposed merge commits where available; retries query the original outcome instead of applying changes again.

## Capability-aware controls and confirmed agent handoffs

- Each task declares which observe, append, cancel, approve, resume and handoff actions the current device can use. The host checks the grant, adapter, task state and live process again when an action is submitted. Neither adapter claims to resume an orphaned process.
- Authorized external Claude/Codex sessions can appear beside managed tasks as metadata-only observations, without gaining controls or exposing their transcripts.
- Select a finished task's checkpointed turn and another agent, add optional verification notes, then preview the complete request, result and file diffs. Confirmation is bound to that exact packet and expires after ten minutes. Changed content, cleanup, revocation or a backend restart requires a fresh preview.
- Claude keeps independently approved file operations; available tools depend on the installed CLI version. Codex runs a single read-only review of the confirmed packet in an empty macOS sandbox, using the host's installed CLI and OpenAI API configuration. Packet mode does not browse the source checkout or run validation commands. A separate Codex workspace mode provides List/Read/Edit/Write through Fleet approvals with file identity/content rechecks, safe path limits and follow-up turns. The native process remains isolated from the project; existing packet mode is preserved. Packets are limited to 20 files / 96 KiB; oversized packets are rejected.
- Handoff confirmation records the new task, linked events and receipt atomically. Retrying the same operation returns the original task. Old approvals never carry into the receiving session.

- Uncertain tasks can now continue through a new session after the old process has been verified stopped. A new instruction and signed context preview are required; no old tool call or approval is replayed, and the original outcome remains unverified.

Setup, retention and operating limits are in the [Fleet guide](FLEET.md).

## Connections and account recovery

- Mac relay heartbeats, wake/reconnect handling and session renewal keep the host discoverable. Revoked phones lose existing streams, and an account change clears device authority.
- Pocket distinguishes offline Macs, unavailable relays, expired sessions, refused permissions and server failures. Recovery actions open the appropriate settings or sign-in screen and preserve unsent drafts.
- Account refresh and sign-out-everywhere endpoints renew or revoke sessions; structured error codes support matching recovery behavior across clients. Temporary service failures are not treated as account revocation.
- Pairing can be cancelled on the Mac, clock skew is explained, and connection diagnostics omit credentials. CLI pairing flags and PTY helper permissions now work on npm/Homebrew installs; active roster rows refresh correctly.
- Lint ignores disposable backend/UI fixtures, so running native acceptance tests alongside source checks no longer produces a TypeScript-project parsing error.
- The regular test suite now runs a Pocket-protocol → cloud relay → Mac scenario covering pairing, REST, streamed chat, cancellation, revocation and LAN fallback.

## Selected Feishu documents

Feishu adds selected document reads alongside the existing sources and the new T3 connector. A local connection card resumes the original request after OAuth and selection of docx links or IDs. Reads are scoped to the selected documents, recheck identity and document version, and limit responses to 1 MB / 30,000 characters. Disconnect revokes credentials where supported. This requires a locally configured confidential Feishu app and is unavailable to Cloud and remote devices. Automated OAuth/read regressions pass; a real-account document-read acceptance remains outstanding.

## Selected T3 projects and optional screenshot context

- The twentieth read-only connector reads project lists and thread-list metadata for explicitly selected T3 projects. Configure the environment's MCP URL, sign in with **Read only**, then choose projects. OAuth uses PKCE and issuer binding; every read rechecks the environment and scope before returning buffered data. No thread bodies, other environments or writes are exposed. Local disconnect removes the credential; T3's upstream session must be revoked in **Settings → Sharing & access**. Expired grants require sign-in again.
- **Screenshot + front-window text** (Mac `⌃⌥⇧S`) optionally collects window title, bounded accessibility text and screen coordinates before capture. Review the exact text in the attachment preview; it is excluded until explicitly checked. Missing Accessibility permission preserves image-only capture, and the existing `⌃⌥S` stays image-only. Window context may differ from the selected image region. The signed Mac bundle includes its helper; CLI/npm needs Swift for first use.

## Pocket Room and iPad refresh

Pocket 1.4 source opens into Room with nine destinations, real memory/request/session summaries and editable chat starters. Paper and botanical colors, improved reading widths and Chinese copy carry through the app. iPad keeps adaptive layouts and native navigation. Approval payloads scroll above fixed one-time action buttons. Keyboard dismissal and unconfigured-chat setup links are fixed.

Pocket is published separately from this Mac/CLI version. On November 17, Apple confirmed public **1.4**, build **1794650503**, released November 15. Complete-extension build **1794678341** is valid and available in internal TestFlight; it is not that public binary. The public build was preserved during this release. See the [release checklist](RELEASE_CHECKLIST_v0.32.0.md).

## Knowledge-base history isolation

Knowledge-base Git history now binds every command to that instance's own repository and ignores inherited Git directory/index overrides. Initialization failures and switching between instances can no longer make a knowledge-base save commit unrelated files in an enclosing project. Linked Git directories are refused, and failed initialization can be retried safely.

## Upgrade and remaining limits

- Replace Lisa.app and restart its background service (or restart the Mac) to load the bundled backend. CLI users can run `npm install -g @oratis/lisa@0.32.0` or `brew update && brew upgrade lisa`.
- Existing workspaces continue to run without checkpoints until a new isolated workspace is created and granted. Older clients default to Claude; historical tasks without full saved requests cannot generate a handoff packet.
- The private Fleet ledger retains requests/results for the first 100 turns and confirmed handoff packets. Checkpoint cleanup does not erase those records. Full cleanup now erases those records, task shares and receipts, deletes snapshots and compacts SQLite/WAL. It rotates the operation generation so old requests cannot recreate tasks. Checkpoint quota defaults to 512 MiB across tasks; optional retention clears only old ended-task checkpoints. Finished tasks can preview and confirm one commit into the unchanged clean source branch, with separate source-workspace authorization and optional cleanup of the owned worktree. Cleanup retains task history and refuses ignored files or changed contents. Uncertain filesystem operations reserve the host until the owner verifies them; retries never repeat the write.
- Pocket saves up to 32 Macs with isolated credentials and pins, explicit switching and safe single-Mac migration. Account changes remove all account-based Macs; direct LAN/QR profiles remain separate. Cloud/Mac histories and credentials do not automatically synchronize.
- Apple Calendar and Reminders still require a Swift toolchain and are not available in the bundled Mac app. Hosted autonomous tasks remain off by default.
- Simulator and local integration tests do not establish physical iPhone Wi-Fi/cellular switching, Mac sleep/wake on a remote machine, or a provider's live inference behavior. Current evidence and outstanding release acceptance are recorded in the [checklist](RELEASE_CHECKLIST_v0.32.0.md).

## Included changes

This release includes [#516](https://github.com/oratis/LISA/pull/516) (accepted companion, connector and Control refresh), [#511](https://github.com/oratis/LISA/pull/511) (Fleet extensions) and [#512](https://github.com/oratis/LISA/pull/512) (knowledge-base isolation). It includes [#498](https://github.com/oratis/LISA/pull/498), [#504](https://github.com/oratis/LISA/pull/504), [#505](https://github.com/oratis/LISA/pull/505), [#497](https://github.com/oratis/LISA/pull/497), [#500](https://github.com/oratis/LISA/pull/500), [#499](https://github.com/oratis/LISA/pull/499), [#503](https://github.com/oratis/LISA/pull/503), [#506](https://github.com/oratis/LISA/pull/506), [#501](https://github.com/oratis/LISA/pull/501), [#507](https://github.com/oratis/LISA/pull/507), [#460](https://github.com/oratis/LISA/pull/460), [#509](https://github.com/oratis/LISA/pull/509) and [#508](https://github.com/oratis/LISA/pull/508). The missing historical [v0.30.2 note](RELEASE_v0.30.2.md) has also been restored, and both READMEs now distinguish source features from channel availability.
