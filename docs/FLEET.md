# Fleet: tasks on your other Macs

Fleet lets a controlling Mac start work in a separately authorized workspace on an executing Mac. Start from **Remote Macs** in the web workspace. Each Mac needs a running LISA backend and the same LISA account; the executing Mac must stay awake. See [Mac connection setup](REMOTE_CONNECTIONS.md) for account pairing and network recovery.

## Set up an executing Mac

1. Open the executing Mac's own local LISA page, then **Remote Macs → Configure this Mac as an execution host**. Host configuration is restricted to the local owner.
2. Register a workspace and enable the installed agent. Claude Code supports approved Read/Edit/Write operations and follow-up turns. Codex needs its native CLI and `OPENAI_API_KEY` (optionally `OPENAI_BASE_URL`) and reviews one explicitly supplied packet.
3. Pair the controller with v2 code comparison, then grant that device the exact workspace. Another device, account or directory does not inherit the grant.
4. For checkpoints, create an **isolated workspace from the current commit** of a registered Git repository and grant the newly created workspace. It starts at HEAD in a detached worktree beside the original repository. Uncommitted source changes are not copied.

## Run and reconnect

On the controller, select the Mac, granted workspace and agent, then enter the task. Available actions follow the agent and task's current capabilities. Approve Claude's tools on the controlling device, append a turn when available, or cancel.

The executing Mac keeps the task state, receipts and ordered timeline. Reconnecting controllers continue from their last event sequence; expired history is shown as a gap alongside the current state. A repeated operation returns its existing receipt. If the backend loses ownership of a process after restart, the result is marked unverified; neither adapter resumes that old process. Follow the local recovery action before starting another task in the occupied slot.

## Review each turn and hand it over

Open a turn's checkpoint to list changed files and view a diff. Ordinary directories have no checkpoints. Each snapshot holds up to 2,000 entries / 16 MiB, the first 100 turns are captured, and a displayed file diff is capped at 64 KiB. Ignored untracked files are excluded. Binary changes, concurrent edits, interrupted turns and unavailable snapshots have explicit labels. The diff cannot independently attribute changes to the agent.

After the task ends, select a changed file and choose **Preview file restore**. Review its current and turn-start contents, then confirm. Fleet refuses a changed file, inode, permissions or workspace, and never restores through symlinks or hardlinks. Binary files show their size and SHA-256 digest. The target is the selected turn’s start; only that file is changed, including removal of a file added during the turn. The Git index stays unchanged. A lost response retrieves the original receipt; an unknown result must be checked on the execution Mac.

To hand off, finish the original task, select another agent and a checkpointed turn, add any verification notes and request a preview. Review the exact packet before confirming. It contains the initial requirement, selected turn's requirement/result, file diffs and your notes; it does not include all other turns or old approvals. Notes are user-provided assertions, not evidence that a command ran. The maximum is 20 files / 96 KiB. Edited, expired or invalidated previews must be regenerated.

Codex reviews only this packet in an empty sandbox; it cannot inspect the source project or run your tests. Claude may request its own new tool approvals. Handoff remains on the same executing Mac and workspace.

## Share a task with Pocket

On the executing Mac's local configuration page, use **Pocket task access** to share one task with a securely paired phone. Finished tasks can also be shared. In the updated Pocket, open **Room → Shared Fleet tasks** (also available under Agents) for the currently selected Mac.

Shares default to read-only summaries and approval outcomes. To allow decisions, separately enable approval for that Pocket and task on the executing Mac. Pocket then shows the complete pending tool input (up to 32 KiB), request expiry and explicit Allow/Deny buttons. The host rechecks the pairing, task grant, controller authority, remote-control policy and exact request. Changed, expired or oversized requests require the controller. Lost replies retry the same receipt; uncertain decisions cannot be executed again. Foreground polling and reconnect catch up from the last sequence. Data stays in memory; switching account/Mac or losing authorization clears it. A new pairing does not restore an old task share. Revoke one task's share on the Mac, or disconnect the phone to revoke all its access. App Store 1.3 predates this entry; install the new Pocket release when available.

Pocket saves up to 32 Macs with separate credentials and pins. Use the Mac switcher in Room/Fleet or Settings → Connect your Mac. Switching clears the old Mac’s in-memory task state; signing out or changing Cloud accounts removes every account-based Mac, while direct LAN/QR connections stay separate. Forgetting one Mac does not select another.

## Retention and boundaries

The owner can set a cross-task checkpoint quota (default 512 MiB) and retention in days (default 0, disabled). Quota exhaustion skips the new snapshot while the agent continues and preserves existing checkpoints. Retention clears old ended-task checkpoints, never an open session. The owner can also clean checkpoints for a finished task. This deletes private snapshot objects and clears displayed diffs, while keeping workspace files, receipts and the timeline. Fleet also keeps full requests/results for the first 100 turns and confirmed handoff packets in its private ledger; checkpoint cleanup does not delete them.

For complete deletion, use **Preview full ledger cleanup**, review the counts and confirm while the host is idle. This erases task requests/results, timelines, shares, operation receipts and private checkpoints, then compacts SQLite/WAL. Workspace files, registrations and paired-device configuration remain. Cleanup rotates the operation generation; old clients must update, and pending requests keep their old generation so retries cannot recreate deleted tasks.

Automatic merge and automatic worktree deletion remain in progress for the complete release. Optional T3 connectors and screenshot window context are separate proposals. Detailed implementation and acceptance scenarios are in the [workflow plan](PLAN_T3_CODE_AGENT_WORKFLOWS_2026-11-11.md).
