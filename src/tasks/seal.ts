/**
 * Seals on the run state that reaches a later run's prompt or decides its
 * taint (#422 review, second-round follow-up P1).
 *
 * The confirmation (confirmation.ts) is signed, but it covers only what the
 * user confirmed. What an earlier run left behind is not part of it and
 * changes after every run: the last summary (quoted in the next frame), the
 * flags that say whether that summary or the task's folder came from a
 * tainted run, and on each run record whether the run is tainted. Unsigned, a
 * task file written by anything but the runner could keep a genuine
 * confirmation and put its own words into the next run as Lisa's own note,
 * untainted — so a pre-approved shell ran them.
 *
 * So the runner seals them with the home's Warden key (the key confirmations
 * and approval digests use) whenever it writes them, and checks the seal
 * whenever it reads them. A missing or wrong seal fails closed:
 *
 *   task  the last summary is treated as a tainted run's (quoted as data, the
 *         next run tainted), and the folder as tainted when it holds anything;
 *   run   the run is tainted.
 *
 * Task files from before seals existed have none, so they are treated the
 * same way. The next settle (or run start) writes a seal over the state as it
 * is then — with the fail-closed flags in it, since what was unsealed cannot
 * be told apart from what was planted.
 *
 * Not covered (documented in docs/DESIGN_WARDEN.md): a run's message history,
 * and putting back an older state with the seal it genuinely had (a rollback).
 * Both still need a write to the task files, which always asks.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Task, TaskRun } from "./types.js";

type SealedTaskState = Pick<
  Task,
  "id" | "lastSummary" | "lastSummaryTainted" | "workspaceTainted" | "stateSeal"
>;
type SealedRunTaint = Pick<
  TaskRun,
  "id" | "taskId" | "trigger" | "input" | "tainted" | "inheritedTaint" | "taintSeal"
>;

function mac(key: Buffer, domain: string, content: unknown): string {
  return createHmac("sha256", key)
    .update(`${domain}\n`)
    .update(JSON.stringify(content))
    .digest("hex");
}

function sameMac(stored: unknown, expected: string): boolean {
  if (typeof stored !== "string" || !/^[0-9a-f]{64}$/.test(stored)) return false;
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function taskStateMac(key: Buffer, task: SealedTaskState): string {
  // A fixed key order, so the same state always gives the same MAC.
  return mac(key, "lisa.task-state.v1", {
    taskId: task.id,
    lastSummary: task.lastSummary ?? null,
    lastSummaryTainted: task.lastSummaryTainted === true,
    workspaceTainted: task.workspaceTainted === true,
  });
}

function runTaintMac(key: Buffer, run: SealedRunTaint): string {
  return mac(key, "lisa.task-run-taint.v1", {
    taskId: run.taskId,
    runId: run.id,
    trigger: run.trigger ?? null,
    // The watcher's input taints the run; a hash is enough to bind it.
    input: run.input === undefined ? null : createHash("sha256").update(run.input).digest("hex"),
    tainted: run.tainted === true,
    inheritedTaint: run.inheritedTaint === true,
  });
}

/** True when the task's carried-over state is exactly what the runner sealed. */
export function taskStateSealed(task: SealedTaskState, key: Buffer | null): boolean {
  return !!key && sameMac(task.stateSeal, taskStateMac(key, task));
}

/** Seal the task's carried-over state as it is now. */
export function sealTaskState(task: SealedTaskState, key: Buffer): void {
  task.stateSeal = taskStateMac(key, task);
}

/**
 * What unsealed state means: it may have been written by anyone, so the last
 * summary counts as a tainted run's, and the folder as tainted when it holds
 * anything (a task that never ran has nothing to distrust).
 */
export function distrustTaskState(
  task: Pick<Task, "lastSummary" | "lastSummaryTainted" | "workspaceTainted">,
  opts: { folderHasContent: boolean },
): void {
  if (task.lastSummary) task.lastSummaryTainted = true;
  if (opts.folderHasContent) task.workspaceTainted = true;
}

/** The task as a run may read it: itself when sealed, otherwise a fail-closed copy. */
export function trustedTaskState<T extends Task>(
  task: T,
  key: Buffer | null,
  opts: { folderHasContent: boolean },
): T {
  if (taskStateSealed(task, key)) return task;
  const copy = structuredClone(task);
  distrustTaskState(copy, opts);
  return copy;
}

/**
 * Before a write of the task that the runner seals: unsealed state is made
 * fail-closed first, so the seal never vouches for what was planted.
 */
export function resealTaskState(
  task: Task,
  key: Buffer,
  opts: { folderHasContent: boolean },
): void {
  if (!taskStateSealed(task, key)) distrustTaskState(task, opts);
  sealTaskState(task, key);
}

/** True when the run record's taint is exactly what the runner sealed. */
export function runTaintSealed(run: SealedRunTaint, key: Buffer | null): boolean {
  return !!key && sameMac(run.taintSeal, runTaintMac(key, run));
}

/** Seal the run record's taint as it is now. */
export function sealRunTaint(run: SealedRunTaint, key: Buffer): void {
  run.taintSeal = runTaintMac(key, run);
}

/** A run read from disk: tainted unless its seal says otherwise. */
export function distrustUnsealedRun<T extends SealedRunTaint>(run: T, key: Buffer | null): T {
  if (!runTaintSealed(run, key)) run.tainted = true;
  return run;
}
