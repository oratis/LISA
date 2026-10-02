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
import type { AgentEvent } from "../types.js";

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
 * Capabilities the user approved when the task was created. The runner only
 * hands the model tools inside this envelope; anything outside it is not
 * offered at all (and Warden, once wired, treats it as out-of-envelope).
 */
export interface TaskEnvelope {
  /** Capability categories (e.g. "read", "web", "mail"). Informational to Warden. */
  categories?: string[];
  /** Exact tool names allowed. Unset ⇒ every non-mutating tool on the surface. */
  tools?: string[];
  /** Targets (hosts, paths, repos) the task may act on. Informational to Warden. */
  targets?: string[];
}

export interface TaskBudget {
  /** Cumulative input+output token ceiling per run. */
  tokens: number;
  /** Optional spend ceiling per run, in millionths of a USD. */
  usdMicros?: number;
  /** Wall-clock ceiling per run. */
  wallclockMs: number;
  /** Tool-call ceiling per run. */
  maxToolCalls: number;
}

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
  /** Consecutive auth failures; the scheduler pauses the task past a threshold. */
  authFailureCount: number;
  /** Consecutive failed runs (drives retry backoff; reset on success). */
  failureCount?: number;
  /** Fingerprint of the last delivered result, for notify: on_change. */
  lastResultFingerprint?: string;
  /** Short summary of the last finished run, fed into the next run's task frame. */
  lastSummary?: string;
  /**
   * The run currently in flight. Set when a run starts and cleared when it
   * finishes; a value here with no live lease means the run was interrupted
   * and must be resumed.
   */
  activeRunId?: string;
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

export interface TaskRun {
  id: string;
  taskId: string;
  startedAt: number;
  endedAt?: number;
  state: TaskRunState;
  stopReason?: string;
  tokens: { in: number; out: number };
  costMicros?: number;
  toolCalls: number;
  /** sha256(tool + canonical input) → recorded result, for exactly-once side effects. */
  executedDigests: Record<string, string>;
  /** How many times this run was resumed after an interruption. */
  resumes?: number;
  /** Wall-clock time spent executing, summed across resumed segments. */
  elapsedMs?: number;
  /** Started by the user ("run now"/test run) rather than by the schedule. */
  manual?: boolean;
  /** Input handed to the run by a watcher hit, if any. */
  input?: string;
  summary?: string;
  artifacts?: TaskArtifact[];
  error?: string;
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
  origin: { kind: "task" | "routine" | "watcher"; id: string };
  envelope?: TaskEnvelope;
  uid: string | null;
}

export interface TaskApprovalHandle {
  approval?: ApprovalCallback;
  observe?: (e: AgentEvent) => void;
}

/**
 * Builds the approval gate for one unattended run. Warden plugs in here. When
 * no factory is wired — or it returns undefined — the runner falls back to a
 * deny-mutating gate: side-effecting tools are refused, never silently allowed.
 */
export type TaskApprovalFactory = (ctx: TaskApprovalContext) => TaskApprovalHandle | undefined;

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
