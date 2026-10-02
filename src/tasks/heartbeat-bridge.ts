/**
 * The Task Engine as `lisa heartbeat run` drives it.
 *
 * launchd wakes the heartbeat CLI every 30 minutes whether or not the web
 * server is up. This is what makes tasks run in that case: whatever is due
 * runs through the same runner and the same per-task lease the server uses, so
 * a task the server is already on is simply skipped here.
 *
 * heartbeat.json is NOT touched here. Its chores keep running from the
 * heartbeat as they always have; moving one into the engine is the user's
 * explicit `lisa tasks migrate-heartbeat`.
 *
 * Results are returned for heartbeat.log (as before) AND go through the
 * outbox. This process has no conversation to deliver into, so notices wait
 * there until the web server's next tick delivers them.
 */
import { logInfo } from "../log.js";
import type { ToolDefinition } from "../types.js";
import { isNoUpdate } from "./frame.js";
import type { TaskRunner, TaskRunnerOptions } from "./runner.js";
import { createTaskRunner, runDueTasksOnce } from "./scheduler.js";
import { getTask, listTasks, loadRun } from "./store.js";

export interface HeartbeatTaskResult {
  task: string;
  output: string;
  silent: boolean;
}

export async function runTasksFromHeartbeat(opts: {
  tools: ToolDefinition[];
  cwd: string;
  signal: AbortSignal;
  model: string;
  /** `lisa heartbeat run <name>`: run only the task with this title. */
  taskFilter?: string;
  /** Test seam. */
  runnerOptions?: Partial<TaskRunnerOptions>;
  log?: (msg: string) => void;
}): Promise<HeartbeatTaskResult[]> {
  const log = opts.log ?? logInfo;
  const runner: TaskRunner = createTaskRunner({
    tools: opts.tools,
    model: opts.model,
    cwd: opts.cwd,
    host: "home",
    log,
    ...opts.runnerOptions,
  });

  let started: string[];
  if (opts.taskFilter) {
    const match = (await listTasks()).find((t) => t.title === opts.taskFilter);
    if (!match) return [];
    const onAbort = (): void => void runner.stop();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const queued = await runner.runNow(match.id);
      if (!queued.ok) {
        log(`[tasks] "${match.title}" not run: ${queued.reason}`);
        return [];
      }
      await runner.drain();
      started = [match.id];
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
  } else {
    started = (await runDueTasksOnce(runner, { signal: opts.signal })).started;
  }

  const results: HeartbeatTaskResult[] = [];
  for (const id of new Set(started)) {
    const task = await getTask(id);
    const runId = task?.runs.at(-1);
    const run = task && runId ? (await loadRun(id, runId))?.run : undefined;
    if (!task || !run) continue; // e.g. a quiet watcher poll leaves no run
    const output = run.summary ?? (run.error ? `(${run.state}: ${run.error})` : "");
    results.push({
      task: `task:${task.title}`,
      output,
      silent: run.state === "succeeded" ? isNoUpdate(output) : run.state === "cancelled",
    });
  }
  return results;
}
