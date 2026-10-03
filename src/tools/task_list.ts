/** task_list — what tasks exist, their state and when they run next. Read-only. */
import { getTask, listRuns, listTasks } from "../tasks/store.js";
import type { ToolDefinition } from "../types.js";
import { describeTask } from "./task_common.js";

interface TaskListInput {
  id?: string;
}

export const taskListTool: ToolDefinition<TaskListInput, string> = {
  name: "task_list",
  description:
    "List the user's tasks (routines, watchers, one-offs, goals) with their state, schedule and next run. " +
    "Pass id for one task's details and its recent runs. Read-only.",
  annotations: { title: "List tasks", readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "A task id, for details and recent runs." } },
    additionalProperties: false,
  },
  async execute(input) {
    if (input.id) {
      const task = await getTask(input.id);
      if (!task) return `(no task with id "${input.id.slice(0, 80)}")`;
      const runs = (await listRuns(task)).slice(0, 5);
      const lines = [describeTask(task), `  instruction: ${task.instruction}`];
      if (task.trigger) lines.push(`  trigger: ${JSON.stringify(task.trigger)}`);
      if (task.envelope?.tools) lines.push(`  tools: ${task.envelope.tools.join(", ")}`);
      for (const run of runs) {
        const at = new Date(run.startedAt).toISOString().slice(0, 16).replace("T", " ");
        const note = run.summary ?? run.error ?? "";
        lines.push(
          `  run ${at} — ${run.state}${run.stopReason ? ` (${run.stopReason})` : ""}${note ? `: ${note.slice(0, 200)}` : ""}`,
        );
      }
      if (runs.length === 0) lines.push("  (no runs yet)");
      return lines.join("\n");
    }
    const tasks = await listTasks();
    if (tasks.length === 0) return "(no tasks)";
    return `${tasks.length} task(s):\n${tasks.map(describeTask).join("\n")}`;
  },
};
