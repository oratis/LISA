/**
 * task_create — Lisa drafts a routine, one-off or goal for the user.
 *
 * The task is created DISABLED (state `draft`, createdDisabled). The tool has
 * no parameter that could enable it; the user does that in the app or CLI.
 */
import { createTask } from "../tasks/store.js";
import { parseNewTask } from "../tasks/validate.js";
import type { ToolDefinition } from "../types.js";
import { announce, atTaskLimit, confirmationCard, MAX_TASKS_FROM_TOOLS, toolContext } from "./task_common.js";

interface TaskCreateInput {
  title: string;
  instruction: string;
  kind?: "oneoff" | "routine" | "goal";
  schedule?: string;
  timezone?: string;
  notify?: "always" | "on_change" | "silent_on_noop";
  tools?: string[];
  max_tokens?: number;
  max_minutes?: number;
}

export const taskCreateTool: ToolDefinition<TaskCreateInput, string> = {
  name: "task_create",
  description:
    "Draft a task Lisa will run unattended for the user: a routine (repeats on a schedule), a one-off " +
    "(runs once, optionally at a set time) or a goal. Use when the user asks for something to happen " +
    "later or regularly (\"every weekday at 8 summarise my mail\", \"remind me Friday at 3\"). " +
    "schedule: every:<n>(m|h|d) | daily:HH:MM | weekdays:HH:MM | weekly:<mon..sun>@HH:MM | " +
    "cron:<m h dom mon dow> | at:<ISO-8601>. The task is created OFF — you cannot turn it on; tell the " +
    "user it is waiting for them to enable it. To watch a web page, feed or mailbox for a condition use " +
    "watch_create instead.",
  annotations: { title: "Create task", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200, description: "Short name shown in the Tasks list." },
      instruction: {
        type: "string",
        minLength: 1,
        maxLength: 8000,
        description: "What to do on each run, written so it stands alone (the run will not see this chat).",
      },
      kind: { type: "string", enum: ["oneoff", "routine", "goal"], description: "Default: routine when a repeating schedule is given, else oneoff." },
      schedule: { type: "string", description: "When to run (see the grammar above). Omit for a one-off that runs once enabled." },
      timezone: { type: "string", description: "IANA zone for wall-clock schedules, e.g. Europe/Berlin. Default: the host's zone." },
      notify: {
        type: "string",
        enum: ["always", "on_change", "silent_on_noop"],
        description: "always (default) | on_change: only when the result differs from last time | silent_on_noop: stay quiet when there is nothing to report.",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        maxItems: 64,
        description: "Optional: restrict the run to exactly these tool names.",
      },
      max_tokens: { type: "integer", minimum: 1000, description: "Optional per-run token ceiling." },
      max_minutes: { type: "integer", minimum: 1, maximum: 60, description: "Optional per-run wall-clock ceiling." },
    },
    required: ["title", "instruction"],
    additionalProperties: false,
  },
  async execute(input) {
    const ctx = toolContext();
    const budget: Record<string, number> = {};
    if (input.max_tokens !== undefined) budget.tokens = input.max_tokens;
    if (input.max_minutes !== undefined) budget.wallclockMs = input.max_minutes * 60_000;
    const parsed = parseNewTask(
      {
        title: input.title,
        instruction: input.instruction,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.schedule
          ? { schedule: { expr: input.schedule, ...(input.timezone ? { tz: input.timezone } : {}) } }
          : {}),
        ...(input.notify ? { notify: input.notify } : {}),
        ...(input.tools ? { envelope: { tools: input.tools } } : {}),
        ...(Object.keys(budget).length ? { budget } : {}),
      },
      { cloud: ctx.cloud, origin: { kind: "chat" }, owner: ctx.owner },
    );
    if (!parsed.ok) return `(not created: ${parsed.error})`;
    if (await atTaskLimit()) return `(not created: there are already ${MAX_TASKS_FROM_TOOLS} tasks — remove some first)`;
    // enabled:false + createdDisabled:true are set by parseNewTask/createTask; restated here on purpose.
    const task = await createTask({ ...parsed.value, enabled: false, createdDisabled: true });
    announce(task);
    return confirmationCard(task, "Created");
  },
};
