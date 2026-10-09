/**
 * Task runner — executes due tasks, durably.
 *
 * One TaskRunner per process (per tenant per sweep on the cloud edition). The
 * same class backs the in-process scheduler in `serve --web`, the launchd
 * heartbeat CLI and `lisa tasks run`, so a task behaves identically whichever
 * of them picks it up — and the per-task lease guarantees only one does.
 *
 * What a run is guaranteed (docs/DESIGN_TASK_ENGINE.md has the long form):
 *   lease        one runner at a time, across processes (lease.ts), with
 *                fencing: ownership is re-checked before every write and every
 *                side-effecting call, and a runner that lost the lease stops
 *                without writing;
 *   checkpoint   the run record is appended after every model call and every
 *                tool call, and every message as soon as it exists;
 *   resume       a run whose holder died is continued — same run id, saved
 *                history, a note telling the model what already happened;
 *   retry        a transient failure parks the run and RESUMES it later; a
 *                retry never starts a fresh run with an empty ledger;
 *   exactly-once each execution of a side-effecting call is a ledger entry,
 *                written BEFORE it runs and closed AFTER. A continued run that
 *                re-issues it is answered from the ledger (once per recorded
 *                execution), or told its outcome is unknown. Not run twice;
 *   finish       the terminal run record comes first; a task that points at a
 *                terminal run completes that finish instead of running again;
 *   budgets      tokens (cached ones too), spend, wall-clock and tool calls;
 *   cancel       an AbortSignal in-process, a flag on the task across processes;
 *   approval     from the injected factory; with none wired, only verified
 *                read-only calls pass (policy.ts);
 *   delivery     results go through the outbox (outbox.ts), never directly.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSandboxedCapabilities, type Capabilities } from "../capabilities/index.js";
import { runAgent, type ApprovalCallback } from "../agent.js";
import { getAutonomyEnabled } from "../autonomy/state.js";
import { costMicroUSD } from "../billing/prices.js";
import { logInfo } from "../log.js";
import { lisaGlobalHome, lisaHome, scopedUid } from "../paths.js";
import { providerForModel } from "../providers/registry.js";
import { notSent, type Provider, type ProviderUsage } from "../providers/types.js";
import { modeIsBounded, type SandboxMode } from "../sandbox/mode.js";
import { sandboxModeForProfile } from "../sandbox/sandbox.js";
import { validateToolInput } from "../tools/validate.js";
import { stripSensitiveTokens } from "../warden/hygiene.js";
import type { AgentEvent, StoredMessage, ToolDefinition } from "../types.js";
import { isEnvelopeConfirmed } from "./confirmation.js";
import {
  buildResumeNote,
  buildTaskFrame,
  isNoUpdate,
  planResume,
  TASK_SYSTEM_ADDENDUM,
} from "./frame.js";
import {
  acquireTaskLease,
  DEFAULT_LEASE_TTL_MS,
  sweepOrphanLeases,
  type TaskLease,
} from "./lease.js";
import { isRecurring, nextRunAfter, pauseTask, restingState } from "./lifecycle.js";
import { drainOutbox, enqueueNotice, noticeId } from "./outbox.js";
import { denySideEffects, digestCall, isSideEffectingCall, taskToolset } from "./policy.js";
import { defaultTimeZone, isOneShot } from "./schedule.js";
import { ensureTaskWorkspace } from "./workspace.js";
import {
  appendRunEvent,
  appendRunMessage,
  checkpointRun,
  createRun,
  getTask,
  listTasks,
  loadRun,
  resetRunMessages,
  TaskGoneError,
  updateTask,
  type LoadedRun,
  type RunEvent,
} from "./store.js";
import {
  DEFAULT_APPROVAL_WAIT_MS,
  DEFAULT_MAX_APPROVALS,
  MAX_APPROVALS_LIMIT,
  MAX_APPROVAL_WAIT_MS,
  MAX_APPROVAL_WAIT_MS_CLOUD,
  tokensSpent,
} from "./types.js";
import type {
  Task,
  TaskApprovalFactory,
  TaskApprovalWait,
  TaskEffect,
  TaskDeliver,
  TaskNotice,
  TaskRun,
  TaskRunState,
  TaskRunTrigger,
  WatchState,
} from "./types.js";
import { getDefaultTaskDeliver, getTaskApprovalFactory, getTaskDeliver } from "./wiring.js";

/**
 * Did the user start this run by hand? Read from the run record only — its
 * trigger is in its first record — never from the task's transient state.
 */
function startedByUser(run: TaskRun): boolean {
  return run.trigger !== undefined ? run.trigger === "manual" : !!run.manual;
}

/**
 * The execution world of a task run under a bounded sandbox mode: writes go
 * to the task's own workspace (and the temp directories), and the whole Lisa
 * home is read-only to it but for that workspace — in the OS profile and in
 * the file tools alike. Unbounded (`danger-full-access`): undefined, the plain
 * local world, where Warden treats every write and command as unconfined.
 */
export function taskCapabilities(workspace: string, mode: SandboxMode): Capabilities | undefined {
  if (!modeIsBounded(mode)) return undefined;
  const homes = new Set<string>();
  for (const home of [lisaHome(), lisaGlobalHome()]) {
    homes.add(path.resolve(home));
    try {
      homes.add(fs.realpathSync.native(home));
    } catch {
      // not there (yet): the literal path is denied
    }
  }
  return createSandboxedCapabilities({
    root: workspace,
    spec: {
      mode,
      allowNetwork: process.env.LISA_SANDBOX_NETWORK !== "0",
      cwd: workspace,
      denyWrites: { paths: [...homes], except: workspace },
    },
  });
}

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

/** While a run waits for an approval, how often it checks for a cancel made by another process. */
export const APPROVAL_CANCEL_POLL_MS = 5_000;

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
  /**
   * The host's working directory — used for Lisa's system prompt only. A run's
   * tools never work here: each task works in its own folder under the Lisa
   * home (workspace.ts), whatever directory the server was started from.
   */
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
  /**
   * Register a run as in-flight work of its tenant (the web server's
   * account-deletion bookkeeping). `stop` cancels the run. Return a function to
   * call when the run has ended, or null to refuse the run (the account is
   * being deleted).
   */
  trackRun?: (stop: () => void) => (() => void) | null;
  /** False pauses scheduled (not manual) runs. Default: the Proactive master switch. */
  unattendedAllowed?: () => boolean;
  checkWatch?: WatchCheck;
  onEvent?: (event: TaskEngineEvent) => void;
  sandboxMode?: SandboxMode;
  leaseTtlMs?: number;
  /** Lease renewal period (tests). Default ttl/3. */
  leaseRenewEveryMs?: number;
  /** Cancel check while awaiting an approval (tests). Default APPROVAL_CANCEL_POLL_MS. */
  approvalCancelPollMs?: number;
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
  | "settlement_failed"
  | "approval_limit";

class TaskStop extends Error {
  constructor(
    readonly stop: StopReason,
    detail?: string,
  ) {
    super(detail ? `${stop}: ${detail}` : stop);
  }
}

/**
 * This runner no longer holds the task's lease (a renewal failed, or the lease
 * on disk is someone else's). It stops at once and writes nothing more: the
 * run now belongs to whoever holds the lease.
 */
class LeaseLost extends Error {
  constructor() {
    super("task lease lost");
  }
}

/**
 * Why a run that may no longer write stopped: its lease's directory is gone
 * (the task, or the whole home, was deleted), or the lease was lost.
 */
function lostLease(slot: Slot): Error {
  return slot.lease?.gone ? new TaskGoneError("the task's lease") : new LeaseLost();
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
  lease?: TaskLease;
  leaseLost?: boolean;
  /**
   * Set when the run must stop as INTERRUPTED (left resumable, nothing more
   * written): the outcome of a state-changing call that already ran could not
   * be recorded. The value says why, for the log.
   */
  interrupted?: string;
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

/**
 * A watcher hit's summary line as it may be stored and shown. It embeds text
 * from outside (a feed's title, a page fragment), so it is cleaned exactly
 * like the item lines below: no one-time codes or sign-in links, one line,
 * bounded.
 */
export function cleanHitSummary(summary: string): string {
  const line = stripSensitiveTokens(summary).text.replace(/\s+/g, " ").trim();
  if (!line) return "The watcher fired.";
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

/**
 * What a notify-mode watcher tells the user: the summary, and WHICH items
 * fired it. All of it is text from outside (a feed title, a page fragment, a
 * mail subject), so it is cleaned of one-time codes and sign-in links,
 * bounded, and the items quoted line by line — shown, never interpreted. The
 * card that carries it into the conversation wraps it in the external-content
 * markers (delivery.ts), so a later turn reads it as data, not as Lisa's words.
 */
export function describeHit(hit: { summary: string; detail?: string }): string {
  const summary = cleanHitSummary(hit.summary);
  if (!hit.detail?.trim()) return summary;
  const cleaned = stripSensitiveTokens(hit.detail).text;
  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((l) => `> ${l.length > 240 ? `${l.slice(0, 239)}…` : l}`);
  return lines.length ? `${summary}\n${lines.join("\n")}` : summary;
}

interface SettledNotice {
  kind: TaskNotice["kind"];
  summary: string;
  priority: TaskNotice["priority"];
}

/**
 * The task's transition when one of its runs has ended, and the notices that
 * ending produces. Pure in the sense that matters: it reads only the task and
 * the run's terminal record, so it can be applied to a copy (to learn the
 * notices) and then to the stored task, or re-applied after a crash.
 */
function settleTask(t: Task, run: TaskRun, now: number, cloud: boolean): SettledNotice[] {
  const notices: SettledNotice[] = [];
  const manual = startedByUser(run);
  const summary = run.summary ?? "";
  const noop = run.state === "succeeded" && isNoUpdate(summary);
  // A manual run of a one-off that is still waiting for its time is a test
  // run: it must not use the occurrence up.
  const pendingOneShot =
    manual &&
    t.enabled &&
    !!t.schedule &&
    isOneShot(t.schedule) &&
    t.nextRunAt !== undefined &&
    t.nextRunAt > now;

  delete t.activeRunId;
  delete t.resumeAt;
  delete t.cancelRequestedAt;
  delete t.queued;
  t.lastRunAt = now;
  const recurring = isRecurring(t);

  /** Back to rest, with the next occurrence — or switched off if there is none to compute. */
  const next = (): void => {
    t.state = restingState(t);
    if (!(t.enabled && recurring)) {
      delete t.nextRunAt;
      return;
    }
    let at: number | undefined;
    let problem: string | null = null;
    try {
      at = nextRunAfter(t, now, cloud);
      if (at === undefined) problem = "its schedule never fires again";
    } catch (err) {
      problem = `its schedule cannot be computed (${(err as Error).message.slice(0, 120)})`;
    }
    if (problem) {
      // Never leave a task due with no way to move it forward: that is a loop.
      pauseTask(t, problem);
      notices.push({
        kind: "task_needs_you",
        summary: `Paused: ${problem}. Fix the schedule, then turn it back on.`,
        priority: "high",
      });
      return;
    }
    t.nextRunAt = at;
  };
  /** A non-recurring task ends in `state`; a recurring or disabled one goes back to rest. */
  const end = (state: "succeeded" | "failed" | "cancelled"): void => {
    if (pendingOneShot) {
      t.state = "scheduled"; // nextRunAt untouched: its real occurrence is still ahead
      return;
    }
    if (recurring || !t.enabled) next();
    else {
      t.state = state;
      delete t.nextRunAt;
    }
  };

  if (run.state === "succeeded") {
    t.failureCount = 0;
    t.authFailureCount = 0;
    if (!noop) t.lastSummary = clip(summary, 2000);
    const fingerprint = digestCall("summary", summary);
    const changed = fingerprint !== t.lastResultFingerprint;
    t.lastResultFingerprint = fingerprint;
    const tell =
      manual ||
      t.notify === "always" ||
      (t.notify === "silent_on_noop" && !noop) ||
      (t.notify === "on_change" && changed && !noop) ||
      (t.notify === "on_hit" && (run.input !== undefined ? !noop : false));
    if (tell) {
      notices.push({
        kind: "task_result",
        summary: noop ? "Ran. Nothing to report." : summary,
        priority: "normal",
      });
    }
    end("succeeded");
    return notices;
  }

  if (run.state === "cancelled") {
    end("cancelled");
    return notices;
  }

  // failed
  const why = run.error ?? run.stopReason ?? "failed";
  if (run.blocked) {
    t.authFailureCount += 1;
    // Billing said no (or could not record the spend): off at once. A
    // credential-looking error gets a few occurrences before that.
    const pauseNow = recurring && (!!run.pausesTask || t.authFailureCount >= MAX_BLOCKED);
    if (pauseNow || t.authFailureCount === 1) {
      notices.push({
        kind: "task_needs_you",
        summary: pauseNow
          ? run.pausesTask
            ? `Paused: ${why}. Nothing will run until you turn it back on.`
            : `Paused after ${t.authFailureCount} runs in a row were refused (${why}). Fix the cause, then re-enable it.`
          : `This run was refused (${why}). It will be tried again on its next occurrence.`,
        priority: "high",
      });
    }
    if (pauseNow) pauseTask(t, why);
    else end("failed");
    return notices;
  }

  // Retries were already spent before the run was ended: this is the final word.
  t.failureCount = 0;
  notices.push({
    kind: "task_failed",
    summary: `Did not finish: ${why}.${summary ? `\n\nLast output:\n${summary}` : ""}`,
    priority: "normal",
  });
  end("failed");
  return notices;
}

export class TaskRunner {
  private readonly opts: TaskRunnerOptions;
  private readonly owner = `${process.pid}-${randomBytes(6).toString("hex")}`;
  private readonly active = new Map<string, Slot>();
  private readonly inflight = new Set<Promise<void>>();
  /** The slot (and so the lease) of the run the current async context belongs to. */
  private readonly current = new AsyncLocalStorage<Slot>();
  private readonly now: () => number;
  private readonly host: "home" | "cloud";
  private readonly concurrency: number;
  private stopped = false;

  constructor(opts: TaskRunnerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.host = opts.host ?? "home";
    this.concurrency = opts.concurrency ?? (this.host === "cloud" ? 1 : 2);
    // Validate LISA_TZ now, at startup, not at the first calendar schedule: an
    // invalid zone is reported once and the system zone is used instead.
    defaultTimeZone((msg) => (opts.log ?? logInfo)(msg));
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

  private approvalFactory(): TaskApprovalFactory | undefined {
    return this.opts.approvalFactory ?? getTaskApprovalFactory();
  }

  // ── fencing: every write a run makes is conditional on still holding the lease ──

  /**
   * Throws LeaseLost unless the calling run still owns its task's lease. Called
   * before every store write and every side-effecting tool call of a run.
   * Outside a run (API-side runNow / cancel) there is no lease and no check.
   */
  private async fence(): Promise<void> {
    const slot = this.current.getStore();
    if (!slot) return;
    if (slot.leaseLost || !slot.lease || !(await slot.lease.verify())) {
      slot.leaseLost = true;
      slot.controller.abort();
      throw lostLease(slot);
    }
  }

  private async saveRun(...args: Parameters<typeof checkpointRun>): Promise<void> {
    await this.fence();
    await checkpointRun(...args);
  }

  private async saveTask(...args: Parameters<typeof updateTask>): Promise<Task | null> {
    await this.fence();
    return await updateTask(...args);
  }

  private async saveMessage(...args: Parameters<typeof appendRunMessage>): Promise<void> {
    await this.fence();
    await appendRunMessage(...args);
  }

  private async saveEvent(...args: Parameters<typeof appendRunEvent>): Promise<void> {
    await this.fence();
    await appendRunEvent(...args);
  }

  private async saveReset(...args: Parameters<typeof resetRunMessages>): Promise<void> {
    await this.fence();
    await resetRunMessages(...args);
  }

  private async newRun(...args: Parameters<typeof createRun>): Promise<TaskRun> {
    await this.fence();
    return await createRun(...args);
  }

  private async saveNotice(...args: Parameters<typeof enqueueNotice>): Promise<void> {
    await this.fence();
    await enqueueNotice(...args);
  }

  // ── scheduling ──

  /** The Proactive master switch (or the injected stand-in). */
  private unattendedAllowed(): boolean {
    return (this.opts.unattendedAllowed ?? getAutonomyEnabled)();
  }

  /**
   * Is there work on this task for this runner at `now`? The lease has the final say.
   *
   * A task with a run to continue — interrupted by a crash, or parked until
   * its retry time — is due whatever the switches say: picking it up is how
   * it gets ENDED when they are closed. Whether it may actually continue is
   * decided under the lease by the same gate that starts runs (resume()): a
   * scheduled run needs the Proactive switch on and the task enabled, a manual
   * one only that the task still exists. A closed gate finishes it as
   * cancelled — except one case: the run of an enabled ONE-OFF, with only the
   * Proactive switch off, waits parked (`queued`) for the switch, because a
   * one-off has no next occurrence and ending it would lose the task. While
   * the switch is off such a parked run is not due.
   */
  private isDue(task: Task, now: number, unattended: boolean): boolean {
    if (task.host !== "any" && task.host !== this.host) return false;
    if (task.activeRunId) {
      if (task.cancelRequestedAt) return true;
      if (task.state === "queued" && !unattended && task.enabled && !isRecurring(task)) {
        return false;
      }
      return task.resumeAt === undefined || task.resumeAt <= now;
    }
    const due = task.nextRunAt !== undefined && task.nextRunAt <= now;
    if (task.state === "queued") {
      if (task.queued?.manual) return true;
      // Queued by the engine (a watcher hit, an enabled one-off): starting it
      // is a non-manual run, so it needs the switch on AND the task enabled.
      return unattended && task.enabled && (due || task.nextRunAt === undefined);
    }
    return unattended && task.enabled && task.state === "scheduled" && due;
  }

  /**
   * One scheduler pass: deliver anything left in the outbox, then start every
   * due task up to the concurrency cap. Runs proceed in the background; use
   * drain() to wait for them. Never throws.
   */
  async tick(opts: { maxStarts?: number } = {}): Promise<{ started: string[] }> {
    const started: string[] = [];
    if (this.stopped) return { started };
    const maxStarts = opts.maxStarts ?? Infinity;
    try {
      await drainOutbox(this.deliver(), this.now());
    } catch (err) {
      this.log(`outbox drain failed: ${(err as Error).message}`);
    }
    // A lease this process could not release (its removal failed) blocks its
    // task for every other process on this host: clear such orphans first.
    const swept = await sweepOrphanLeases({ pidLiveness: this.host !== "cloud" }).catch(() => 0);
    if (swept > 0) this.log(`removed ${swept} lease(s) left behind by an earlier run here`);
    let tasks: Task[];
    try {
      tasks = await listTasks();
    } catch (err) {
      this.log(`cannot list tasks: ${(err as Error).message}`);
      return { started };
    }
    const now = this.now();
    const unattended = this.unattendedAllowed();
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
      if (started.length >= maxStarts) break;
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
    const updated = await this.saveTask(
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
    const updated = await this.saveTask(
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

  /**
   * A task was deleted: end whatever the gate granted "for this task". Called
   * by the removal path (removal.ts) and by a run that finds its task gone.
   * Never throws: the task is gone either way.
   */
  async taskRemoved(taskId: string): Promise<void> {
    try {
      await this.approvalFactory()?.taskRemoved?.({ taskId, uid: scopedUid(), home: lisaHome() });
    } catch (err) {
      this.log(`task ${taskId}: its grants could not be revoked: ${(err as Error).message}`);
    }
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
        // Hosted: a pid proves nothing across instances; expiry decides.
        pidLiveness: this.host !== "cloud",
        ...(this.opts.leaseRenewEveryMs ? { renewEveryMs: this.opts.leaseRenewEveryMs } : {}),
        // A renewal that fails or errors: we can no longer vouch for ownership.
        // Abort whatever is in flight; the fence stops every write after that.
        onLost: () => {
          slot.leaseLost = true;
          slot.controller.abort();
        },
      });
    } catch (err) {
      this.log(`cannot take the lease for ${taskId}: ${(err as Error).message}`);
    }
    if (!lease) {
      this.active.delete(taskId);
      return false;
    }
    const held = lease;
    slot.lease = held;
    // Account deletion must be able to see, stop and wait for this run.
    let finishWork: (() => void) | null | undefined;
    try {
      finishWork = this.opts.trackRun?.(() => {
        slot.stop = "cancelled";
        slot.controller.abort();
      });
    } catch {
      finishWork = undefined;
    }
    if (finishWork === null) {
      await held.release().catch(() => {});
      this.active.delete(taskId);
      return false;
    }
    const p = this.current
      .run(slot, () => this.runTask(taskId, slot))
      .catch(async (err) => {
        if (err instanceof Interrupted) {
          if (slot.interrupted) {
            this.log(`task ${taskId}: stopped — ${slot.interrupted}; it resumes at the next tick`);
          }
          return;
        }
        if (err instanceof TaskGoneError || slot.lease?.gone) {
          // Deleted (or its whole home was) while it ran: nothing is put back.
          // Its run never ends normally, so what was granted "for this task"
          // is revoked here (a gone home has no grants left to revoke).
          this.log(`task ${taskId}: removed while running — stopped`);
          await this.taskRemoved(taskId);
          return;
        }
        if (err instanceof LeaseLost || slot.leaseLost) {
          this.log(
            `task ${taskId}: lease lost — stopped without writing; whoever holds the lease next continues the run`,
          );
          return;
        }
        this.log(`task ${taskId} failed outside its run: ${(err as Error).stack ?? String(err)}`);
      })
      .finally(async () => {
        await held.release().catch(() => {});
        this.active.delete(taskId);
        this.inflight.delete(p);
        finishWork?.();
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
        // A run left `awaiting_approval` is one whose process stopped while it
        // waited. The approval died with that process (the inbox keeps the
        // payload in memory only), so the resumed run issues the call again
        // and asks again.
        if (
          loaded &&
          (loaded.run.state === "running" ||
            loaded.run.state === "interrupted" ||
            loaded.run.state === "awaiting_approval")
        ) {
          await this.resume(task, loaded, slot);
          return;
        }
        if (loaded) {
          // The run is over but its bookkeeping never landed (a crash, or a
          // failed write, between the terminal record and the task update).
          // Complete THAT finish — deliver its result, compute the next run —
          // instead of running the task a second time.
          await this.completeFinish(task.id, loaded.run);
          return;
        }
        // The run log itself is gone: nothing to complete. Clear the pointer.
        await this.saveTask(task.id, (t) => {
          delete t.activeRunId;
          delete t.resumeAt;
          if (t.state === "running" || t.state === "queued") t.state = restingState(t);
        });
        return;
      }

      const manual = task.state === "queued" && !!task.queued?.manual;
      const unattended = this.unattendedAllowed();
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
    // Derived id + notice before the state change: a crash anywhere in here is
    // repeated harmlessly (same run, same notice id) at the next tick.
    const runId = `r_${digestCall(task.id, `expired:${task.nextRunAt ?? 0}`).slice(0, 16)}`;
    const existing = await loadRun(task.id, runId);
    const run =
      existing?.run ??
      (await this.newRun(task.id, { id: runId, state: "failed", trigger: "scheduled" }, now));
    run.endedAt = now;
    run.stopReason = "expired";
    run.summary = `This was due at ${new Date(task.nextRunAt!).toISOString()} but LISA was not running then. It was not run.`;
    await this.saveRun(run, now);
    await this.notify(task, run, "task_failed", run.summary, "low");
    const updated = await this.saveTask(
      task.id,
      (t) => {
        t.state = "expired";
        delete t.nextRunAt;
      },
      now,
    );
    if (updated) this.emit({ type: "task_updated", task: updated });
  }

  private async startRun(task: Task, slot: Slot, manual: boolean): Promise<void> {
    const now = this.now();
    const input = task.queued?.input;
    // The trigger goes into the run's first record, before the task points at
    // it: a run on disk always says whether the user started it.
    const trigger: TaskRunTrigger = manual
      ? "manual"
      : input !== undefined
        ? "watcher"
        : "scheduled";
    const run = await this.newRun(
      task.id,
      { state: "running", trigger, ...(input !== undefined ? { input } : {}) },
      now,
    );
    const started = await this.saveTask(
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
    await this.saveRun(run, now);
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
      !startedByUser(run)
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
    await this.saveRun(run, now);
    await this.saveEvent(
      task.id,
      run.id,
      { type: "error", summary: `attempt ${attempts} failed: ${run.lastError.slice(0, 200)}` },
      now,
    );
    const parked = await this.saveTask(
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

    if (task.cancelRequestedAt) {
      await this.finish(task, run, { state: "cancelled", stopReason: "cancelled", summary: "" });
      return;
    }
    // A run whose model had already given its final answer is not continued,
    // only finished (no model call, no tool call) and its answer delivered —
    // whatever its interruption count, and whatever the switches say: that is
    // not a resume, so it is neither gated nor counted.
    const answered = planResume(loaded.messages, "");
    if (answered.kind === "finished") {
      // The model had already answered; only the bookkeeping was lost.
      await this.finish(task, run, {
        state: "succeeded",
        stopReason: "end_turn",
        summary: answered.finalText,
      });
      return;
    }
    // Continuing a run is gated exactly like starting one. A run the user
    // started by hand needs only that the task still exists (it does: we are
    // here). Any other run needs the Proactive switch on and the task enabled;
    // when either is off now, the run ends as cancelled — visible in the run
    // history, no notice.
    if (!startedByUser(run)) {
      const proactiveOff = !this.unattendedAllowed();
      if (proactiveOff && task.enabled && !isRecurring(task)) {
        // Except an enabled one-off held back only by the Proactive switch: it
        // has no next occurrence, so ending its run would lose the user's task,
        // and starting it afresh later would repeat its side effects. The run
        // stays parked — no model call, no tool call, nothing counted — and
        // continues with its ledger once the switch is back on (isDue skips it
        // until then). A disabled one-off is still cancelled below.
        if (task.state !== "queued") {
          const held = await this.saveTask(task.id, (t) => {
            if (t.activeRunId !== run.id) return false;
            t.state = "queued";
          });
          if (held) this.emit({ type: "task_updated", task: held });
        }
        return;
      }
      const closed = proactiveOff
        ? { stop: "proactive_off", why: "Proactive is off" }
        : !task.enabled
          ? { stop: "task_disabled", why: "the task was switched off" }
          : null;
      if (closed) {
        await this.finish(task, run, {
          state: "cancelled",
          stopReason: closed.stop,
          summary: `Not continued: ${closed.why}.`,
        });
        return;
      }
    }

    // Two ways to get here: the holder died (an interruption), or the run was
    // parked after a failed attempt and its retry time has come.
    const retry =
      task.resumeAt !== undefined && (run.attempts ?? 0) > 0
        ? { attempt: run.attempts!, ...(run.lastError ? { error: run.lastError } : {}) }
        : undefined;
    run.state = "interrupted";
    if (!retry) run.resumes = (run.resumes ?? 0) + 1;
    await this.saveRun(run, now);
    await this.saveEvent(
      task.id,
      run.id,
      {
        type: "resume",
        summary: retry ? `retry #${retry.attempt}` : `resume #${run.resumes ?? 0}`,
      },
      now,
    );

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
      // Unreachable: an answered history was finished above (same messages).
      await this.finish(task, run, {
        state: "succeeded",
        stopReason: "end_turn",
        summary: plan.finalText,
      });
      return;
    }
    if (plan.kind === "restart") {
      if (loaded.messages.length > 0) await this.saveReset(task.id, run.id, 0, now);
      userMessage = `${buildTaskFrame(task, run, now)}\n\n${note}`;
    } else {
      // Rewrite the log's tail so it matches the history the model is given.
      await this.saveReset(task.id, run.id, plan.keep, now);
      await this.saveMessage(task.id, run.id, plan.last, now);
      history = plan.history;
    }

    run.state = "running";
    await this.saveRun(run, now);
    const resumed = await this.saveTask(task.id, (t) => {
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
    // Time spent waiting for a human answer does not count against the run's
    // wall-clock budget (or its elapsed time): the clock is paused for it.
    let pausedMs = 0;
    let pausedAt: number | null = null;
    const activeMs = (): number => {
      const now = this.now();
      return now - segmentStart - pausedMs - (pausedAt !== null ? now - pausedAt : 0);
    };
    const touch = (): void => {
      run.elapsedMs = elapsedBefore + activeMs();
    };

    // Side effects recorded before this segment, per call, in the order they
    // happened. A resumed run that issues one of them again is answered from
    // here instead of executing — once per recorded execution: the entry is
    // consumed, so a call made MORE often than it was recorded executes
    // normally. A recorded failure is not here at all: it may be retried.
    run.effects ??= Object.entries(run.executedDigests).map(([d, r]) =>
      r === IN_FLIGHT ? { d, s: "started" as const } : { d, s: "done" as const, r },
    );
    const replay = new Map<string, TaskEffect[]>();
    for (const effect of run.effects) {
      if (effect.s === "error") continue;
      const queue = replay.get(effect.d);
      if (queue) queue.push(effect);
      else replay.set(effect.d, [effect]);
    }
    const replayable = (digest: string): boolean => (replay.get(digest)?.length ?? 0) > 0;

    // Run-log appends are fire-and-forget from sync callbacks but must stay ordered.
    let logChain: Promise<void> = Promise.resolve();
    const logEvent = (event: RunEvent): void => {
      logChain = logChain
        .then(() => this.saveEvent(task.id, run.id, event, this.now()))
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

    // Deliberately NOT unref'd: while a run is in flight this breaker must be
    // able to fire even if nothing else is keeping the event loop alive (a
    // provider or tool waiting on a promise with no handle behind it). It is
    // cleared in the finally below, so it never outlives the run.
    let wallclock: NodeJS.Timeout | undefined;
    const armWallclock = (): void => {
      const remainingMs = budget.wallclockMs - elapsedBefore - activeMs();
      if (remainingMs <= 0) stopWith("budget_wallclock");
      wallclock = setTimeout(() => stopWith("budget_wallclock"), Math.max(0, remainingMs));
    };
    armWallclock();

    // ── waiting for a human ──
    // While a call waits for an approval the run is `awaiting_approval` (task
    // and run, visible in the API and over SSE): its wall clock is paused, its
    // lease keeps renewing on the lease's own timer, and a cancel from another
    // process is still noticed — it aborts the run, which turns the pending
    // approval into a deny. The ask itself, its answer and its expiry are the
    // gate's (Warden's inbox).
    //
    // Waiting has a ceiling (#422 review L4): a run may ask at most
    // `budget.maxApprovals` times (default 5) and wait at most
    // `budget.approvalWaitMs` in all (default 60 minutes), both clamped to a
    // hard maximum and counted across segments. Past either the run stops
    // with `approval_limit` — one ordinary failure notice — instead of
    // holding its slot and lease for hours and announcing ask after ask. The
    // ask that would go over is not announced at all.
    const maxApprovals = Math.max(
      0,
      Math.min(budget.maxApprovals ?? DEFAULT_MAX_APPROVALS, MAX_APPROVALS_LIMIT),
    );
    const waitCapMs = Math.max(
      0,
      Math.min(
        budget.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS,
        cloud ? MAX_APPROVAL_WAIT_MS_CLOUD : MAX_APPROVAL_WAIT_MS,
      ),
    );
    const duration = (ms: number): string => {
      const [n, unit] =
        ms < 60_000
          ? [Math.max(1, Math.ceil(ms / 1000)), "second"]
          : [Math.round(ms / 60_000), "minute"];
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    };
    const waitedTooLong = `it waited ${duration(waitCapMs)} for approvals in all, the most a run may (budget.approvalWaitMs); it stopped instead of waiting longer`;
    let waiting = 0;
    /** Asks refused at the ceiling: their `ended` is not a wait ending. */
    let refused = 0;
    let waitCeiling: NodeJS.Timeout | undefined;
    let cancelPoll: NodeJS.Timeout | undefined;
    const approvalWait: TaskApprovalWait = {
      started: async ({ tool }) => {
        const refuse = (why?: string): false => {
          refused += 1;
          if (why) stopWith("approval_limit", why);
          return false;
        };
        // Already stopping: nothing to wait for, nobody to tell.
        if (slot.stop || slot.controller.signal.aborted) return refuse();
        const asked = (run.approvals ?? 0) + 1;
        if (asked > maxApprovals) {
          return refuse(
            `it asked for approval ${maxApprovals} time${maxApprovals === 1 ? "" : "s"}, the most a run may (budget.maxApprovals); it stopped instead of asking again`,
          );
        }
        if ((run.approvalWaitMs ?? 0) >= waitCapMs) return refuse(waitedTooLong);
        run.approvals = asked;
        waiting += 1;
        if (waiting > 1) return true;
        if (pausedAt === null) {
          clearTimeout(wallclock);
          pausedAt = this.now();
        }
        waitCeiling = setTimeout(
          () => stopWith("approval_limit", waitedTooLong),
          Math.max(0, waitCapMs - (run.approvalWaitMs ?? 0)),
        );
        cancelPoll = setInterval(
          () => void cancelRequested(),
          this.opts.approvalCancelPollMs ?? APPROVAL_CANCEL_POLL_MS,
        );
        logEvent({ type: "approval", toolName: tool, summary: "waiting for approval" });
        run.state = "awaiting_approval";
        touch();
        await this.saveRun(run, this.now());
        const parked = await this.saveTask(task.id, (t) => {
          if (t.activeRunId !== run.id) return false;
          t.state = "awaiting_approval";
        });
        if (parked) this.emit({ type: "task_updated", task: parked });
        return true;
      },
      ended: async ({ approved }) => {
        if (refused > 0) {
          refused -= 1;
          return;
        }
        if (waiting === 0) return;
        waiting -= 1;
        if (waiting > 0) return;
        clearInterval(cancelPoll);
        cancelPoll = undefined;
        clearTimeout(waitCeiling);
        waitCeiling = undefined;
        if (pausedAt !== null) {
          const waited = this.now() - pausedAt;
          pausedMs += waited;
          run.approvalWaitMs = (run.approvalWaitMs ?? 0) + waited;
          pausedAt = null;
          if (!slot.stop) armWallclock();
        }
        logEvent({ type: "approval", summary: approved ? "approved" : "not approved" });
        // A run that is stopping (cancelled, shut down, lease lost) writes
        // nothing more here: how it ends is recorded by whoever ends it.
        if (slot.leaseLost || slot.controller.signal.aborted) return;
        run.state = "running";
        touch();
        await this.saveRun(run, this.now());
        const back = await this.saveTask(task.id, (t) => {
          if (t.activeRunId !== run.id) return false;
          t.state = "running";
        });
        if (back) this.emit({ type: "task_updated", task: back });
      },
    };

    // What this segment may still spend under the run's spend ceiling.
    const capLeft =
      budget.usdMicros !== undefined ? budget.usdMicros - (run.capSpentMicros ?? 0) : undefined;
    let capMessage: string | undefined;

    try {
      if (capLeft !== undefined && !(capLeft > 0)) {
        // Spent in an earlier segment (a failed attempt counts): not one more call.
        return {
          state: "failed",
          stopReason: "budget_usd",
          summary: "",
          error: `spend ceiling reached — $${(budget.usdMicros! / 1_000_000).toFixed(2)} already counted against this run`,
        };
      }
      const surface =
        typeof this.opts.tools === "function" ? await this.opts.tools() : this.opts.tools;
      // A run started by a watcher hit carries text an outsider controls: it
      // gets what a remote channel gets (no skill_manage, no KB writes, …).
      const tools = taskToolset(surface, task.envelope, {
        untrustedInput: run.input !== undefined,
      });
      const toolMap = new Map(tools.map((t) => [t.name, t]));
      // Unattended ⇒ the bounded sandbox mode, whatever the process default is.
      const sandboxMode =
        this.opts.sandboxMode ?? sandboxModeForProfile(cloud ? "cloud-autonomy" : "local-autonomy");
      // The task's own folder, never the server's cwd; under a bounded mode
      // nothing else in the Lisa home is writable from the run.
      const workspace = await ensureTaskWorkspace(task.id);
      const caps = taskCapabilities(workspace, sandboxMode);

      const handle = await this.approvalFactory()?.({
        taskId: task.id,
        runId: run.id,
        runStartedAt: run.startedAt,
        origin: {
          kind: task.kind === "routine" ? "routine" : task.kind === "watcher" ? "watcher" : "task",
          id: task.id,
        },
        ...(task.envelope ? { envelope: task.envelope } : {}),
        // Only an envelope the user confirmed as they see it now is a
        // pre-approval; a drafted or edited one only restricts the toolset.
        envelopeConfirmed: isEnvelopeConfirmed(task),
        uid: task.owner,
        home: lisaHome(),
        title: task.title,
        // A run a watcher hit started quotes an outsider's text in its prompt,
        // and a continued run that was tainted still has that content in its
        // history: either way it is tainted from its first call.
        tainted: run.input !== undefined || run.tainted === true,
        // Recorded on the run; the checkpoint after the call that tainted it
        // lands before that call's result is in the saved history.
        onTaint: () => {
          run.tainted = true;
        },
        cwd: workspace,
        sandboxMode,
        tools,
        signal: slot.controller.signal,
        approvalWait,
      });
      // No factory, or a factory that offers no gate ⇒ the safe default.
      const gate: ApprovalCallback = handle?.approval ?? denySideEffects();
      const approval: ApprovalCallback = async (name, input) => {
        // Already approved and executed before the interruption: it is answered
        // from the ledger below, so there is nothing new to approve.
        if (isSideEffectingCall(name, input) && replayable(digestCall(name, input))) {
          return { allow: true };
        }
        const decision = await gate(name, input);
        // The run is being stopped under this call — shutdown, a lost lease,
        // an outcome that could not be recorded — and that is what ended a
        // pending approval: nobody answered it. That refusal must not reach
        // the model, and must not be saved in the run's history: the resumed
        // run issues the call again and asks again. (A cancel or a breaker is
        // a real ending: its refusal is told as usual and the run then stops.)
        if (!decision.allow && slot.controller.signal.aborted && !slot.stop) {
          if (slot.leaseLost) throw lostLease(slot);
          throw new Interrupted();
        }
        return decision;
      };

      const inner = this.opts.provider ?? providerForModel(model);
      const provider: Provider = {
        name: inner.name,
        runTurn: async (o) => {
          // Every model call clears the same breakers, in the same order.
          if (await cancelRequested()) throw notSent(new TaskStop("cancelled"));
          if (slot.stop) throw notSent(new TaskStop(slot.stop, slot.stopDetail));
          // Stopping (shutdown, a lost lease, an unrecordable outcome): no
          // further model call in this segment, whatever the provider would do
          // with an aborted signal.
          if (slot.controller.signal.aborted) throw notSent(new Interrupted());
          if (tokensSpent(run) >= budget.tokens) {
            stopWith("budget_tokens");
            throw notSent(new TaskStop("budget_tokens"));
          }
          // `>`: after the last allowed call the model still gets a turn to answer.
          if (run.toolCalls > budget.maxToolCalls) {
            stopWith("budget_tool_calls");
            throw notSent(new TaskStop("budget_tool_calls"));
          }
          if (budget.usdMicros !== undefined && (run.costMicros ?? 0) >= budget.usdMicros) {
            stopWith("budget_usd");
            throw notSent(new TaskStop("budget_usd"));
          }
          const admission = this.opts.modelGate ? await this.opts.modelGate.admit(model) : null;
          if (admission && !admission.ok) {
            // Busy (the tenant is mid-chat-turn) or rate-limited: an ordinary
            // failure, retried with backoff. No allowance: stop and tell the user.
            if (admission.transient)
              throw notSent(new Error(`admission busy: ${admission.reason}`));
            stopWith("admission_denied", admission.reason);
            throw notSent(new TaskStop("admission_denied", admission.reason));
          }
          try {
            const result = await inner.runTurn(o);
            run.tokens.in += result.usage.inputTokens;
            run.tokens.out += result.usage.outputTokens;
            if (result.usage.cacheReadTokens > 0) {
              run.tokens.cacheRead = (run.tokens.cacheRead ?? 0) + result.usage.cacheReadTokens;
            }
            if (result.usage.cacheWriteTokens > 0) {
              run.tokens.cacheWrite = (run.tokens.cacheWrite ?? 0) + result.usage.cacheWriteTokens;
            }
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
            await this.saveRun(run, this.now());
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
          cwd: workspace,
          signal: slot.controller.signal,
          log: (m) => this.log(`${task.id}: ${m}`),
          sandboxMode,
          ...(caps ? { caps } : {}),
        },
        history,
        userMessage,
        model,
        maxIterations: Math.max(4, Math.min(64, budget.maxToolCalls + 2)),
        moodOrigin: "a task run",
        // The spend ceiling, as #407's estimate-based cap: each model call is
        // admitted only if its worst case still fits in what is left, and a
        // call that fails after it was sent is counted too. What earlier
        // segments of this run counted is off the top.
        ...(capLeft !== undefined
          ? {
              costCapMicroUSD: capLeft,
              onCostCharged: (microUSD: number) => {
                // Unreadable usage spends the whole ceiling: a resumed
                // segment must not start with it looking unspent.
                run.capSpentMicros =
                  Number.isFinite(microUSD) && microUSD >= 0
                    ? (run.capSpentMicros ?? 0) + microUSD
                    : budget.usdMicros;
              },
            }
          : {}),
        approval,
        onMessagePersist: async (message) => {
          await this.saveMessage(task.id, run.id, message, this.now());
        },
        onEvent: (event: AgentEvent) => {
          try {
            handle?.observe?.(event);
          } catch {
            // An observer must never break the run it observes.
          }
          if (event.type === "info" && /\bcost cap\b/.test(event.message ?? "")) {
            capMessage = (event.message ?? "")
              .replace(/^\[agent\]\s*/, "")
              .replace(/\s*\(stopReason=budget_exceeded\)\s*$/, "");
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
          if (slot.controller.signal.aborted) return { block: "run is stopping" };
          if (!isSideEffectingCall(name, input)) return;
          // Fencing: a runner that no longer owns the lease must not act.
          await this.fence();
          const digest = digestCall(name, input);
          const queue = replay.get(digest);
          const recorded = queue?.[0];
          // An unknown outcome is never consumed: a second identical request
          // must not turn uncertainty into permission to repeat the side effect.
          if (recorded && recorded.s !== "started") queue.shift();
          if (recorded !== undefined) {
            logEvent({ type: "replayed", toolName: name });
            if (recorded.s === "started") {
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
                `not executed again. Recorded result:\n${recorded.r ?? ""}`,
            };
          }
          // A call the agent loop is about to reject as malformed never executes.
          const tool = toolMap.get(name);
          if (tool && !validateToolInput(tool.inputSchema, input).ok) return;
          // Write-ahead: if we die inside the tool, the resumed run knows it started.
          const previous = run.executedDigests[digest];
          const entry: TaskEffect = { d: digest, s: "started" };
          run.executedDigests[digest] = IN_FLIGHT;
          run.effects!.push(entry);
          touch();
          try {
            await this.saveRun(run, this.now());
          } catch (err) {
            // Not recorded, so not executed (the throw stops the call): take
            // the entry back, so no later checkpoint claims it ever started.
            run.effects!.splice(run.effects!.indexOf(entry), 1);
            if (previous === undefined) delete run.executedDigests[digest];
            else run.executedDigests[digest] = previous;
            throw err;
          }
          return;
        },
        postToolHook: async (name, input, text, isError) => {
          // An error out of a call we aborted says nothing about whether its
          // effect landed — leave it in-flight ("outcome unknown") rather than
          // recording a failure the resumed run would trust.
          const aborted = isError && slot.controller.signal.aborted;
          if (isSideEffectingCall(name, input) && !aborted) {
            const digest = digestCall(name, input);
            const recorded = clip(text, MAX_RECORDED_RESULT);
            run.executedDigests[digest] = isError ? `[error] ${recorded}` : recorded;
            // Close the entry preToolHook opened for this execution.
            const open = run.effects!.findLast((e) => e.d === digest && e.s === "started");
            if (open) {
              open.s = isError ? "error" : "done";
              open.r = recorded;
            }
            touch();
            try {
              await this.saveRun(run, this.now());
            } catch (err) {
              // The call HAS run; only recording its outcome failed. That must
              // never reach the model as a tool error — it would issue the
              // call again, and it would execute again. Stop the run as
              // interrupted instead, with the ledger as it is on disk
              // (`started`): the resume answers a re-issued call with
              // "outcome unknown; not executed again".
              if (open) {
                open.s = "started";
                delete open.r;
              }
              run.executedDigests[digest] = IN_FLIGHT;
              if (err instanceof LeaseLost || err instanceof TaskGoneError) throw err;
              slot.interrupted = `the outcome of ${name} could not be recorded (${String((err as Error)?.message ?? err).slice(0, 160)})`;
              slot.controller.abort();
              return;
            }
            await cancelRequested();
            return;
          }
          touch();
          await this.saveRun(run, this.now());
          await cancelRequested();
        },
      });
      await logChain;

      // Stopped as interrupted (an outcome that could not be recorded): not an
      // ending of the run, whatever the loop returned.
      if (slot.interrupted) throw new Interrupted();
      const text = result.finalText.trim();
      if (result.stopReason === "max_iterations") {
        return {
          state: "failed",
          stopReason: "max_iterations",
          summary: text,
          error: "ran out of turns",
        };
      }
      // Only the cost cap stops runAgent this way here (the token ceiling is
      // the runner's own): the next call would not have fitted under it.
      if (result.stopReason === "budget_exceeded") {
        if (slot.leaseLost) throw lostLease(slot);
        return {
          state: "failed",
          stopReason: "budget_usd",
          summary: text,
          error: `spend ceiling reached — ${capMessage ?? "the next model call would not fit in what is left"}`,
        };
      }
      if (slot.leaseLost) throw lostLease(slot);
      return { state: "succeeded", stopReason: result.stopReason, summary: text };
    } catch (err) {
      await logChain;
      // The task was deleted under the run: there is nowhere to record anything.
      if (err instanceof TaskGoneError) throw err;
      // Lost lease: not an outcome of the run at all. Nothing is recorded.
      if (err instanceof LeaseLost || slot.leaseLost) throw lostLease(slot);
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
      clearInterval(cancelPoll);
      clearTimeout(waitCeiling);
      touch();
    }
  }

  // ── finishing a run ──

  /**
   * End a run. Two steps, and a crash between them loses nothing:
   *
   *   1. the run's terminal record is written — from here on the run is over,
   *      and everything needed to finish the bookkeeping is in that record;
   *   2. completeFinish() derives the notice and the task's next state from it.
   *
   * If the process dies after 1, the task still points at a run that is
   * already terminal; the next tick sees that and runs step 2 again instead of
   * running the task again (runTask).
   */
  private async finish(task: Task, run: TaskRun, outcome: Outcome): Promise<void> {
    const now = this.now();
    run.state = outcome.state;
    run.endedAt = now;
    run.stopReason = outcome.stopReason;
    if (outcome.summary) run.summary = clip(outcome.summary, MAX_SUMMARY);
    if (outcome.error) run.error = outcome.error;
    if (outcome.blocked) run.blocked = true;
    if (outcome.pause) run.pausesTask = true;
    await this.saveRun(run, now);
    await this.completeFinish(task.id, run);
  }

  /**
   * Bring the task in line with a run that has ended. Idempotent: the notices
   * have stable ids and are enqueued BEFORE the task is updated, and the task
   * update is what clears `activeRunId` — so re-running this after a crash at
   * any point enqueues nothing twice and loses nothing.
   */
  private async completeFinish(taskId: string, run: TaskRun): Promise<void> {
    const before = await getTask(taskId);
    if (!before) {
      // Deleted while it ran: its grants end with it.
      await this.taskRemoved(taskId);
      return;
    }
    const now = run.endedAt ?? this.now();
    const cloud = this.host === "cloud";

    // Dry run on a copy to learn which notices this ending produces…
    const notices = settleTask(structuredClone(before), run, now, cloud);
    for (const n of notices) {
      await this.saveNotice(
        {
          id: noticeId(run.id, n.kind),
          uid: before.owner,
          taskId: before.id,
          runId: run.id,
          title: before.title,
          summary: clip(n.summary, 4000),
          status: run.state,
          ...(run.artifacts ? { artifacts: run.artifacts } : {}),
          priority: n.priority,
          kind: n.kind,
        },
        this.now(),
      );
    }
    // Whatever the gate granted "for this task" ends with the run, whatever
    // its outcome. Before the write that ends the finish: if this throws, the
    // task still points at the run and the next tick completes the finish —
    // and this — again.
    await this.approvalFactory()?.runEnded?.({
      taskId: before.id,
      runId: run.id,
      uid: before.owner,
      home: lisaHome(),
    });
    // …then the same transition for real. This write ends the finish.
    const updated = await this.saveTask(
      taskId,
      (t) => {
        settleTask(t, run, now, cloud);
      },
      this.now(),
    );

    this.emit({
      type: "task_run_finished",
      taskId,
      runId: run.id,
      state: run.state,
      ...(run.stopReason ? { stopReason: run.stopReason } : {}),
      ...(run.summary ? { summary: run.summary.slice(0, 500) } : {}),
    });
    if (updated) this.emit({ type: "task_updated", task: updated });
    if (notices.length > 0) await this.flushOutbox(run.id);
  }

  private async flushOutbox(runId: string): Promise<void> {
    try {
      await drainOutbox(this.deliver(), this.now());
    } catch (err) {
      // The notice is durable; delivery is retried at the next tick.
      this.log(`delivery of ${runId} deferred: ${(err as Error).message}`);
    }
  }

  private async notify(
    task: Task,
    run: TaskRun,
    kind: TaskNotice["kind"],
    summary: string,
    priority: TaskNotice["priority"],
  ): Promise<void> {
    try {
      await this.saveNotice(
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
      if (err instanceof LeaseLost || err instanceof TaskGoneError) throw err;
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
    if (slot.controller.signal.aborted && slot.stop !== "cancelled") {
      // Shutdown (or a lost lease) cut the check off. That says nothing about
      // the watched thing: record nothing, count no failure, poll again later.
      if (slot.leaseLost) throw lostLease(slot);
      return;
    }
    if (slot.stop === "cancelled") {
      // The user cancelled the poll: back to rest, nothing recorded against the watcher.
      const rested = await this.saveTask(
        task.id,
        (t) => {
          delete t.cancelRequestedAt;
          delete t.queued;
          t.state = restingState(t);
          if (t.enabled) t.nextRunAt = nextRunAfter(t, now, cloud);
          else delete t.nextRunAt;
        },
        now,
      );
      if (rested) this.emit({ type: "task_updated", task: rested });
      return;
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
        (await this.newRun(
          task.id,
          { id: runId, state: "succeeded", input: hit.detail, trigger: "watcher" },
          now,
        ));
      run.endedAt = now;
      run.stopReason = "watch_hit";
      run.summary = cleanHitSummary(hit.summary);
      await this.saveRun(run, now);
      this.emit({
        type: "task_run_finished",
        taskId: task.id,
        runId,
        state: "succeeded",
        stopReason: "watch_hit",
        summary: run.summary.slice(0, 500),
      });
      await this.notify(task, run, "watch_hit", describeHit(hit), "high");
    }

    const updated = await this.saveTask(
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
        // `t` is re-read here, under the lease: a watcher switched off while
        // its check was in flight records the hit (its baseline moves on) but
        // queues no run — starting a non-manual run needs the task enabled.
        if (hit && t.trigger?.onHit === "run" && t.enabled) {
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
      const run =
        existing?.run ??
        (await this.newRun(task.id, { id: runId, state: "failed", trigger: "watcher" }, now));
      run.endedAt = now;
      run.stopReason = "watch_failing";
      run.error = outcome.error.slice(0, 500);
      await this.saveRun(run, now);
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
