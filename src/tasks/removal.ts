/**
 * Removing a task that may be running.
 *
 * `DELETE /api/tasks/:id` and `lisa tasks rm` both come here. A run in flight
 * is cancelled first — in this process through the runner, in another process
 * through the cancel flag its owner reads at the next checkpoint — and the
 * removal waits for that run to let go of the task's lease before the files
 * are deleted. If the owner does not let go in time the task is removed
 * anyway: the store never re-creates a deleted task's directory, so the run's
 * next write fails and it stops there.
 */
import { taskLeaseHeld } from "./lease.js";
import type { TaskRunner } from "./runner.js";
import { deleteTask, getTask, updateTask } from "./store.js";
import { removeTaskWorkspace } from "./workspace.js";

export const REMOVE_WAIT_MS = 10_000;

export async function removeTask(
  id: string,
  opts: { runner?: TaskRunner | null; waitMs?: number; now?: () => number } = {},
): Promise<{ removed: boolean; waited: boolean; stillRunning: boolean }> {
  const now = opts.now ?? Date.now;
  const task = await getTask(id);
  if (!task) return { removed: false, waited: false, stillRunning: false };

  if (opts.runner) await opts.runner.cancel(id).catch(() => false);
  else if (task.activeRunId) {
    await updateTask(id, (t) => {
      if (!t.activeRunId) return false;
      t.cancelRequestedAt = now();
      return;
    });
  }

  let waited = false;
  let stillRunning = await taskLeaseHeld(id);
  const deadline = Date.now() + (opts.waitMs ?? REMOVE_WAIT_MS);
  while (stillRunning && Date.now() < deadline) {
    waited = true;
    await new Promise((r) => setTimeout(r, 50));
    stillRunning = await taskLeaseHeld(id);
  }
  const removed = await deleteTask(id);
  if (removed) {
    // The task's own folder goes with it (best effort: the task is already gone)…
    await removeTaskWorkspace(id).catch(() => {});
    // …and so does whatever was granted "for this task".
    await opts.runner?.taskRemoved(id);
  }
  return { removed, waited, stillRunning };
}
