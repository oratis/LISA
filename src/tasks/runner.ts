/**
 * Task runner — executes due tasks, durably.
 *
 * One TaskRunner per process (per tenant per sweep on the cloud edition). The
 * same class backs the in-process scheduler in `serve --web`, the launchd
 * heartbeat CLI and `lisa tasks run`, so a task behaves identically whichever
 * of them picks it up — and the per-task lease guarantees only one does.
 *
 * What a run is guaranteed:
 *   lease        one runner at a time, across processes (lease.ts);
 *   checkpoint   the run record is appended after every model call and every
 *                tool call, and every message as soon as it exists;
 *   resume       a run whose holder died is continued — same run id, saved
 *                history, a note telling the model what already happened;
 *   exactly-once a side-effecting call is recorded BEFORE it executes
 *                (in-flight) and AFTER (its result). A resumed run that
 *                re-issues it gets the recorded result, or — when the outcome
 *                is unknown — is told so. It is never executed twice;
 *   budgets      tokens, spend, wall-clock and tool calls each stop the run;
 *   cancel       an AbortSignal in-process, a flag on the task across processes;
 *   approval     from the injected factory; with none wired, side-effecting
 *                calls are denied (policy.ts);
 *   delivery     results go through the outbox (outbox.ts), never directly.
 */
import { randomBytes } from "node:crypto";
import { runAgent, type ApprovalCallback } from "../agent.js";
import { getAutonomyEnabled } from "../autonomy/state.js";
import { costMicroUSD } from "../billing/prices.js";
import { logInfo } from "../log.js";
import { providerForModel } from "../providers/registry.js";
import type { Provider, ProviderUsage } from "../providers/types.js";
import type { SandboxMode } from "../sandbox/mode.js";
import { sandboxModeForProfile } from "../sandbox/sandbox.js";
import { validateToolInput } from "../tools/validate.js";
import type { AgentEvent, StoredMessage, ToolDefinition } from "../types.js";
import {
  buildResumeNote,
  buildTaskFrame,
  isNoUpdate,
  planResume,
  TASK_SYSTEM_ADDENDUM,
} from "./frame.js";
import { acquireTaskLease, DEFAULT_LEASE_TTL_MS, type TaskLease } from "./lease.js";
import { isRecurring, nextRunAfter, pauseTask, restingState } from "./lifecycle.js";
import { drainOutbox, enqueueNotice, noticeId } from "./outbox.js";
import { denySideEffects, digestCall, isSideEffectingCall, taskToolset } from "./policy.js";
import { isOneShot } from "./schedule.js";
import {
  appendRunEvent,
  appendRunMessage,
  checkpointRun,
  createRun,
  getTask,
  listTasks,
  loadRun,
  resetRunMessages,
  updateTask,
  type LoadedRun,
  type RunEvent,
} from "./store.js";
import type {
  Task,
  TaskApprovalFactory,
  TaskDeliver,
  TaskNotice,
  TaskRun,
  TaskRunState,
  WatchState,
} from "./types.js";
import { getDefaultTaskDeliver, getTaskApprovalFactory, getTaskDeliver } from "./wiring.js";

/** Marks a side-effecting call that was started but whose result was never recorded. */
export const IN_FLIGHT = "[in-flight]";

/** A run that keeps getting interrupted is given up rather than resumed forever. */
export const MAX_RESUMES = 3;
/** Automatic retries of a failed scheduled run before the failure is reported. */
export const MAX_RETRIES = 2;
/** Consecutive credential / allowance failures before a task is paused. */
export const MAX_BLOCKED = 3;
/** A one-off this far past its time is expired instead of run. */
export const EXPIRE_ONEOFF_AFTER_MS = 24 * 3_600_000;

const RETRY_BACKOFF_MS = [60_000, 5 * 60_000];
const MAX_RECORDED_RESULT = 8_000;
const MAX_SUMMARY = 8_000;

/**
 * Admission for account-funded inference. The cloud edition wires
 * billing/admission.ts in here; every model call of a run passes through it.
 */
export interface ModelGate {
  admit(model: string): Promise<
    | {
        ok: true;
        /** Price and debit this call's usage. A throw stops the run (fail closed). */
        settle(usage: ProviderUsage): Promise<void>;
        release(): Promise<void>;
      }
    /** `transient`: contention or a rate limit — the run is retried later, not reported. */
    | { ok: false; reason: string; transient?: boolean }
  >;
}

export type TaskEngineEvent =
  | { type: "task_updated"; task: Task }
  | { type: "task_deleted"; taskId: string }
  | { type: "task_run_started"; taskId: string; runId: string; resumed: boolean }
  | {
      type: "task_run_finished";
      taskId: string;
      runId: string;
      state: TaskRunState;
      stopReason?: string;
      summary?: string;
    };

/** What a watcher check found. Implemented in watchers.ts; injectable for tests. */
export interface WatchOutcome {
  /** The watcher's bookkeeping after this check (replaces task.watch). */
  watch: WatchState;
  /** Present when the condition fired. `key` identifies the hit for dedupe. */
  hit?: { key: string; summary: string; detail?: string };
  /** Present when the check itself failed (fetch error, refused URL, …). */
  error?: string;
}

export type WatchCheck = (
  task: Task,
  ctx: { signal: AbortSignal; now: number },
) => Promise<WatchOutcome>;

export interface TaskRunnerOptions {
  /** The surface's capability-profile tools; narrowed per task by its envelope. */
  tools: ToolDefinition[] | (() => ToolDefinition[] | Promise<ToolDefinition[]>);
  model: string | (() => string);
  cwd: string;
  /** Lisa's normal system prompt. The task rules are appended to it. */
  buildSystemPrompt?: () => Promise<string> | string;
  /** Injectable provider (tests); default providerForModel(model). */
  provider?: Provider;
  /** Overrides the process-wide factory from wiring.ts. */
  approvalFactory?: TaskApprovalFactory;
  /** Overrides the process-wide deliver from wiring.ts. */
  deliver?: TaskDeliver;
  /** Cloud billing admission. Unset on the Mac edition (the user's own key). */
  modelGate?: ModelGate;
  /** Which host this runner is: tasks pinned to the other one are skipped. */
  host?: "home" | "cloud";
  /** Max runs in flight in this runner. Default 2 at home, 1 per tenant in the cloud. */
  concurrency?: number;
  /** False pauses scheduled (not manual) runs. Default: the Proactive master switch. */
  unattendedAllowed?: () => boolean;
  checkWatch?: WatchCheck;
  onEvent?: (event: TaskEngineEvent) => void;
  sandboxMode?: SandboxMode;
  leaseTtlMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

type StopReason =
  | "cancelled"
  | "budget_tokens"
  | "budget_usd"
  | "budget_wallclock"
  | "budget_tool_calls"
  | "admission_denied"
  | "settlement_failed";

class TaskStop extends Error {
  constructor(
    readonly stop: StopReason,
    detail?: string,
  ) {
    super(detail ? `${stop}: ${detail}` : stop);
  }
}

/** Thrown out of drive() on shutdown: the run is left resumable, not failed. */
class Interrupted extends Error {
  constructor() {
    super("task run interrupted by shutdown");
  }
}

interface Slot {
  controller: AbortController;
  stop: StopReason | null;
  stopDetail?: string;
}

interface Outcome {
  state: "succeeded" | "failed" | "cancelled";
  stopReason: string;
  summary: string;
  error?: string;
  /** Credential or allowance problem — retrying will not help until the user acts. */
  blocked?: boolean;
  /** Billing refused or could not record the run: the task is switched off at once. */
  pause?: boolean;
}

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function looksLikeAuthFailure(message: string): boolean {
  return /\b(401|403)\b|unauthori[sz]ed|invalid.{0,12}api.?key|authentication|permission.denied|credentials?\b.{0,24}(missing|expired|invalid)/i.test(
    message,
  );
}

export class TaskRunner {
  private readonly opts: TaskRunnerOptions;
  private readonly owner = `${process.pid}-${randomBytes(6).toString("hex")}`;
  private readonly active = new Map<string, Slot>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly host: "home" | "cloud";
  private readonly concurrency: number;
  private stopped = false;

  constructor(opts: TaskRunnerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.host = opts.host ?? "home";
    this.concurrency = opts.concurrency ?? (this.host === "cloud" ? 1 : 2);
  }

  get activeCount(): number {
    return this.active.size;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  private log(msg: string): void {
    (this.opts.log ?? logInfo)(`[tasks] ${msg}`);
  }

  private emit(event: TaskEngineEvent): void {
    try {
      this.opts.onEvent?.(event);
    } catch {
      // A broken subscriber must never affect a run.
    }
  }

  private deliver(): TaskDeliver | undefined {
    return this.opts.deliver ?? getTaskDeliver() ?? getDefaultTaskDeliver();
  }

  // ── scheduling ──

  /** Is there work on this task for this runner at `now`? The lease has the final say. */
  private isDue(task: Task, now: number, unattended: boolean): boolean {
    if (task.host !== "any" && task.host !== this.host) return false;
    // A run in flight belongs to the occurrence that started it: it is always
    // carried to an end, even when the task has since been paused. One that is
    // parked between attempts waits for its retry time (or a cancel).
    if (task.activeRunId) {
      return !!task.cancelRequestedAt || task.resumeAt === undefined || task.resumeAt <= now;
    }
    const due = task.nextRunAt !== undefined && task.nextRunAt <= now;
    if (task.state === "queued") {
      if (task.queued?.manual) return true;
      return unattended && (due || task.nextRunAt === undefined);
    }
    return unattended && task.enabled && task.state === "scheduled" && due;
  }

  /**
   * One scheduler pass: deliver anything left in the outbox, then start every
   * due task up to the concurrency cap. Runs proceed in the background; use
   * drain() to wait for them. Never throws.
   */
  async tick(): Promise<{ started: string[] }> {
    const started: string[] = [];
    if (this.stopped) return { started };
    try {
      await drainOutbox(this.deliver(), this.now());
    } catch (err) {
      this.log(`outbox drain failed: ${(err as Error).message}`);
    }
    let tasks: Task[];
    try {
      tasks = await listTasks();
    } catch (err) {
      this.log(`cannot list tasks: ${(err as Error).message}`);
      return { started };
    }
    const now = this.now();
    const unattended = (this.opts.unattendedAllowed ?? getAutonomyEnabled)();
    const candidates = tasks
      .filter((t) => !this.active.has(t.id) && this.isDue(t, now, unattended))
      // Fair order: interrupted runs first, then whoever has waited longest
      // since their last run — a chatty every:5m task cannot starve the rest.
      .sort(
        (a, b) =>
          Number(!!b.activeRunId) - Number(!!a.activeRunId) ||
          (a.lastRunAt ?? 0) - (b.lastRunAt ?? 0) ||
          (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0),
      );
    for (const task of candidates) {
      if (this.active.size >= this.concurrency) break;
      // A task another process is running is skipped here, without using a slot.
      if (await this.launch(task.id)) started.push(task.id);
    }
    return { started };
  }

  /**
   * Run a task now at the user's request (API "run", `lisa tasks run`). Works
   * on a disabled task — that is the "test run". The run starts immediately if
   * there is capacity, otherwise at the next tick.
   */
  async runNow(
    taskId: string,
    input?: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const task = await getTask(taskId);
    if (!task) return { ok: false, reason: "not_found" };
    if (task.host !== "any" && task.host !== this.host) return { ok: false, reason: "wrong_host" };
    if (this.active.has(taskId) || task.activeRunId)
      return { ok: false, reason: "already_running" };
    const now = this.now();
    const updated = await updateTask(
      taskId,
      (t) => {
        if (t.activeRunId) return false;
        t.state = "queued";
        t.queued = { manual: true, ...(input !== undefined ? { input } : {}) };
        delete t.cancelRequestedAt;
      },
      now,
    );
    if (!updated) return { ok: false, reason: "not_found" };
    this.emit({ type: "task_updated", task: updated });
    if (this.active.size < this.concurrency) await this.launch(taskId);
    return { ok: true };
  }

  /**
   * Ask a task's run to stop. Aborts it when it is running here; otherwise
   * leaves a flag the owning process honours at its next checkpoint. A task
   * that was only queued goes back to rest.
   */
  async cancel(taskId: string): Promise<boolean> {
    const now = this.now();
    let found = false;
    const updated = await updateTask(
      taskId,
      (t) => {
        if (t.activeRunId) {
          t.cancelRequestedAt = now;
          found = true;
          return;
        }
        if (t.state === "queued") {
          delete t.queued;
          t.state = restingState(t);
          if (t.enabled && isRecurring(t))
            t.nextRunAt = nextRunAfter(t, now, this.host === "cloud");
          else delete t.nextRunAt;
          found = true;
          return;
        }
        return false;
      },
      now,
    );
    const slot = this.active.get(taskId);
    if (slot) {
      slot.stop = "cancelled";
      slot.controller.abort();
      found = true;
    }
    if (updated && found) this.emit({ type: "task_updated", task: updated });
    return found;
  }

  /** Resolve when every run this runner started has finished. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Stop taking work and abort what is running (it stays resumable). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const slot of this.active.values()) slot.controller.abort();
    await this.drain();
  }

  /**
   * Take the task's lease and start working on it in the background. False
   * when another runner — in this process or another — already holds it.
   */
  private async launch(taskId: string): Promise<boolean> {
    if (this.active.has(taskId) || this.stopped) return false;
    const slot: Slot = { controller: new AbortController(), stop: null };
    this.active.set(taskId, slot); // reserve the slot before the first await
    let lease: TaskLease | null = null;
    try {
      lease = await acquireTaskLease(taskId, {
        owner: this.owner,
        ttlMs: this.opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
        now: this.now,
      });
    } catch (err) {
      this.log(`cannot take the lease for ${taskId}: ${(err as Error).message}`);
    }
    if (!lease) {
      this.active.delete(taskId);
      return false;
    }
    const held = lease;
    const p = this.runTask(taskId, slot)
      .catch((err) => {
        if (err instanceof Interrupted) return;
        this.log(`task ${taskId} failed outside its run: ${(err as Error).stack ?? String(err)}`);
      })
      .finally(async () => {
        await held.release().catch(() => {});
        this.active.delete(taskId);
        this.inflight.delete(p);
      });
    this.inflight.add(p);
    return true;
  }

  // ── one task, under its lease ──

  private async runTask(taskId: string, slot: Slot): Promise<void> {
    {
      // Everything is re-read under the lease: a peer may have just finished it.
      const task = await getTask(taskId);
      if (!task) return;
      const now = this.now();

      if (task.activeRunId) {
        const loaded = await loadRun(task.id, task.activeRunId);
        if (loaded && (loaded.run.state === "running" || loaded.run.state === "interrupted")) {
          await this.resume(task, loaded, slot);
          return;
        }
        // The pointer outlived its run (finished or lost) — clear it and carry on.
        await updateTask(task.id, (t) => {
          delete t.activeRunId;
          if (t.state === "running") t.state = restingState(t);
        });
        task.activeRunId = undefined;
      }

      const manual = task.state === "queued" && !!task.queued?.manual;
      const unattended = (this.opts.unattendedAllowed ?? getAutonomyEnabled)();
      if (!manual && !this.isDue(task, now, unattended)) return;

      // A one-off whose moment passed long ago is reported, not run.
      if (
        !manual &&
        task.state === "scheduled" &&
        task.schedule &&
        isOneShot(task.schedule) &&
        task.nextRunAt !== undefined &&
        now - task.nextRunAt > EXPIRE_ONEOFF_AFTER_MS
      ) {
        await this.expire(task, now);
        return;
      }

      // A watcher polls its condition — unless a hit already queued the instruction.
      if (task.kind === "watcher" && task.trigger && task.queued?.input === undefined) {
        await this.poll(task, slot);
        return;
      }
      await this.startRun(task, slot, manual);
    }
  }

  private async expire(task: Task, now: number): Promise<void> {
    const run = await createRun(task.id, { state: "failed" }, now);
    run.endedAt = now;
    run.stopReason = "expired";
    run.summary = `This was due at ${new Date(task.nextRunAt!).toISOString()} but LISA was not running then. It was not run.`;
    await checkpointRun(run, now);
    const updated = await updateTask(
      task.id,
      (t) => {
        t.state = "expired";
        delete t.nextRunAt;
      },
      now,
    );
    if (updated) this.emit({ type: "task_updated", task: updated });
    await this.notify(task, run, "task_failed", run.summary, "low");
  }

  private async startRun(task: Task, slot: Slot, manual: boolean): Promise<void> {
    const now = this.now();
    const input = task.queued?.input;
    const run = await createRun(
      task.id,
      { state: "running", ...(input !== undefined ? { input } : {}) },
      now,
    );
    if (manual) run.manual = true;
    const started = await updateTask(
      task.id,
      (t) => {
        t.state = "running";
        t.activeRunId = run.id;
        delete t.queued;
        delete t.cancelRequestedAt;
      },
      now,
    );
    if (!started) return; // deleted under us
    await checkpointRun(run, now);
    this.emit({ type: "task_run_started", taskId: task.id, runId: run.id, resumed: false });
    this.emit({ type: "task_updated", task: started });
    const outcome = await this.drive(started, run, [], buildTaskFrame(task, run, now), slot);
    await this.conclude(started, run, outcome);
  }

  /**
   * An attempt has ended. A transient failure of a scheduled run does not end
   * the RUN: it is parked and later resumed with its history and its ledger of
   * side effects, so nothing it already did is done again. Everything else
   * finishes the run.
   */
  private async conclude(task: Task, run: TaskRun, outcome: Outcome): Promise<void> {
    if (
      outcome.state === "failed" &&
      outcome.stopReason === "error" &&
      !outcome.blocked &&
      !run.manual
    ) {
      const attempts = (run.attempts ?? 0) + 1;
      const current = await getTask(task.id);
      if (current?.enabled && attempts <= MAX_RETRIES) {
        await this.park(current, run, attempts, outcome.error ?? outcome.stopReason);
        return;
      }
    }
    await this.finish(task, run, outcome);
  }

  private async park(task: Task, run: TaskRun, attempts: number, why: string): Promise<void> {
    const now = this.now();
    run.state = "interrupted";
    run.attempts = attempts;
    run.lastError = why.slice(0, 500);
    await checkpointRun(run, now);
    await appendRunEvent(
      task.id,
      run.id,
      { type: "error", summary: `attempt ${attempts} failed: ${run.lastError.slice(0, 200)}` },
      now,
    );
    const parked = await updateTask(
      task.id,
      (t) => {
        // The pointer stays: the retry is a resume of THIS run.
        t.activeRunId = run.id;
        t.state = "queued";
        t.failureCount = attempts;
        t.resumeAt = now + (RETRY_BACKOFF_MS[attempts - 1] ?? 15 * 60_000);
      },
      now,
    );
    if (parked) this.emit({ type: "task_updated", task: parked });
  }

  private async resume(task: Task, loaded: LoadedRun, slot: Slot): Promise<void> {
    const run = loaded.run;
    const now = this.now();
    // Two ways to get here: the holder died (an interruption), or the run was
    // parked after a failed attempt and its retry time has come.
    const retry =
      task.resumeAt !== undefined && (run.attempts ?? 0) > 0
        ? { attempt: run.attempts!, ...(run.lastError ? { error: run.lastError } : {}) }
        : undefined;
    run.state = "interrupted";
    if (!retry) run.resumes = (run.resumes ?? 0) + 1;
    await checkpointRun(run, now);
    await appendRunEvent(
      task.id,
      run.id,
      {
        type: "resume",
        summary: retry ? `retry #${retry.attempt}` : `resume #${run.resumes ?? 0}`,
      },
      now,
    );

    if (task.cancelRequestedAt) {
      await this.finish(task, run, { state: "cancelled", stopReason: "cancelled", summary: "" });
      return;
    }
    if ((run.resumes ?? 0) > MAX_RESUMES) {
      await this.finish(task, run, {
        state: "failed",
        stopReason: "too_many_interruptions",
        summary: "",
        error: `interrupted ${run.resumes ?? 0} times — giving up rather than looping`,
      });
      return;
    }

    const note = buildResumeNote(run, IN_FLIGHT, retry);
    const plan = planResume(loaded.messages, note);
    let history: StoredMessage[] = [];
    let userMessage = "";
    if (plan.kind === "finished") {
      // The model had already answered; only the bookkeeping was lost.
      await this.finish(task, run, {
        state: "succeeded",
        stopReason: "end_turn",
        summary: plan.finalText,
      });
      return;
    }
    if (plan.kind === "restart") {
      if (loaded.messages.length > 0) await resetRunMessages(task.id, run.id, 0, now);
      userMessage = `${buildTaskFrame(task, run, now)}\n\n${note}`;
    } else {
      // Rewrite the log's tail so it matches the history the model is given.
      await resetRunMessages(task.id, run.id, plan.keep, now);
      await appendRunMessage(task.id, run.id, plan.last, now);
      history = plan.history;
    }

    run.state = "running";
    await checkpointRun(run, now);
    const resumed = await updateTask(task.id, (t) => {
      t.state = "running";
      delete t.resumeAt;
    });
    this.emit({ type: "task_run_started", taskId: task.id, runId: run.id, resumed: true });
    if (resumed) this.emit({ type: "task_updated", task: resumed });
    const outcome = await this.drive(resumed ?? task, run, history, userMessage, slot);
    await this.conclude(resumed ?? task, run, outcome);
  }

  // ── the agent loop, with its breakers ──

  private async drive(
    task: Task,
    run: TaskRun,
    history: StoredMessage[],
    userMessage: string,
    slot: Slot,
  ): Promise<Outcome> {
    const model = typeof this.opts.model === "function" ? this.opts.model() : this.opts.model;
    const cloud = this.host === "cloud";
    const budget = task.budget;
    const segmentStart = this.now();
    const elapsedBefore = run.elapsedMs ?? 0;
    const touch = (): void => {
      run.elapsedMs = elapsedBefore + (this.now() - segmentStart);
    };

    // Side effects recorded before this segment: replayed, never re-executed.
    const replay = new Map(Object.entries(run.executedDigests));

    // Run-log appends are fire-and-forget from sync callbacks but must stay ordered.
    let logChain: Promise<void> = Promise.resolve();
    const logEvent = (event: RunEvent): void => {
      logChain = logChain
        .then(() => appendRunEvent(task.id, run.id, event, this.now()))
        .catch(() => {});
    };

    const stopWith = (stop: StopReason, detail?: string): void => {
      if (slot.stop) return;
      slot.stop = stop;
      slot.stopDetail = detail;
      slot.controller.abort();
    };

    const cancelRequested = async (): Promise<boolean> => {
      if (slot.stop === "cancelled") return true;
      const current = await getTask(task.id).catch(() => null);
      // A deleted task cancels its run too.
      if (!current || current.cancelRequestedAt) {
        stopWith("cancelled");
        return true;
      }
      return false;
    };

    const remainingMs = budget.wallclockMs - elapsedBefore;
    if (remainingMs <= 0) stopWith("budget_wallclock");
    // Deliberately NOT unref'd: while a run is in flight this breaker must be
    // able to fire even if nothing else is keeping the event loop alive (a
    // provider or tool waiting on a promise with no handle behind it). It is
    // cleared in the finally below, so it never outlives the run.
    const wallclock = setTimeout(() => stopWith("budget_wallclock"), Math.max(0, remainingMs));

    try {
      const surface =
        typeof this.opts.tools === "function" ? await this.opts.tools() : this.opts.tools;
      const tools = taskToolset(surface, task.envelope);
      const toolMap = new Map(tools.map((t) => [t.name, t]));

      const handle = (this.opts.approvalFactory ?? getTaskApprovalFactory())?.({
        taskId: task.id,
        runId: run.id,
        origin: {
          kind: task.kind === "routine" ? "routine" : task.kind === "watcher" ? "watcher" : "task",
          id: task.id,
        },
        ...(task.envelope ? { envelope: task.envelope } : {}),
        uid: task.owner,
      });
      // No factory, or a factory that offers no gate ⇒ the safe default.
      const gate: ApprovalCallback = handle?.approval ?? denySideEffects();
      const approval: ApprovalCallback = async (name, input) => {
        // Already approved and executed before the interruption: it is answered
        // from the ledger below, so there is nothing new to approve.
        if (isSideEffectingCall(name, input) && replay.has(digestCall(name, input))) {
          return { allow: true };
        }
        return await gate(name, input);
      };

      const inner = this.opts.provider ?? providerForModel(model);
      const provider: Provider = {
        name: inner.name,
        runTurn: async (o) => {
          // Every model call clears the same breakers, in the same order.
          if (await cancelRequested()) throw new TaskStop("cancelled");
          if (slot.stop) throw new TaskStop(slot.stop, slot.stopDetail);
          if (run.tokens.in + run.tokens.out >= budget.tokens) {
            stopWith("budget_tokens");
            throw new TaskStop("budget_tokens");
          }
          // `>`: after the last allowed call the model still gets a turn to answer.
          if (run.toolCalls > budget.maxToolCalls) {
            stopWith("budget_tool_calls");
            throw new TaskStop("budget_tool_calls");
          }
          if (budget.usdMicros !== undefined && (run.costMicros ?? 0) >= budget.usdMicros) {
            stopWith("budget_usd");
            throw new TaskStop("budget_usd");
          }
          const admission = this.opts.modelGate ? await this.opts.modelGate.admit(model) : null;
          if (admission && !admission.ok) {
            // Busy (the tenant is mid-chat-turn) or rate-limited: an ordinary
            // failure, retried with backoff. No allowance: stop and tell the user.
            if (admission.transient) throw new Error(`admission busy: ${admission.reason}`);
            stopWith("admission_denied", admission.reason);
            throw new TaskStop("admission_denied", admission.reason);
          }
          try {
            const result = await inner.runTurn(o);
            run.tokens.in += result.usage.inputTokens;
            run.tokens.out += result.usage.outputTokens;
            try {
              run.costMicros = (run.costMicros ?? 0) + costMicroUSD(model, result.usage);
            } catch {
              // Unpriced model — the token budget still bounds the run.
            }
            touch();
            // Settle before anything else can fail: usage that was spent is owed.
            // If it cannot be recorded, stop for good — never spend again on a
            // run whose last call is unpaid, and never "retry" into more of it.
            if (admission?.ok) {
              try {
                await admission.settle(result.usage);
              } catch (err) {
                const why = (err as Error)?.message ?? String(err);
                stopWith("settlement_failed", why.slice(0, 300));
                throw new TaskStop("settlement_failed", why);
              }
            }
            await checkpointRun(run, this.now());
            return result;
          } finally {
            if (admission?.ok) await admission.release().catch(() => {});
          }
        },
      };

      const basePrompt = (await this.opts.buildSystemPrompt?.()) ?? "You are Lisa.";
      const result = await runAgent({
        provider,
        systemPrompt: `${basePrompt}\n\n${TASK_SYSTEM_ADDENDUM}`,
        tools,
        toolCtx: {
          cwd: this.opts.cwd,
          signal: slot.controller.signal,
          log: (m) => this.log(`${task.id}: ${m}`),
          // Unattended ⇒ the bounded sandbox mode, whatever the process default is.
          sandboxMode:
            this.opts.sandboxMode ??
            sandboxModeForProfile(cloud ? "cloud-autonomy" : "local-autonomy"),
        },
        history,
        userMessage,
        model,
        maxIterations: Math.max(4, Math.min(64, budget.maxToolCalls + 2)),
        moodOrigin: "a task run",
        approval,
        onMessagePersist: async (message) => {
          await appendRunMessage(task.id, run.id, message, this.now());
        },
        onEvent: (event: AgentEvent) => {
          try {
            handle?.observe?.(event);
          } catch {
            // An observer must never break the run it observes.
          }
          if (event.type === "tool_call_start") {
            run.toolCalls += 1;
            logEvent({ type: "tool_call", toolName: event.toolName });
          } else if (event.type === "tool_call_end") {
            logEvent({
              type: "tool_result",
              toolName: event.toolName,
              isError: !!event.isError,
              summary:
                typeof event.toolResult === "string" ? event.toolResult.slice(0, 240) : undefined,
            });
          }
        },
        preToolHook: async (name, input) => {
          // run.toolCalls already counts this call (tool_call_start fired).
          if (run.toolCalls > budget.maxToolCalls) {
            stopWith("budget_tool_calls");
            return { block: "the tool-call budget for this run is exhausted" };
          }
          if (slot.stop) return { block: `run is stopping (${slot.stop})` };
          if (!isSideEffectingCall(name, input)) return;
          const digest = digestCall(name, input);
          const recorded = replay.get(digest);
          if (recorded !== undefined) {
            logEvent({ type: "replayed", toolName: name });
            if (recorded === IN_FLIGHT) {
              return {
                cachedResult:
                  `[not re-executed] This exact call was started before the run was interrupted and its ` +
                  `outcome is unknown. It has NOT been run again. Check read-only whether its effect ` +
                  `took place and report what you find; do not repeat it.`,
              };
            }
            return {
              cachedResult:
                `[replayed] This exact call already completed before the run was interrupted. It was ` +
                `not executed again. Recorded result:\n${recorded}`,
            };
          }
          // A call the agent loop is about to reject as malformed never executes.
          const tool = toolMap.get(name);
          if (tool && !validateToolInput(tool.inputSchema, input).ok) return;
          // Write-ahead: if we die inside the tool, the resumed run knows it started.
          run.executedDigests[digest] = IN_FLIGHT;
          touch();
          await checkpointRun(run, this.now());
          return;
        },
        postToolHook: async (name, input, text, isError) => {
          // An error out of a call we aborted says nothing about whether its
          // effect landed — leave it in-flight ("outcome unknown") rather than
          // recording a failure the resumed run would trust.
          const aborted = isError && slot.controller.signal.aborted;
          if (isSideEffectingCall(name, input) && !aborted) {
            run.executedDigests[digestCall(name, input)] = clip(
              isError ? `[error] ${text}` : text,
              MAX_RECORDED_RESULT,
            );
          }
          touch();
          await checkpointRun(run, this.now());
          await cancelRequested();
        },
      });
      await logChain;

      const text = result.finalText.trim();
      if (result.stopReason === "max_iterations") {
        return {
          state: "failed",
          stopReason: "max_iterations",
          summary: text,
          error: "ran out of turns",
        };
      }
      return { state: "succeeded", stopReason: result.stopReason, summary: text };
    } catch (err) {
      await logChain;
      const stop = slot.stop ?? (err instanceof TaskStop ? err.stop : null);
      if (stop === "cancelled") return { state: "cancelled", stopReason: "cancelled", summary: "" };
      if (stop) {
        const detail = slot.stopDetail ?? (err instanceof TaskStop ? err.message : undefined);
        return {
          state: "failed",
          stopReason: stop,
          summary: "",
          error: detail ?? stop,
          blocked: stop === "admission_denied" || stop === "settlement_failed",
          pause: stop === "admission_denied" || stop === "settlement_failed",
        };
      }
      const message = (err as Error)?.message ?? String(err);
      if (this.stopped || slot.controller.signal.aborted) {
        // Shutdown, not failure: leave the run as it is so the next start resumes it.
        throw new Interrupted();
      }
      return {
        state: "failed",
        stopReason: "error",
        summary: "",
        error: message.slice(0, 500),
        blocked: looksLikeAuthFailure(message),
      };
    } finally {
      clearTimeout(wallclock);
      touch();
    }
  }

  // ── finishing a run ──

  private async finish(task: Task, run: TaskRun, outcome: Outcome): Promise<void> {
    const now = this.now();
    run.state = outcome.state;
    run.endedAt = now;
    run.stopReason = outcome.stopReason;
    if (outcome.summary) run.summary = clip(outcome.summary, MAX_SUMMARY);
    if (outcome.error) run.error = outcome.error;
    await checkpointRun(run, now);

    const cloud = this.host === "cloud";
    const manual = !!run.manual;
    const noop = outcome.state === "succeeded" && isNoUpdate(outcome.summary);
    let notice: {
      kind: TaskNotice["kind"];
      summary: string;
      priority: TaskNotice["priority"];
    } | null = null;

    const updated = await updateTask(
      task.id,
      (t) => {
        delete t.activeRunId;
        delete t.resumeAt;
        delete t.cancelRequestedAt;
        delete t.queued;
        t.lastRunAt = now;
        const recurring = isRecurring(t);
        const next = (): void => {
          t.state = restingState(t);
          if (t.enabled && recurring) t.nextRunAt = nextRunAfter(t, now, cloud);
          else delete t.nextRunAt;
        };

        if (outcome.state === "succeeded") {
          t.failureCount = 0;
          t.authFailureCount = 0;
          if (!noop) t.lastSummary = clip(outcome.summary, 2000);
          const fingerprint = digestCall("summary", outcome.summary);
          const changed = fingerprint !== t.lastResultFingerprint;
          t.lastResultFingerprint = fingerprint;
          const tell =
            manual ||
            t.notify === "always" ||
            (t.notify === "silent_on_noop" && !noop) ||
            (t.notify === "on_change" && changed && !noop) ||
            (t.notify === "on_hit" && (run.input !== undefined ? !noop : false));
          if (tell) {
            notice = {
              kind: "task_result",
              summary: noop ? "Ran. Nothing to report." : outcome.summary,
              priority: "normal",
            };
          }
          if (recurring || !t.enabled) next();
          else {
            t.state = "succeeded";
            delete t.nextRunAt;
          }
          return;
        }

        if (outcome.state === "cancelled") {
          if (recurring || !t.enabled) next();
          else {
            t.state = "cancelled";
            delete t.nextRunAt;
          }
          return;
        }

        // failed
        const why = outcome.error ?? outcome.stopReason;
        if (outcome.blocked) {
          t.authFailureCount += 1;
          // Billing said no (or could not record the spend): off at once. A
          // credential-looking error gets a few occurrences before that.
          const pauseNow = recurring && (outcome.pause || t.authFailureCount >= MAX_BLOCKED);
          if (pauseNow || t.authFailureCount === 1) {
            notice = {
              kind: "task_needs_you",
              summary: pauseNow
                ? outcome.pause
                  ? `Paused: ${why}. Nothing will run until you turn it back on.`
                  : `Paused after ${t.authFailureCount} runs in a row were refused (${why}). Fix the cause, then re-enable it.`
                : `This run was refused (${why}). It will be tried again on its next occurrence.`,
              priority: "high",
            };
          }
          if (pauseNow) {
            pauseTask(t, why);
            return;
          }
          if (recurring || !t.enabled) next();
          else {
            t.state = "failed";
            delete t.nextRunAt;
          }
          return;
        }

        // Retries were already spent by conclude(): this is the final word.
        t.failureCount = 0;
        notice = {
          kind: "task_failed",
          summary: `Did not finish: ${why}.${outcome.summary ? `\n\nLast output:\n${outcome.summary}` : ""}`,
          priority: "normal",
        };
        if (recurring || !t.enabled) next();
        else {
          t.state = "failed";
          delete t.nextRunAt;
        }
      },
      now,
    );

    this.emit({
      type: "task_run_finished",
      taskId: task.id,
      runId: run.id,
      state: run.state,
      ...(run.stopReason ? { stopReason: run.stopReason } : {}),
      ...(run.summary ? { summary: run.summary.slice(0, 500) } : {}),
    });
    if (updated) this.emit({ type: "task_updated", task: updated });
    // `notice` is assigned inside the updateTask callback, which TS cannot see.
    const pending = notice as {
      kind: TaskNotice["kind"];
      summary: string;
      priority: TaskNotice["priority"];
    } | null;
    if (pending)
      await this.notify(updated ?? task, run, pending.kind, pending.summary, pending.priority);
  }

  private async notify(
    task: Task,
    run: TaskRun,
    kind: TaskNotice["kind"],
    summary: string,
    priority: TaskNotice["priority"],
  ): Promise<void> {
    try {
      await enqueueNotice(
        {
          id: noticeId(run.id, kind),
          uid: task.owner,
          taskId: task.id,
          runId: run.id,
          title: task.title,
          summary: clip(summary, 4000),
          status: run.state,
          ...(run.artifacts ? { artifacts: run.artifacts } : {}),
          priority,
          kind,
        },
        this.now(),
      );
      await drainOutbox(this.deliver(), this.now());
    } catch (err) {
      // The notice is durable (or will be re-derived); delivery is retried at the next tick.
      this.log(`delivery of ${run.id} deferred: ${(err as Error).message}`);
    }
  }

  // ── watchers ──

  private async poll(task: Task, slot: Slot): Promise<void> {
    const check = this.opts.checkWatch;
    const now = this.now();
    const cloud = this.host === "cloud";
    if (!check) {
      // No watcher implementation in this process: leave the task due for one that has it.
      return;
    }
    let outcome: WatchOutcome;
    try {
      outcome = await check(task, { signal: slot.controller.signal, now });
    } catch (err) {
      outcome = {
        watch: { ...task.watch, failures: (task.watch?.failures ?? 0) + 1 },
        error: (err as Error).message,
      };
    }
    const hit = outcome.hit;
    const failures = outcome.error ? (outcome.watch.failures ?? 1) : 0;

    if (hit && (task.trigger?.onHit ?? "notify") === "notify") {
      // The run id is derived from the hit, so a crash before the state write
      // below re-creates the SAME run and the SAME notice id — never a second one.
      const runId = `r_${digestCall(task.id, hit.key).slice(0, 16)}`;
      const existing = await loadRun(task.id, runId);
      const run =
        existing?.run ??
        (await createRun(task.id, { id: runId, state: "succeeded", input: hit.detail }, now));
      run.endedAt = now;
      run.stopReason = "watch_hit";
      run.summary = clip(hit.summary, MAX_SUMMARY);
      await checkpointRun(run, now);
      this.emit({
        type: "task_run_finished",
        taskId: task.id,
        runId,
        state: "succeeded",
        stopReason: "watch_hit",
        summary: run.summary.slice(0, 500),
      });
      await this.notify(task, run, "watch_hit", hit.summary, "high");
    }

    const updated = await updateTask(
      task.id,
      (t) => {
        t.watch = {
          ...outcome.watch,
          lastCheckedAt: now,
          ...(hit ? { lastHitAt: now } : {}),
          failures,
          ...(outcome.error ? { lastError: outcome.error.slice(0, 300) } : {}),
        };
        if (!outcome.error) delete t.watch.lastError;
        delete t.queued;
        if (hit) t.lastRunAt = now;
        if (hit && t.trigger?.onHit === "run") {
          // Same write as the watch state: the hit is consumed and the run
          // queued atomically, so a crash cannot queue it twice.
          t.state = "queued";
          t.queued = {
            input: clip(`${hit.summary}${hit.detail ? `\n\n${hit.detail}` : ""}`, 6000),
          };
          t.nextRunAt = now;
          return;
        }
        t.state = restingState(t);
        if (t.enabled) t.nextRunAt = nextRunAfter(t, now, cloud);
        else delete t.nextRunAt;
      },
      now,
    );
    if (updated) this.emit({ type: "task_updated", task: updated });

    // A watcher that keeps failing tells the user once, not every poll.
    if (outcome.error && failures === MAX_BLOCKED && updated) {
      const runId = `r_${digestCall(task.id, `failing:${task.watch?.lastCheckedAt ?? 0}`).slice(0, 16)}`;
      const existing = await loadRun(task.id, runId);
      const run = existing?.run ?? (await createRun(task.id, { id: runId, state: "failed" }, now));
      run.endedAt = now;
      run.stopReason = "watch_failing";
      run.error = outcome.error.slice(0, 500);
      await checkpointRun(run, now);
      await this.notify(
        updated,
        run,
        "task_needs_you",
        `This watcher has failed ${failures} checks in a row (${outcome.error.slice(0, 200)}). It keeps trying, less often.`,
        "normal",
      );
    }
  }
}
