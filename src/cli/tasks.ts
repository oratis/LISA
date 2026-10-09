/**
 * `lisa tasks` — the Task Engine from the terminal.
 *
 *   lisa tasks [list]        Every task: state, schedule, next and last run
 *   lisa tasks show <id>     One task, its instruction and recent runs
 *   lisa tasks enable <id> [--confirm <digest>]
 *                            Turn a task on. It shows what the task does and
 *                            what it would do without asking; on a terminal
 *                            it asks whether to pre-approve that, elsewhere
 *                            `--confirm <digest>` (from `show`) does. Without
 *                            a confirmation the envelope only restricts.
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
import readline from "node:readline/promises";
import { isCloud } from "../edition.js";
import { lisaHome, scopedUid } from "../paths.js";
import { revokeGrantsOfRemovedTask } from "../warden/task-approval.js";
import {
  confirmationKey,
  confirmTask,
  describeForConfirmation,
  envelopeCouldPreapprove,
  isEnvelopeConfirmed,
  taskDigest,
} from "../tasks/confirmation.js";
import { describeMigration, migrateHeartbeatTasks } from "../tasks/heartbeat-migration.js";
import { envelopeProblem } from "../tasks/envelope.js";
import { disableTask, enableTask } from "../tasks/lifecycle.js";
import type { TaskRunner } from "../tasks/runner.js";
import { removeTask } from "../tasks/removal.js";
import { getTask, listRuns, listTasks, loadRun, updateTask } from "../tasks/store.js";
import {
  DEFAULT_APPROVAL_WAIT_MS,
  DEFAULT_MAX_APPROVALS,
  tokensSpent,
  type Task,
} from "../tasks/types.js";
import { visible } from "../tasks/visible.js";

const USAGE =
  "usage: lisa tasks [list]\n" +
  "       lisa tasks show <id>\n" +
  "       lisa tasks run <id>\n" +
  "       lisa tasks enable <id> [--confirm <digest>]\n" +
  "       lisa tasks disable <id>\n" +
  "       lisa tasks rm <id>\n" +
  "       lisa tasks migrate-heartbeat [--dry-run]";

type Out = (line: string) => void;

function when(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function cadence(task: Task): string {
  if (task.schedule) {
    return visible(task.schedule.expr + (task.schedule.tz ? ` (${task.schedule.tz})` : ""));
  }
  if (task.trigger)
    return visible(`watch ${task.trigger.kind} ${task.trigger.every ?? "every:30m"}`);
  return "once";
}

/** A task's title on one line, as it is: nothing in it can redraw the screen (#422 review NEW-1). */
function titleOf(task: Pick<Task, "title">): string {
  return visible(task.title);
}

function line(task: Task): string {
  const status = task.enabled ? task.state : `${task.state}, off`;
  return (
    `${task.id}  ${task.kind.padEnd(7)}  ${status.padEnd(16)}  ${titleOf(task)}\n` +
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

/** `--confirm <digest>` (or `--confirm=<digest>`), and the positional arguments without it. */
function splitConfirm(args: string[]): { positional: string[]; confirm?: string } {
  const positional: string[] = [];
  let confirm: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--confirm") confirm = args[++i] ?? "";
    else if (arg.startsWith("--confirm=")) confirm = arg.slice("--confirm=".length);
    else positional.push(arg);
  }
  return { positional, ...(confirm !== undefined ? { confirm } : {}) };
}

async function askOnTerminal(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export interface TasksCommandIo {
  out?: Out;
  err?: Out;
  now?: () => number;
  /** A person at a terminal can answer a question. Default: stdin and stdout are TTYs. */
  interactive?: boolean;
  /** Ask that person a question (tests). Default: readline on stdin. */
  ask?: (question: string) => Promise<string>;
  /** Terminal height, for paging what is being confirmed. Default: stdout's rows. */
  rows?: number;
}

export async function runTasksCommand(args: string[], io: TasksCommandIo = {}): Promise<number> {
  // Everything printed passes through visible(): a task's text (its title,
  // instruction, envelope, a run's summary) may hold control, bidi or
  // invisible characters, and none of them may reach the terminal raw — not
  // only in the lines being confirmed (#422 review NEW-1). Line breaks this
  // command prints itself are kept; text quoted from a task escapes its own.
  const rawOut = io.out ?? ((l: string) => console.log(l));
  const rawErr = io.err ?? ((l: string) => console.error(l));
  const out: Out = (l) => rawOut(visible(l, { newlines: true }));
  const err: Out = (l) => rawErr(visible(l, { newlines: true }));
  const now = io.now ?? Date.now;
  const { positional, confirm } = splitConfirm(args);
  const [sub = "list", id] = positional;
  if (confirm !== undefined && sub !== "enable") {
    err("--confirm is an option of `lisa tasks enable`");
    return 2;
  }

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
    out(`    notify ${task.notify} · host ${task.host} · origin ${visible(task.origin.kind)}`);
    out(
      `    budget ${task.budget.tokens} tokens, ${Math.round(task.budget.wallclockMs / 60_000)} min, ` +
        `${task.budget.maxToolCalls} tool calls; at most ` +
        `${task.budget.maxApprovals ?? DEFAULT_MAX_APPROVALS} approvals and ` +
        `${Math.round((task.budget.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS) / 60_000)} min waiting for them`,
    );
    if (task.pausedReason) out(`    switched off: ${visible(task.pausedReason)}`);
    if (task.envelope?.tools) out(`    tools: ${visible(task.envelope.tools.join(", "))}`);
    if (task.trigger) out(`    trigger: ${visible(JSON.stringify(task.trigger))}`);
    out(`\n${visible(task.instruction, { newlines: true })}\n`);
    const confirmedNow = isEnvelopeConfirmed(task, await confirmationKey());
    out(
      confirmedNow
        ? `Confirmed ${when(task.envelopeConfirmation!.at)} (${task.envelopeConfirmation!.via}):`
        : envelopeCouldPreapprove(task)
          ? "Not confirmed — its envelope only restricts, every action with a side effect asks:"
          : "What it does:",
    );
    for (const l of describeForConfirmation(task)) out(`  ${l}`);
    out(`digest ${taskDigest(task)}`);
    if (envelopeCouldPreapprove(task) && !confirmedNow) {
      out(`(to pre-approve: lisa tasks enable ${task.id} --confirm ${taskDigest(task)})`);
    }
    out("");
    const runs = (await listRuns(task)).slice(0, 10);
    if (runs.length === 0) out("(no runs yet)");
    for (const run of runs) {
      const cost = run.costMicros ? ` · $${(run.costMicros / 1_000_000).toFixed(4)}` : "";
      out(
        `${when(run.startedAt)}  ${run.state}${run.stopReason ? ` (${run.stopReason})` : ""} · ` +
          `${tokensSpent(run)} tokens · ${run.toolCalls} tool calls${cost}`,
      );
      const note = run.summary ?? run.error;
      if (note) out(`    ${visible(note.replace(/\s+/g, " ").slice(0, 240))}`);
    }
    return 0;
  }

  if (sub === "disable") {
    const task = await resolve(id, err);
    if (!task) return 2;
    const updated = await updateTask(task.id, (t) => disableTask(t), now());
    if (!updated) return 2;
    out(`"${titleOf(updated)}" is off.`);
    return 0;
  }

  if (sub === "enable") {
    const task = await resolve(id, err);
    if (!task) return 2;
    // An envelope that cannot be shown as it is cannot be confirmed — or
    // switched on (#422 review NEW-1).
    const envelopeIssue = envelopeProblem(task.envelope);
    if (envelopeIssue) {
      err(
        `this task's ${envelopeIssue}. Nothing was changed; ` +
          "fix or remove its envelope (PATCH /api/tasks/{id}) or remove the task.",
      );
      return 2;
    }
    // What the user is confirming, in plain words, before anything changes —
    // all of it: on a terminal it is paged, never cut (#422 review N6).
    const digest = taskDigest(task);
    const preapproves = envelopeCouldPreapprove(task);
    const interactive = io.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
    const ask = io.ask ?? askOnTerminal;
    const screen = [`(${task.id})`, ...describeForConfirmation(task).map((l) => `  ${l}`)];
    if (interactive && preapproves && confirm === undefined) {
      const page = Math.max(5, (io.rows ?? process.stdout.rows ?? 24) - 2);
      for (let at = 0; at < screen.length; at += page) {
        for (const l of screen.slice(at, at + page)) out(l);
        const shown = Math.min(at + page, screen.length);
        if (shown >= screen.length) break;
        const more = await ask(
          `-- ${shown}/${screen.length} lines; Enter for more, q to stop (nothing is changed) -- `,
        );
        if (/^\s*q/i.test(more)) {
          err("Stopped before the end of what it would do. Nothing was changed.");
          return 1;
        }
      }
    } else {
      for (const l of screen) out(l);
    }
    let confirmed = false;
    if (confirm !== undefined) {
      if (confirm !== digest) {
        err(
          "the task is not what that digest describes (it changed, or the digest is wrong). " +
            `Nothing was changed. Check it again with \`lisa tasks show ${task.id}\`.`,
        );
        return 2;
      }
      confirmed = preapproves;
    } else if (preapproves && interactive) {
      const answer = await ask(
        "Let it do these without asking? [y/N] (no: it is switched on and asks first) ",
      );
      confirmed = /^\s*y(es)?\s*$/i.test(answer);
    }
    // The key a confirmation is signed with (made on the first one).
    const signing = confirmed ? await confirmationKey({ create: true }) : null;
    let changed = false;
    const updated = await updateTask(
      task.id,
      (t) => {
        // Under the lock: the task must still be the one that was shown.
        if (taskDigest(t) !== digest || envelopeProblem(t.envelope)) {
          changed = true;
          return false;
        }
        enableTask(t, now());
        if (signing) confirmTask(t, now(), "cli", signing);
        return;
      },
      now(),
    );
    if (!updated) return 2;
    if (changed) {
      err(
        "the task changed while you were looking at it. Nothing was changed; run the command again.",
      );
      return 2;
    }
    out(
      updated.nextRunAt !== undefined
        ? `"${titleOf(updated)}" is on — next run ${when(updated.nextRunAt)}.`
        : `"${titleOf(updated)}" is on.`,
    );
    if (confirmed) out("Its envelope is confirmed: the actions above run without asking.");
    else if (preapproves) {
      out(
        "Its envelope is NOT confirmed: it only restricts, and every action with a side effect asks first.",
      );
      out(`To pre-approve it: lisa tasks enable ${updated.id} --confirm ${digest}`);
    }
    if (isCloud()) err("(hosted edition: tasks run only while LISA_CLOUD_TASKS=1)");
    return 0;
  }

  if (sub === "rm") {
    const task = await resolve(id, err);
    if (!task) return 2;
    // A run in flight (here it can only be in another process, e.g. the web
    // server) is asked to stop and waited for before the files go.
    const { waited, stillRunning } = await removeTask(task.id, { now });
    // No runner (or Warden factory) here: end the task's grants directly.
    await revokeGrantsOfRemovedTask({ taskId: task.id, uid: scopedUid(), home: lisaHome() }, now);
    out(`removed "${titleOf(task)}" (${task.id})`);
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
  // A run's summary is model text that may quote a page: shown as it is (#422 review NEW-1).
  const rawOut = io.out ?? ((l: string) => console.log(l));
  const rawErr = io.err ?? ((l: string) => console.error(l));
  const out: Out = (l) => rawOut(visible(l, { newlines: true }));
  const err: Out = (l) => rawErr(visible(l, { newlines: true }));
  const task = await resolve(idOrPrefix, err);
  if (!task) return 2;
  const queued = await runner.runNow(task.id);
  if (!queued.ok) {
    err(
      queued.reason === "already_running"
        ? `"${titleOf(task)}" is already running (the web server may have it).`
        : `cannot run "${titleOf(task)}": ${queued.reason}`,
    );
    return 1;
  }
  await runner.drain();
  const after = await getTask(task.id);
  const runId = after?.runs.at(-1);
  const run = runId ? (await loadRun(task.id, runId))?.run : undefined;
  if (!run || (run.state !== "succeeded" && run.state !== "failed" && run.state !== "cancelled")) {
    err(`"${titleOf(task)}" did not start — another process holds it. Try again in a moment.`);
    return 1;
  }
  err(
    `[${run.state}${run.stopReason ? ` · ${run.stopReason}` : ""}] ${tokensSpent(run)} tokens, ${run.toolCalls} tool calls`,
  );
  if (run.summary) out(run.summary);
  if (run.error) err(run.error);
  return run.state === "succeeded" ? 0 : 1;
}
