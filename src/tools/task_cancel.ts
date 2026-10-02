/**
 * task_cancel — stop a task's run in flight (or its queued start).
 *
 * Works across processes: it leaves a flag on the task that whichever runner
 * owns the run honours at its next checkpoint. Stopping is always safe, so
 * unlike create/update there is nothing for the user to confirm.
 */
import { isRecurring, nextRunAfter, restingState } from "../tasks/lifecycle.js";
import { updateTask } from "../tasks/store.js";
import type { ToolDefinition } from "../types.js";
import { announce, toolContext } from "./task_common.js";

interface TaskCancelInput {
  id: string;
}

export const taskCancelTool: ToolDefinition<TaskCancelInput, string> = {
  name: "task_cancel",
  description:
    "Stop a task's current run (or a run that is queued to start). The task itself stays; a routine " +
    "carries on at its next scheduled time — use task_update with pause: true to switch it off. Get ids from task_list.",
  annotations: {
    title: "Cancel task run",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  async execute(input) {
    const { cloud } = toolContext();
    const now = Date.now();
    let outcome: "running" | "queued" | "idle" = "idle";
    const task = await updateTask(
      input.id,
      (t) => {
        if (t.activeRunId) {
          t.cancelRequestedAt = now;
          outcome = "running";
          return;
        }
        if (t.state === "queued") {
          delete t.queued;
          t.state = restingState(t);
          if (t.enabled && isRecurring(t)) t.nextRunAt = nextRunAfter(t, now, cloud);
          else delete t.nextRunAt;
          outcome = "queued";
          return;
        }
        return false;
      },
      now,
    );
    if (!task) return `(no task with id "${input.id.slice(0, 80)}")`;
    // `outcome` is assigned inside the callback, which narrowing cannot see.
    const result = outcome as "running" | "queued" | "idle";
    if (result === "idle") return `"${task.title}" has nothing running or queued.`;
    announce(task);
    return result === "running"
      ? `Asked the current run of "${task.title}" to stop; it ends at its next checkpoint.`
      : `Removed the queued run of "${task.title}".`;
  },
};
