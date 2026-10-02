/**
 * How the runner gets driven.
 *
 *   serve --web        startTaskScheduler(): one pass at startup (which is what
 *                      resumes runs a previous process left behind), then a
 *                      pass every 30 s.
 *   lisa heartbeat run runDueTasksOnce(): launchd wakes the CLI every 30 min;
 *                      it runs whatever is due and exits. Same runner, same
 *                      lease — if the web server is up and already on a task,
 *                      this process skips it.
 *   lisa tasks run     runDueTasksOnce() restricted to one task.
 */
import { buildSystemPromptSnapshot } from "../prompt.js";
import { TaskRunner, type TaskRunnerOptions } from "./runner.js";
import { checkWatcher } from "./watchers.js";

export const TASK_TICK_MS = 30_000;

/**
 * A TaskRunner with the production defaults filled in: Lisa's real system
 * prompt for the working directory and the real watcher checks. Callers supply
 * tools, model and wiring.
 */
export function createTaskRunner(opts: TaskRunnerOptions): TaskRunner {
  return new TaskRunner({
    buildSystemPrompt: async () => (await buildSystemPromptSnapshot({ cwd: opts.cwd })).text,
    checkWatch: checkWatcher,
    ...opts,
  });
}

export interface TaskSchedulerHandle {
  /** Stop ticking and abort runs in flight (they stay resumable). */
  stop(): Promise<void>;
}

export function startTaskScheduler(
  runner: TaskRunner,
  opts: { intervalMs?: number; log?: (msg: string) => void } = {},
): TaskSchedulerHandle {
  const log = opts.log ?? (() => {});
  let ticking = false;
  const tick = (): void => {
    if (ticking) return; // a slow pass (large home, slow disk) never stacks
    ticking = true;
    void runner
      .tick()
      .then(({ started }) => {
        if (started.length) log(`[tasks] started ${started.length} run(s)`);
      })
      .catch((err) => log(`[tasks] tick failed: ${(err as Error).message}`))
      .finally(() => {
        ticking = false;
      });
  };
  const timer = setInterval(tick, opts.intervalMs ?? TASK_TICK_MS);
  timer.unref?.();
  // First pass shortly after start, off the startup path.
  const kick = setTimeout(tick, 1_000);
  kick.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      clearTimeout(kick);
      await runner.stop();
    },
  };
}

/**
 * Run everything that is due right now and wait for it to finish — for
 * short-lived processes. Keeps ticking until nothing more starts (a finished
 * run can free a slot for the next due task) or the deadline passes.
 */
export async function runDueTasksOnce(
  runner: TaskRunner,
  opts: { signal?: AbortSignal; maxMs?: number; now?: () => number } = {},
): Promise<{ started: string[] }> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.maxMs ?? 25 * 60_000);
  const started: string[] = [];
  // A task may legitimately start more than once in a pass (a watcher hit
  // queues its instruction), but never without bound.
  const starts = new Map<string, number>();
  const onAbort = (): void => void runner.stop();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (opts.signal?.aborted || now() >= deadline) break;
      const pass = await runner.tick();
      if (pass.started.length === 0 && runner.activeCount === 0) break;
      started.push(...pass.started);
      await runner.drain();
      let progressed = pass.started.length === 0;
      for (const id of pass.started) {
        const n = (starts.get(id) ?? 0) + 1;
        starts.set(id, n);
        if (n <= 3) progressed = true;
      }
      if (!progressed) break;
    }
    await runner.drain();
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  return { started };
}
