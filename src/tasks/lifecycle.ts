/**
 * Task state transitions that more than one caller needs (the API, the tools,
 * the CLI and the runner): enabling, disabling, and working out when a task
 * runs next. Pure functions over a Task — the caller persists the result.
 */
import {
  everyIntervalMs,
  firstRun,
  isOneShot,
  MIN_EVERY_MS_CLOUD,
  MIN_EVERY_MS_LOCAL,
  nextRun,
} from "./schedule.js";
import type { Task, TaskState } from "./types.js";

export const DEFAULT_WATCH_EVERY = "every:30m";

/** Does the task keep running on its own after a run finishes? */
export function isRecurring(task: Task): boolean {
  if (task.kind === "watcher" && task.trigger) return true;
  return !!task.schedule && !isOneShot(task.schedule);
}

/** Poll interval of a watcher, clamped to the edition's floor. */
export function watchIntervalMs(task: Task, cloud = false): number {
  const floor = cloud ? MIN_EVERY_MS_CLOUD : MIN_EVERY_MS_LOCAL;
  const parsed = everyIntervalMs(task.trigger?.every ?? DEFAULT_WATCH_EVERY) ?? 30 * 60_000;
  return Math.max(floor, parsed);
}

/** When the task should next run, measured from `from`; undefined when it will not. */
export function nextRunAfter(task: Task, from: number, cloud = false): number | undefined {
  if (task.kind === "watcher" && task.trigger) {
    // A failing watcher backs off (doubling, capped at 6 h) instead of hammering the site.
    const failures = Math.min(task.watch?.failures ?? 0, 6);
    return from + Math.min(6 * 3_600_000, watchIntervalMs(task, cloud) * 2 ** failures);
  }
  if (!task.schedule) return undefined;
  const every = everyIntervalMs(task.schedule.expr);
  if (every !== null && task.nextRunAt !== undefined) {
    // An interval keeps its PHASE: the next slot is counted from the slot that
    // was due, not from when the run happened to finish. Otherwise a task
    // driven by the 30-minute launchd wake-up — which arrives a moment before
    // "finish + 30 min" — would run only every other wake-up.
    if (task.nextRunAt > from) return task.nextRunAt; // not due yet (a manual run): unchanged
    const slots = Math.floor((from - task.nextRunAt) / every) + 1; // skips missed slots: no catch-up burst
    return task.nextRunAt + slots * every;
  }
  return nextRun(task.schedule, from) ?? undefined;
}

/** Where a task sits when nothing is running or queued. */
export function restingState(task: Task): TaskState {
  if (!task.enabled) return task.enabledAt === undefined ? "draft" : "paused";
  return "scheduled";
}

/**
 * Turn a task on. A scheduled task waits for its first occurrence; a watcher
 * polls at the next tick; a task with neither runs once, now.
 */
export function enableTask(task: Task, now: number): void {
  task.enabled = true;
  task.enabledAt = now;
  delete task.pausedReason;
  task.authFailureCount = 0;
  task.failureCount = 0;
  delete task.cancelRequestedAt;
  if (task.activeRunId) return; // a run is in flight — it will reschedule itself when it ends
  if (task.kind === "watcher" && task.trigger) {
    task.state = "scheduled";
    task.nextRunAt = now;
  } else if (task.schedule) {
    const at = firstRun(task.schedule, now);
    task.state = "scheduled";
    if (at === null) delete task.nextRunAt;
    else task.nextRunAt = at;
  } else {
    task.state = "queued";
    task.nextRunAt = now;
  }
}

/**
 * The engine switches a task off by itself, with a reason the user can read.
 * It stays off until the user enables it again — nothing retries on its own.
 */
export function pauseTask(task: Task, reason: string): void {
  task.enabled = false;
  task.state = "paused";
  task.pausedReason = reason.slice(0, 300);
  delete task.nextRunAt;
  delete task.queued;
}

/** Turn a task off. A run already in flight is left to finish; nothing new starts. */
export function disableTask(task: Task): void {
  task.enabled = false;
  delete task.queued;
  if (task.activeRunId) return;
  task.state = "paused";
  delete task.nextRunAt;
}
