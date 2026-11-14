# Lisa 0.32.0 — Follow the work, review each turn

Fleet tasks now keep a timeline that reconnecting controllers and explicitly authorized Pocket viewers can catch up on. Review each turn's file changes in an isolated worktree, then preview exactly what a second agent will receive before handing the work over. This release also brings steadier Mac connections, renewable and revocable account sessions, selected Feishu document reads, and the source for Pocket's refreshed iPhone and iPad Room.

Status: release candidate. Publication is pending the [remaining acceptance gates](RELEASE_CHECKLIST_v0.32.0.md).

## Fleet timelines and read-only Pocket sharing

- The executing Mac records task events and operation receipts together. Retrying a request cannot start the work twice; reconnecting clients page from their last sequence number. Missing or expired history is marked rather than silently hidden.
- Task recovery releases an execution slot only after checking the old process identity. Approval outcomes remain visible after the request closes; revocation removes access on the next read and closes live device streams.
- The owner can share a specific task with a v2-paired Pocket, including a finished task. Pocket receives the task state, agent, turn summaries and approval outcomes, with no source-code diff, tool arguments or approval controls. Revocation and re-pairing invalidate the old grant.
- Pocket keeps its last received timeline in memory across temporary disconnections, catches up on reconnect, and clears it when the account, Mac or authorization changes. This entry requires the new Pocket binary; App Store 1.3 does not include it.

## Pocket multi-Mac and task approvals

- Pocket saves up to 32 Macs with separate credentials and pinned identities. Switching replaces the active connection and clears the old task view; account changes remove all account-based Macs. Single-Mac upgrades wait safely if Keychain is locked.
- Pocket task shares remain read-only by default. A separate per-task approval grant enables complete tool-input preview and exact-request Allow/Deny decisions. The host rechecks expiry, controller authority and remote-control policy; pairing-scoped receipts and one-decision-per-request guards prevent repeated execution after lost replies. Room and Fleet include the saved-Mac switcher.

## Per-turn checkpoints and file diffs

- Create an isolated worktree from a registered Git repository's current commit, then explicitly grant it to a controller. Uncommitted source-directory changes stay in the source directory.
- Fleet captures the start and end of each turn in a private Git store without changing the user's index or branch. Cancellation records partial changes; restart marks unfinished boundaries as interrupted.
- Inspect added, changed and deleted files, with bounded text diffs and binary-change indicators. Concurrent workspace changes are labelled: a diff shows the workspace's change, not proof that the agent made every edit.
- Checkpoints cover the first 100 turns, at most 2,000 entries / 16 MiB per snapshot and 64 KiB per displayed diff. Unsupported or oversized snapshots show an unavailable state without stopping the task.
- Owners can delete a finished task's checkpoint objects. This clears displayed diffs but retains workspace files, task history and operation receipts. Selected-file rollback now has a signed preview and explicit confirmation, with current-content, inode, permission and workspace checks. It preserves the Git index and unrelated files; receipts prevent retrying over later edits. Automatic merging remains in progress.

## Capability-aware controls and confirmed agent handoffs

- Each task declares which observe, append, cancel, approve, resume and handoff actions the current device can use. The host checks the grant, adapter, task state and live process again when an action is submitted. Neither adapter claims to resume an orphaned process.
- Authorized external Claude/Codex sessions can appear beside managed tasks as metadata-only observations, without gaining controls or exposing their transcripts.
- Select a finished task's checkpointed turn and another agent, add optional verification notes, then preview the complete request, result and file diffs. Confirmation is bound to that exact packet and expires after ten minutes. Changed content, cleanup, revocation or a backend restart requires a fresh preview.
- Claude keeps its independently approved Read/Edit/Write flow. Codex runs a single read-only review of the confirmed packet in an empty macOS sandbox, using the host's installed CLI and OpenAI API configuration. It does not browse the source checkout or run validation commands. Packets are limited to 20 files / 96 KiB; oversized packets are rejected.
- Handoff confirmation records the new task, linked events and receipt atomically. Retrying the same operation returns the original task. Old approvals never carry into the receiving session.

Setup, retention and operating limits are in the [Fleet guide](FLEET.md).

## Connections and account recovery

- Mac relay heartbeats, wake/reconnect handling and session renewal keep the host discoverable. Revoked phones lose existing streams, and an account change clears device authority.
- Pocket distinguishes offline Macs, unavailable relays, expired sessions, refused permissions and server failures. Recovery actions open the appropriate settings or sign-in screen and preserve unsent drafts.
- Account refresh and sign-out-everywhere endpoints renew or revoke sessions; structured error codes support matching recovery behavior across clients. Temporary service failures are not treated as account revocation.
- Pairing can be cancelled on the Mac, clock skew is explained, and connection diagnostics omit credentials. CLI pairing flags and PTY helper permissions now work on npm/Homebrew installs; active roster rows refresh correctly.
- Lint ignores disposable backend/UI fixtures, so running native acceptance tests alongside source checks no longer produces a TypeScript-project parsing error.
- The regular test suite now runs a Pocket-protocol → cloud relay → Mac scenario covering pairing, REST, streamed chat, cancellation, revocation and LAN fallback.

## Selected Feishu documents

Feishu joins the eighteen existing read-only source connectors. A local connection card resumes the original request after OAuth and selection of docx links or IDs. Reads are scoped to the selected documents, recheck identity and document version, and limit responses to 1 MB / 30,000 characters. Disconnect revokes credentials where supported. This requires a locally configured confidential Feishu app and is unavailable to Cloud and remote devices. Automated OAuth/read regressions pass; a real-account document-read acceptance remains outstanding.

## Pocket Room and iPad refresh

Pocket 1.4 source opens into Room with nine destinations, real memory/request/session summaries and editable chat starters. Paper and botanical colors, improved reading widths and Chinese copy carry through the app. iPad keeps adaptive layouts and native navigation. Approval payloads scroll above fixed one-time action buttons. Keyboard dismissal and unconfigured-chat setup links are fixed.

Pocket is published separately from this Mac/CLI version. The public App Store version was **1.3** when checked on November 14, 2026. TestFlight upload, App Store submission and approval are separate states; see the [release checklist](RELEASE_CHECKLIST_v0.32.0.md).

## Upgrade and remaining limits

- Replace Lisa.app and restart its background service (or restart the Mac) to load the bundled backend. CLI users can run `npm install -g @oratis/lisa@0.32.0` or upgrade the Homebrew formula after it is updated.
- Existing workspaces continue to run without checkpoints until a new isolated workspace is created and granted. Older clients default to Claude; historical tasks without full saved requests cannot generate a handoff packet.
- The private Fleet ledger retains requests/results for the first 100 turns and confirmed handoff packets. Checkpoint cleanup does not erase those records. Full cleanup now erases those records, task shares and receipts, deletes snapshots and compacts SQLite/WAL. It rotates the operation generation so old requests cannot recreate tasks. Checkpoint quota defaults to 512 MiB across tasks; optional retention clears only old ended-task checkpoints. Automatic worktree removal and auto-merge remain in progress.
- Pocket saves up to 32 Macs with isolated credentials and pins, explicit switching and safe single-Mac migration. Account changes remove all account-based Macs; direct LAN/QR profiles remain separate. Cloud/Mac histories and credentials do not automatically synchronize.
- Apple Calendar and Reminders still require a Swift toolchain and are not available in the bundled Mac app. Hosted autonomous tasks remain off by default.
- Simulator and local integration tests do not establish physical iPhone Wi-Fi/cellular switching, Mac sleep/wake on a remote machine, or a provider's live inference behavior. Current evidence and outstanding release acceptance are recorded in the [checklist](RELEASE_CHECKLIST_v0.32.0.md).

## Included changes

This release includes [#498](https://github.com/oratis/LISA/pull/498), [#504](https://github.com/oratis/LISA/pull/504), [#505](https://github.com/oratis/LISA/pull/505), [#497](https://github.com/oratis/LISA/pull/497), [#500](https://github.com/oratis/LISA/pull/500), [#499](https://github.com/oratis/LISA/pull/499), [#503](https://github.com/oratis/LISA/pull/503), [#506](https://github.com/oratis/LISA/pull/506), [#501](https://github.com/oratis/LISA/pull/501), [#507](https://github.com/oratis/LISA/pull/507), [#460](https://github.com/oratis/LISA/pull/460), [#509](https://github.com/oratis/LISA/pull/509) and [#508](https://github.com/oratis/LISA/pull/508). The missing historical [v0.30.2 note](RELEASE_v0.30.2.md) has also been restored, and both READMEs now distinguish source features from channel availability.
