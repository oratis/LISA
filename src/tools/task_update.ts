/**
 * task_update — Lisa edits a task, or pauses it.
 *
 * Changing what runs unattended is the same kind of act as creating it, so an
 * edit made here always leaves the task OFF and UNCONFIRMED: if it was on, it
 * is switched off and the user has to turn it back on — and confirm it again
 * — after seeing the change. The tool can pause (`pause: true`) but has no way
 * to enable or confirm.
 */
import { disableTask } from "../tasks/lifecycle.js";
import { updateTask } from "../tasks/store.js";
import { applyTaskEdit } from "../tasks/validate.js";
import type { ToolDefinition } from "../types.js";
import { announce, confirmationCard, toolContext } from "./task_common.js";

interface TaskUpdateInput {
  id: string;
  title?: string;
  instruction?: string;
  schedule?: string;
  timezone?: string;
  notify?: "always" | "on_change" | "on_hit" | "silent_on_noop";
  pause?: boolean;
}

export const taskUpdateTool: ToolDefinition<TaskUpdateInput, string> = {
  name: "task_update",
  description:
    "Edit a task's title, instruction, schedule or notify policy, or pause it (pause: true). Any edit " +
    "switches the task OFF until the user turns it back on — you cannot enable a task. Get ids from task_list.",
  annotations: {
    title: "Update task",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string", minLength: 1, maxLength: 200 },
      instruction: { type: "string", minLength: 1, maxLength: 8000 },
      schedule: { type: "string", description: "New schedule (same grammar as task_create)." },
      timezone: { type: "string", description: "IANA zone for the new schedule." },
      notify: { type: "string", enum: ["always", "on_change", "on_hit", "silent_on_noop"] },
      pause: { type: "boolean", description: "true switches the task off without changing it." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async execute(input) {
    const ctx = toolContext();
    const edit: Record<string, unknown> = {};
    if (input.title !== undefined) edit.title = input.title;
    if (input.instruction !== undefined) edit.instruction = input.instruction;
    if (input.notify !== undefined) edit.notify = input.notify;
    if (input.schedule !== undefined) {
      edit.schedule = { expr: input.schedule, ...(input.timezone ? { tz: input.timezone } : {}) };
    }
    const edited = Object.keys(edit).length > 0;
    if (!edited && input.pause !== true)
      return "(nothing to change — pass a field to edit, or pause: true)";

    let problem: string | null = null;
    let wasEnabled = false;
    const task = await updateTask(input.id, (t) => {
      if (edited) {
        problem = applyTaskEdit(t, edit, ctx);
        if (problem) return false;
      }
      wasEnabled = t.enabled;
      // Edited or paused, the result is the same: off until the user says
      // otherwise, and unconfirmed whatever field changed — what the user
      // confirmed was not a task the model has since touched (#422 review N2).
      disableTask(t);
      delete t.envelopeConfirmation;
      if (t.enabledAt === undefined && !t.activeRunId) t.state = "draft";
      return;
    });
    if (!task) return `(no task with id "${input.id.slice(0, 80)}")`;
    if (problem) return `(not updated: ${problem as string})`;
    announce(task);
    if (!edited)
      return `Paused "${task.title}" (${task.id}). It stays off until the user turns it on.`;
    return (
      confirmationCard(task, "Updated") +
      (wasEnabled ? "\nIt was on before this edit and has been switched off — say so." : "")
    );
  },
};
