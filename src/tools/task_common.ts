/**
 * Shared pieces of the task tools (task_create / task_list / task_update /
 * task_cancel / watch_create).
 *
 * The rule all five follow: the model may DESCRIBE unattended work, never
 * switch it on, and never pre-approve anything. Whatever a tool creates or
 * edits ends up disabled and unconfirmed (an edit clears an earlier
 * confirmation, validate.ts); turning it on, and confirming what it may do
 * without asking, is the user's act, through the app or `lisa tasks enable`
 * (src/tasks/confirmation.ts). There is no model-reachable path around it.
 */
import { isCloud } from "../edition.js";
import { scopedUid } from "../paths.js";
import { nextRunAfter } from "../tasks/lifecycle.js";
import { listTasks } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";
import { emitTaskEvent } from "../tasks/wiring.js";

/** Mirrors the API's per-tenant ceiling (web/tasks-api.ts MAX_TASKS). */
export const MAX_TASKS_FROM_TOOLS = 200;

export function toolContext(): { cloud: boolean; owner: string | null } {
  return { cloud: isCloud(), owner: scopedUid() };
}

export async function atTaskLimit(): Promise<boolean> {
  return (await listTasks()).length >= MAX_TASKS_FROM_TOOLS;
}

export function announce(task: Task): void {
  emitTaskEvent({ type: "task_updated", task });
}

function when(ms: number | undefined): string {
  return ms === undefined
    ? "—"
    : new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** One line per task, for listings. */
export function describeTask(task: Task): string {
  const cadence = task.schedule?.expr ?? (task.trigger ? `watch ${task.trigger.kind}` : "once");
  const status = task.enabled ? task.state : `${task.state}, OFF`;
  return `• ${task.id}  [${task.kind} · ${status}]  ${task.title}  (${cadence}; next ${when(task.nextRunAt)}; last ${when(task.lastRunAt)})`;
}

/** The confirmation card a create/update tool returns to the model. */
export function confirmationCard(task: Task, verb: "Created" | "Updated"): string {
  const lines = [`${verb} ${task.kind} "${task.title}" (id ${task.id}). It is OFF.`];
  if (task.schedule) {
    const first = nextRunAfter({ ...task, enabled: true }, Date.now(), isCloud());
    lines.push(
      `Schedule: ${task.schedule.expr}${task.schedule.tz ? ` (${task.schedule.tz})` : ""}` +
        (first !== undefined ? ` — once on, first run ${when(first)}` : ""),
    );
  }
  if (task.trigger) {
    const t = task.trigger;
    const target = t.kind === "mail" ? [t.from, t.subject].filter(Boolean).join(" / ") : t.url;
    lines.push(
      `Watches: ${t.kind} ${target} — every ${(t.every ?? "every:30m").replace("every:", "")}, on hit: ${t.onHit ?? "notify"}`,
    );
  }
  lines.push(
    `Does: ${task.instruction.length > 300 ? `${task.instruction.slice(0, 297)}…` : task.instruction}`,
  );
  lines.push(
    `Notify: ${task.notify}. Budget per run: ${task.budget.tokens} tokens, ${Math.round(task.budget.wallclockMs / 60_000)} min, ${task.budget.maxToolCalls} tool calls.`,
  );
  if (task.envelope?.tools) lines.push(`May only use: ${task.envelope.tools.join(", ")}.`);
  lines.push(
    `Nothing runs until the user turns it on — in the Tasks view, or with \`lisa tasks enable ${task.id}\`. ` +
      `You cannot enable it yourself, and nothing you set here is pre-approved: when they turn it on ` +
      `they decide whether its actions may run without asking. Tell the user what you set up and ` +
      `that it is waiting for them.`,
  );
  return lines.join("\n");
}
