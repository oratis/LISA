/**
 * Task Engine types (W1 of docs/PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md).
 *
 * A Task is a durable unit of unattended work the USER asked for: a one-off,
 * a routine (scheduled), a watcher (condition-triggered) or a goal. It is
 * distinct from Lisa's own autonomy (desire pursuit / examen / desire review),
 * which stays in the heartbeat and is not modelled here.
 *
 * Everything in this file is plain data — it is what lands on disk under
 * `<lisaHome>/tasks/` and what the HTTP API returns, so changes must stay
 * additive (bump TASK_SCHEMA_VERSION + add a migration in store.ts otherwise).
 */
import type { ApprovalCallback } from "../agent.js";
import type { SandboxMode } from "../sandbox/mode.js";
import type { AgentEvent, ToolDefinition } from "../types.js";

/** On-disk schema version of a Task file. */
export const TASK_SCHEMA_VERSION = 1;

export type TaskKind = "oneoff" | "routine" | "watcher" | "goal";

export type TaskState =
  | "draft"
  | "scheduled"
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "paused";

export type TaskHost = "home" | "cloud" | "any";

export type TaskNotify = "always" | "on_change" | "on_hit" | "silent_on_noop";

export interface TaskOrigin {
  kind: "chat" | "api" | "heartbeat" | "recipe";
  messageId?: string;
}

/**
 * When a task runs. `expr` is one of:
 *   at:<ISO-8601>            once
 *   every:<n>(m|h|d)         fixed interval (min 5m local / 30m cloud)
 *   daily:HH:MM              every day at wall-clock time in `tz`
 *   weekdays:HH:MM           Mon–Fri
 *   weekly:<mon..sun>@HH:MM  one weekday
 *   cron:<m h dom mon dow>   5-field cron (numbers, lists, ranges, steps)
 * `tz` is an IANA zone; unset ⇒ the process's local zone.
 */
export interface ScheduleSpec {
  expr: string;
  tz?: string;
}

export type WatchCompareMode = "changed" | "appears" | "disappears" | "above" | "below";

export interface WebTrigger {
  kind: "web";
  url: string;
  /** Narrow the page before comparing: a tiny CSS-ish selector (tag, #id, .class). */
  selector?: string;
  /** Regex whose first capture group (or whole match) is the watched value. */
  regex?: string;
  /** Plain substring to look for (appears / disappears). */
  contains?: string;
  mode: WatchCompareMode;
  /** Numeric threshold for above / below. */
  threshold?: number;
}

export interface RssTrigger {
  kind: "rss";
  url: string;
  /** Any-of keywords matched against title + summary; empty ⇒ every new item. */
  keywords?: string[];
}

export interface MailTrigger {
  kind: "mail";
  /** Case-insensitive substring of the sender. */
  from?: string;
  /** Case-insensitive substring of the subject. */
  subject?: string;
}

export type TriggerSpec = (WebTrigger | RssTrigger | MailTrigger) & {
  /** How often to poll, same `every:` grammar as ScheduleSpec. Default every:30m. */
  every?: string;
  /** On hit: just tell the user (default), or run the task instruction with the hit as input. */
  onHit?: "notify" | "run";
};

/** Watcher bookkeeping, persisted on the task so hits dedupe across restarts. */
export interface WatchState {
  lastCheckedAt?: number;
  lastHitAt?: number;
  /** Fingerprint of the last observed value (sha256 hex). */
  lastFingerprint?: string;
  /** Last boolean condition (appears/disappears/above/below) — the hysteresis bit. */
  lastCondition?: boolean;
  /** Consecutive observations contradicting `lastCondition` (re-arm counter). */
  contrary?: number;
  /** Recently seen item ids (rss guid / mail uid), capped. */
  seen?: string[];
  /** Consecutive fetch failures (drives backoff + a single "watch is failing" notice). */
  failures?: number;
  lastError?: string;
}

/**
 * What a task may use and — once the user has CONFIRMED it — what it may do
 * without asking.
 *
 * Until it is confirmed (`Task.envelopeConfirmation`, confirmation.ts) an
 * envelope only RESTRICTS: the runner offers the model only the tools inside
 * it, and nothing is pre-approved. The model can draft one (task_create's
 * `tools`); only the user's confirmation, given after seeing it in plain
 * words, makes it a pre-approval — and even then taint overrides it for side
 * effects (docs/DESIGN_WARDEN.md).
 */
export interface TaskEnvelope {
  /**
   * Action categories (Warden's: "write", "exec", "send", …). Labels Warden
   * does not know ("web", "mail") are informational and pre-approve nothing.
   */
  categories?: string[];
  /** Exact tool names allowed. Unset ⇒ every non-mutating tool on the surface. */
  tools?: string[];
  /** Targets (hosts, paths, repos) a pre-approval is limited to. */
  targets?: string[];
}

export interface TaskEnvelopeConfirmation {
  /** `taskDigest()` of the task as the user confirmed it. */
  digest: string;
  /** When they confirmed it. */
  at: number;
  /** Where: the terminal (`lisa tasks enable`) or the HTTP API. */
  via: "cli" | "api";
}

export interface TaskBudget {
  /** Cumulative token ceiling per run: input + output + cache reads + cache writes. */
  tokens: number;
  /** Optional spend ceiling per run, in millionths of a USD. */
  usdMicros?: number;
  /** Wall-clock ceiling per run. */
  wallclockMs: number;
  /** Tool-call ceiling per run. */
  maxToolCalls: number;
  /**
   * How many times a run may ask for an approval (default 5, at most
   * MAX_APPROVALS_LIMIT). The next ask stops the run (`approval_limit`)
   * instead of waiting — and is not announced.
   */
  maxApprovals?: number;
  /**
   * Total time a run may spend waiting for approvals, across its asks and
   * segments (default 60 minutes, at most MAX_APPROVAL_WAIT_MS — 15 minutes
   * hosted). Past it the run stops (`approval_limit`).
   */
  approvalWaitMs?: number;
}

/** Asks a run may make when its budget says nothing (#422 review L4). */
export const DEFAULT_MAX_APPROVALS = 5;
/** Hard ceiling on `budget.maxApprovals`, whatever a task file says. */
export const MAX_APPROVALS_LIMIT = 20;
/** Waiting a run may do when its budget says nothing. */
export const DEFAULT_APPROVAL_WAIT_MS = 60 * 60_000;
/** Hard ceiling on `budget.approvalWaitMs` at home… */
export const MAX_APPROVAL_WAIT_MS = 6 * 3_600_000;
/** …and hosted, where a waiting run holds its sweep request open. */
export const MAX_APPROVAL_WAIT_MS_CLOUD = 15 * 60_000;

export interface Task {
  id: string;
  /** TASK_SCHEMA_VERSION at write time. */
  version: number;
  /** Owning account uid (cloud) or null (single-user Mac edition). */
  owner: string | null;
  kind: TaskKind;
  title: string;
  instruction: string;
  origin: TaskOrigin;
  host: TaskHost;
  schedule?: ScheduleSpec;
  trigger?: TriggerSpec;
  watch?: WatchState;
  envelope?: TaskEnvelope;
  /**
   * The user confirmed the envelope as a pre-approval. Holds the digest
   * (confirmation.ts `taskDigest`) of exactly what they were shown: the
   * instruction, the schedule or trigger, the envelope and the notify mode.
   * It counts only while that digest still matches the task, every edit of
   * those fields clears it, and so does every enable. Only the user's own act
   * sets it (`lisa tasks enable` on a terminal or with `--confirm <digest>`,
   * `PATCH /api/tasks/{id}` from a caller who may approve); no model tool can.
   */
  envelopeConfirmation?: TaskEnvelopeConfirmation;
  budget: TaskBudget;
  notify: TaskNotify;
  state: TaskState;
  enabled: boolean;
  /** True when the model created it — it stays disabled until the user enables it. */
  createdDisabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** When the user last turned it on. Unset ⇒ never enabled (still a draft). */
  enabledAt?: number;
  lastRunAt?: number;
  nextRunAt?: number;
  /**
   * Why the engine switched the task off by itself (allowance refused, a
   * settlement that could not be recorded, repeated credential failures, a
   * schedule that cannot be computed). Cleared when the user enables it again.
   */
  pausedReason?: string;
  /** Consecutive auth failures; the scheduler pauses the task past a threshold. */
  authFailureCount: number;
  /** Consecutive failed runs (drives retry backoff; reset on success). */
  failureCount?: number;
  /** Fingerprint of the last delivered result, for notify: on_change. */
  lastResultFingerprint?: string;
  /** Short summary of the last finished run, fed into the next run's task frame. */
  lastSummary?: string;
  /**
   * `lastSummary` was written by a run that read outside content (#422 review
   * N3). The next run's frame then quotes it inside the external-content
   * markers, as data, and that run is tainted from its first call.
   */
  lastSummaryTainted?: boolean;
  /**
   * A run that had read outside content made state-changing calls while the
   * task's own folder was writable to it: what it left there is outside text
   * too, so every later run of the task starts tainted. Never cleared.
   */
  workspaceTainted?: boolean;
  /**
   * The run currently in flight. Set when a run starts and cleared when it
   * finishes; a value here with no live lease means the run was interrupted
   * and must be resumed.
   */
  activeRunId?: string;
  /**
   * Set while the active run is parked between attempts: it failed on a
   * transient error and will be RESUMED — same run, same history, same ledger
   * of side effects — at this time. Never a fresh run.
   */
  resumeAt?: number;
  /** Set by a cancel request; the runner (in whichever process) stops at its next checkpoint. */
  cancelRequestedAt?: number;
  /** Why the task is `queued`: a manual "run now", a retry, or a watcher hit with its input. */
  queued?: { manual?: boolean; input?: string };
  /** Run ids, oldest first, capped at MAX_RUNS_PER_TASK. */
  runs: string[];
}

export type TaskRunState =
  | "queued"
  | "running"
  | "interrupted"
  | "awaiting_approval"
  | "awaiting_input"
  | "succeeded"
  | "failed"
  | "cancelled";

/** manual — the user ("run now", a test run); scheduled — the schedule; watcher — a watcher hit. */
export type TaskRunTrigger = "manual" | "scheduled" | "watcher";

export interface TaskRun {
  id: string;
  taskId: string;
  startedAt: number;
  endedAt?: number;
  state: TaskRunState;
  stopReason?: string;
  /**
   * Tokens the run has processed. Cache reads and writes are counted too: they
   * are tokens the provider processed and billed, and a long run is mostly
   * cache traffic — leaving them out makes the budget meaningless.
   */
  tokens: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
  costMicros?: number;
  /**
   * What the spend ceiling (`budget.usdMicros`) has counted against this run,
   * micro-USD, across its segments: every call's charge, and a call that
   * failed after it was sent at its worst case. Unset on a run without a ceiling.
   */
  capSpentMicros?: number;
  toolCalls: number;
  /** sha256(tool + canonical input) → the LAST recorded result of that call (for inspection). */
  executedDigests: Record<string, string>;
  /**
   * The ledger proper: every execution of a side-effecting call, in order.
   * One entry per execution, so the same call made twice is two entries — a
   * resumed run replays exactly as many as were recorded, each once.
   */
  effects?: TaskEffect[];
  /** How many times this run was resumed after an interruption. */
  resumes?: number;
  /** The run ended on a credential / allowance problem (kept so a finish can be completed later). */
  blocked?: boolean;
  /** The run ended on a billing refusal that switches the task off. */
  pausesTask?: boolean;
  /** Failed attempts so far. Each retry continues this run; none starts a new one. */
  attempts?: number;
  /** Why the last attempt stopped, when the run is parked for a retry. */
  lastError?: string;
  /** Wall-clock time spent executing, summed across resumed segments. */
  elapsedMs?: number;
  /** Approvals the run has asked for, across its segments (`budget.maxApprovals`). */
  approvals?: number;
  /** Time spent waiting for approvals, across its segments (`budget.approvalWaitMs`). */
  approvalWaitMs?: number;
  /** Started by the user ("run now"/test run) rather than by the schedule. */
  manual?: boolean;
  /**
   * What started the run, written in its FIRST record (createRun) — so whether
   * it may continue is read from the run itself and never depends on task
   * state a failed write or a crash could lose. Absent on older runs; there
   * `manual` decides.
   */
  trigger?: TaskRunTrigger;
  /** Input handed to the run by a watcher hit, if any. */
  input?: string;
  /**
   * Untrusted content has entered this run (the approval gate said so, or the
   * runner saw a call to a tool that returns outside text go through). Kept
   * on the run so a resumed or retried segment starts tainted: the content is
   * still in its history.
   */
  tainted?: boolean;
  /**
   * The run started tainted because of what an earlier run of the task left:
   * a last summary written by a tainted run (quoted in this run's frame), or
   * a folder a tainted run wrote to. Written in the run's first record.
   */
  inheritedTaint?: boolean;
  summary?: string;
  artifacts?: TaskArtifact[];
  error?: string;
}

export interface TaskEffect {
  /** sha256(tool + canonical input). */
  d: string;
  /**
   * started — written before the tool ran; no result was ever recorded (unknown outcome).
   * done    — it returned; `r` is what it returned.
   * error   — it threw; nothing is assumed to have happened, and it is never replayed.
   */
  s: "started" | "done" | "error";
  r?: string;
}

/** Every token a run has processed, cached or not — what `budget.tokens` is measured against. */
export function tokensSpent(run: Pick<TaskRun, "tokens">): number {
  const t = run.tokens;
  return t.in + t.out + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
}

export interface TaskArtifact {
  kind: "text" | "link" | "file";
  title?: string;
  value: string;
}

/** Cap on `Task.runs`; older run files are pruned past it. */
export const MAX_RUNS_PER_TASK = 50;

export const DEFAULT_TASK_BUDGET: TaskBudget = {
  tokens: 200_000,
  wallclockMs: 10 * 60_000,
  maxToolCalls: 40,
};

// ── integration points (implemented by other PRs, injected via wiring.ts) ──

export interface TaskApprovalContext {
  taskId: string;
  runId: string;
  /** When the run first started. A task-scoped grant older than this belongs to an earlier run. */
  runStartedAt: number;
  origin: { kind: "task" | "routine" | "watcher"; id: string };
  envelope?: TaskEnvelope;
  /**
   * The user confirmed this envelope (confirmation.ts `isEnvelopeConfirmed`).
   * False ⇒ the envelope only restricts what the run is offered and a gate
   * must not treat it as a pre-approval of anything.
   */
  envelopeConfirmed: boolean;
  uid: string | null;
  /** The tenant home the run works in (`lisaHome()` inside the run's scope). */
  home: string;
  /** The task's title, for approval cards and notices. */
  title: string;
  /**
   * The run already carries untrusted content: it was started by a watcher hit
   * (its prompt quotes an outsider's text), or it became tainted before an
   * interruption or a failed attempt and is being continued.
   */
  tainted: boolean;
  /** Call once when the run becomes tainted; the runner records it on the run. */
  onTaint: () => void;
  /** The run's working directory (the workspace root a gate judges paths against). */
  cwd: string;
  /** The sandbox mode the run's tools execute under. */
  sandboxMode: SandboxMode;
  /** The tools the run is offered. */
  tools: ToolDefinition[];
  /** Aborted when the run stops (cancel, shutdown, a lost lease). A pending approval is then a deny. */
  signal: AbortSignal;
  /**
   * What a gate calls while a call waits for a human answer. The runner shows
   * the run as `awaiting_approval` and stops its wall clock in between.
   */
  approvalWait: TaskApprovalWait;
}

export interface TaskApprovalWait {
  /**
   * An approval for `tool` is now pending. Resolves false when the run will
   * not wait for it — it has asked or waited as much as its budget allows and
   * is stopping (`approval_limit`): the gate must then not tell the user.
   */
  started(info: { tool: string; approvalId?: string }): Promise<boolean | void>;
  /** It was answered, expired or cancelled. Called once per `started`. */
  ended(info: { approved: boolean }): Promise<void>;
}

export interface TaskApprovalHandle {
  approval?: ApprovalCallback;
  observe?: (e: AgentEvent) => void;
}

/** What a factory is told when a run has ended. */
export interface TaskRunEndContext {
  taskId: string;
  runId: string;
  uid: string | null;
  home: string;
}

/**
 * Builds the approval gate for one unattended run. Warden plugs in here. When
 * no factory is wired — or it returns undefined — the runner falls back to a
 * deny-mutating gate: side-effecting tools are refused, never silently allowed.
 *
 * A factory that throws (or rejects) fails the attempt like any transient
 * error: the run is retried later, never run without a gate.
 */
export interface TaskApprovalFactory {
  (
    ctx: TaskApprovalContext,
  ): TaskApprovalHandle | undefined | Promise<TaskApprovalHandle | undefined>;
  /**
   * Called once a run has ended, whatever the outcome — also when that ending
   * is completed by a later process after a crash. A throw leaves the ending
   * incomplete, so it is tried again at the next tick.
   */
  runEnded?: (ctx: TaskRunEndContext) => Promise<void>;
  /**
   * Called when a task has been deleted — also mid-run, when its run never
   * gets to end normally. Whatever the gate granted "for this task" ends.
   */
  taskRemoved?: (ctx: Omit<TaskRunEndContext, "runId">) => Promise<void>;
}

export type TaskNoticeKind = "task_result" | "watch_hit" | "task_needs_you" | "task_failed";

export interface TaskNotice {
  /**
   * Stable idempotency key (`<runId>-<kind>`). The outbox may hand the same
   * notice to deliver() again after a crash; a deliver() that has already
   * handled this id must not notify twice.
   */
  id: string;
  uid: string | null;
  taskId: string;
  runId: string;
  title: string;
  summary: string;
  status: TaskRunState | TaskState;
  artifacts?: TaskArtifact[];
  priority: "low" | "normal" | "high";
  kind: TaskNoticeKind;
  /**
   * The summary carries what a run that read outside content wrote. The card
   * quotes it inside the external-content markers and taints the
   * conversation it lands in (delivery.ts).
   */
  tainted?: boolean;
}

/** Hands a finished run's result to the user. The Reach-out gate plugs in here. */
export type TaskDeliver = (notice: TaskNotice) => Promise<{ delivered: boolean; reason?: string }>;

// ── validation helpers ──

const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{5,63}$/;

/** Task and run ids are path components — keep them boring. */
export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && TASK_ID_RE.test(id);
}

export const TASK_KINDS: readonly TaskKind[] = ["oneoff", "routine", "watcher", "goal"];
export const TASK_NOTIFY: readonly TaskNotify[] = [
  "always",
  "on_change",
  "on_hit",
  "silent_on_noop",
];
export const TASK_HOSTS: readonly TaskHost[] = ["home", "cloud", "any"];

/** States from which nothing further happens without the user. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);
