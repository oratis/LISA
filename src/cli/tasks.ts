/**
 * `lisa tasks` — the Task Engine from the terminal.
 *
 *   lisa tasks [list]        Every task: state, schedule, next and last run
 *   lisa tasks show <id>     One task, its instruction and recent runs
 *   lisa tasks enable <id>   Turn a task on (this is the user's confirmation)
 *   lisa tasks disable <id>  Turn it off
 *   lisa tasks rm <id>       Remove a task and its run history
 *   lisa tasks run <id>      Run it once, now, and print the result
 *   lisa tasks migrate-heartbeat [--dry-run]
 *                            Move heartbeat.json chores into routines (never automatic)
 *
 * Everything except `run` only touches the store, so it works while the web
 * server is running (per-task file locks) and needs no model. `run` needs the
 * assembled toolset and is dispatched from cli.ts after tools are built; it
 * takes the same lease as the server, so it never doubles a run in flight.
 *
 * Ids may be abbreviated to any unique prefix.
 */
import { isCloud } from "../edition.js";
import { describeMigration, migrateHeartbeatTasks } from "../tasks/heartbeat-migration.js";
import { disableTask, enableTask } from "../tasks/lifecycle.js";
import type { TaskRunner } from "../tasks/runner.js";
import { removeTask } from "../tasks/removal.js";
import { getTask, listRuns, listTasks, loadRun, updateTask } from "../tasks/store.js";
import { tokensSpent, type Task } from "../tasks/types.js";

const USAGE =
  "usage: lisa tasks [list]\n" +
  "       lisa tasks show <id>\n" +
  "       lisa tasks run <id>\n" +
  "       lisa tasks enable <id>\n" +
  "       lisa tasks disable <id>\n" +
  "       lisa tasks rm <id>\n" +
  "       lisa tasks migrate-heartbeat [--dry-run]";

type Out = (line: string) => void;

function when(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function cadence(task: Task): string {
  if (task.schedule) return task.schedule.expr + (task.schedule.tz ? ` (${task.schedule.tz})` : "");
  if (task.trigger) return `watch ${task.trigger.kind} ${task.trigger.every ?? "every:30m"}`;
  return "once";
}

function line(task: Task): string {
  const status = task.enabled ? task.state : `${task.state}, off`;
  return (
    `${task.id}  ${task.kind.padEnd(7)}  ${status.padEnd(16)}  ${task.title}\n` +
    `    ${cadence(task)} · next ${when(task.nextRunAt)} · last ${when(task.lastRunAt)}`
  );
}

/** Resolve an id or unique prefix. */
async function resolve(idOrPrefix: string | undefined, err: Out): Promise<Task | null> {
  if (!idOrPrefix) {
    err(USAGE);
    return null;
  }
  const exact = await getTask(idOrPrefix);
  if (exact) return exact;
  const matches = (await listTasks()).filter((t) => t.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0]!;
  err(
    matches.length === 0
      ? `no task matches "${idOrPrefix}"`
      : `"${idOrPrefix}" is ambiguous (${matches.length} tasks)`,
  );
  return null;
}

export async function runTasksCommand(
  args: string[],
  io: { out?: Out; err?: Out; now?: () => number } = {},
): Promise<number> {
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  const now = io.now ?? Date.now;
  const [sub = "list", id] = args;

  if (sub === "list") {
    const tasks = await listTasks();
    if (tasks.length === 0) {
      out("(no tasks — ask Lisa to set one up, or POST /api/tasks)");
      return 0;
    }
    for (const task of tasks) out(line(task));
    return 0;
  }

  if (sub === "show") {
    const task = await resolve(id, err);
    if (!task) return 2;
    out(line(task));
    out(`    notify ${task.notify} · host ${task.host} · origin ${task.origin.kind}`);
    out(
      `    budget ${task.budget.tokens} tokens, ${Math.round(task.budget.wallclockMs / 60_000)} min, ` +
        `${task.budget.maxToolCalls} tool calls`,
    );
    if (task.envelope?.tools) out(`    tools: ${task.envelope.tools.join(", ")}`);
    if (task.trigger) out(`    trigger: ${JSON.stringify(task.trigger)}`);
    out(`\n${task.instruction}\n`);
    const runs = (await listRuns(task)).slice(0, 10);
    if (runs.length === 0) out("(no runs yet)");
    for (const run of runs) {
      const cost = run.costMicros ? ` · $${(run.costMicros / 1_000_000).toFixed(4)}` : "";
      out(
        `${when(run.startedAt)}  ${run.state}${run.stopReason ? ` (${run.stopReason})` : ""} · ` +
          `${tokensSpent(run)} tokens · ${run.toolCalls} tool calls${cost}`,
      );
      const note = run.summary ?? run.error;
      if (note) out(`    ${note.replace(/\s+/g, " ").slice(0, 240)}`);
    }
    return 0;
  }

  if (sub === "enable" || sub === "disable") {
    const task = await resolve(id, err);
    if (!task) return 2;
    const updated = await updateTask(
      task.id,
      (t) => (sub === "enable" ? enableTask(t, now()) : disableTask(t)),
      now(),
    );
    if (!updated) return 2;
    if (sub === "disable") out(`"${updated.title}" is off.`);
    else if (updated.nextRunAt !== undefined)
      out(`"${updated.title}" is on — next run ${when(updated.nextRunAt)}.`);
    else out(`"${updated.title}" is on.`);
    if (sub === "enable" && isCloud())
      err("(hosted edition: tasks run only while LISA_CLOUD_TASKS=1)");
    return 0;
  }

  if (sub === "rm") {
    const task = await resolve(id, err);
    if (!task) return 2;
    // A run in flight (here it can only be in another process, e.g. the web
    // server) is asked to stop and waited for before the files go.
    const { waited, stillRunning } = await removeTask(task.id, { now });
    out(`removed "${task.title}" (${task.id})`);
    if (stillRunning) err("(a run was still in flight; it stops at its next step)");
    else if (waited) err("(waited for its run to stop)");
    return 0;
  }

  if (sub === "migrate-heartbeat") {
    const dryRun = args.includes("--dry-run");
    let result: Awaited<ReturnType<typeof migrateHeartbeatTasks>>;
    try {
      result = await migrateHeartbeatTasks({ dryRun, now: now() });
    } catch (e) {
      err(`migrate-heartbeat: ${(e as Error).message}`);
      err(
        "Every chore still runs exactly one way — from heartbeat.json or as its routine. " +
          "Run the command again to finish.",
      );
      return 1;
    }
    for (const l of describeMigration(result)) out(l);
    return 0;
  }

  if (sub === "run") {
    err("lisa tasks run needs the toolset — this is a bug in the CLI dispatch");
    return 2;
  }

  err(USAGE);
  return 2;
}

/** `lisa tasks run <id>` — called from cli.ts once the toolset exists. */
export async function runTaskNow(
  idOrPrefix: string | undefined,
  runner: TaskRunner,
  io: { out?: Out; err?: Out } = {},
): Promise<number> {
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  const task = await resolve(idOrPrefix, err);
  if (!task) return 2;
  const queued = await runner.runNow(task.id);
  if (!queued.ok) {
    err(
      queued.reason === "already_running"
        ? `"${task.title}" is already running (the web server may have it).`
        : `cannot run "${task.title}": ${queued.reason}`,
    );
    return 1;
  }
  await runner.drain();
  const after = await getTask(task.id);
  const runId = after?.runs.at(-1);
  const run = runId ? (await loadRun(task.id, runId))?.run : undefined;
  if (!run || (run.state !== "succeeded" && run.state !== "failed" && run.state !== "cancelled")) {
    err(`"${task.title}" did not start — another process holds it. Try again in a moment.`);
    return 1;
  }
  err(
    `[${run.state}${run.stopReason ? ` · ${run.stopReason}` : ""}] ${tokensSpent(run)} tokens, ${run.toolCalls} tool calls`,
  );
  if (run.summary) out(run.summary);
  if (run.error) err(run.error);
  return run.state === "succeeded" ? 0 : 1;
}
