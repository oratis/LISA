/**
 * Durable task + run storage.
 *
 *   <lisaHome>/tasks/<id>.json                    one task
 *   <lisaHome>/tasks/runs/<taskId>/<runId>.jsonl  one run: append-only checkpoints
 *   <lisaHome>/tasks/.locks/<id>.lock             per-task write lock (short-held)
 *
 * Every path goes through lisaHome(), so inside a cloud request scope the same
 * code reads and writes that tenant's subtree and nothing else.
 *
 * Failure rules:
 *   - writes are atomic (temp file + rename), read-modify-write holds a
 *     cross-process link() lock, so the web server and the launchd heartbeat
 *     CLI can both touch a task without losing an update;
 *   - a task file that does not parse or validate is renamed to `.corrupt` and
 *     skipped — one bad file never stops the scheduler;
 *   - a task written by a NEWER build is left alone and skipped (not
 *     quarantined): downgrading must not destroy data;
 *   - a run log's torn last line (crash mid-append) is ignored.
 */
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendLine, atomicWrite, pathExists } from "../fs-utils.js";
import { lisaHome } from "../paths.js";
import { withFileLock } from "../soul/lock.js";
import type { StoredMessage } from "../types.js";
import {
  DEFAULT_TASK_BUDGET,
  isSafeId,
  MAX_RUNS_PER_TASK,
  TASK_HOSTS,
  TASK_KINDS,
  TASK_NOTIFY,
  TASK_SCHEMA_VERSION,
  type Task,
  type TaskRun,
  type TaskState,
} from "./types.js";

export function tasksDir(): string {
  return path.join(lisaHome(), "tasks");
}

function taskFile(id: string): string {
  return path.join(tasksDir(), `${id}.json`);
}

function runsDir(taskId: string): string {
  return path.join(tasksDir(), "runs", taskId);
}

function runFile(taskId: string, runId: string): string {
  return path.join(runsDir(taskId), `${runId}.jsonl`);
}

function taskLockPath(id: string): string {
  return path.join(tasksDir(), ".locks", `${id}.lock`);
}

export function newTaskId(): string {
  return `t_${randomBytes(6).toString("hex")}`;
}

export function newRunId(): string {
  return `r_${randomBytes(8).toString("hex")}`;
}

const TASK_STATES: readonly TaskState[] = [
  "draft",
  "scheduled",
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "paused",
];

// ── schema migration ──

/**
 * Migrations from version N to N+1, indexed by N. Empty today (v1 is the first
 * schema); add an entry here — never edit a shipped one — when the shape changes.
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

type Parsed = { ok: true; task: Task } | { ok: false; reason: "corrupt" | "newer" };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate + migrate a parsed task file. Exported for tests. */
export function parseTask(raw: unknown, expectedId?: string): Parsed {
  if (!isObject(raw)) return { ok: false, reason: "corrupt" };
  let obj = raw;
  let version = typeof obj.version === "number" ? obj.version : NaN;
  if (!Number.isInteger(version) || version < 1) return { ok: false, reason: "corrupt" };
  if (version > TASK_SCHEMA_VERSION) return { ok: false, reason: "newer" };
  while (version < TASK_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) return { ok: false, reason: "corrupt" };
    obj = step(obj);
    version++;
    obj.version = version;
  }

  const budget = isObject(obj.budget) ? obj.budget : null;
  const origin = isObject(obj.origin) ? obj.origin : null;
  const valid =
    isSafeId(obj.id) &&
    (expectedId === undefined || obj.id === expectedId) &&
    (obj.owner === null || typeof obj.owner === "string") &&
    TASK_KINDS.includes(obj.kind as Task["kind"]) &&
    typeof obj.title === "string" &&
    typeof obj.instruction === "string" &&
    origin !== null &&
    typeof origin.kind === "string" &&
    TASK_HOSTS.includes(obj.host as Task["host"]) &&
    budget !== null &&
    typeof budget.tokens === "number" &&
    typeof budget.wallclockMs === "number" &&
    typeof budget.maxToolCalls === "number" &&
    TASK_NOTIFY.includes(obj.notify as Task["notify"]) &&
    TASK_STATES.includes(obj.state as TaskState) &&
    typeof obj.enabled === "boolean" &&
    typeof obj.createdAt === "number" &&
    typeof obj.updatedAt === "number" &&
    (obj.schedule === undefined ||
      (isObject(obj.schedule) && typeof obj.schedule.expr === "string")) &&
    (obj.trigger === undefined || (isObject(obj.trigger) && typeof obj.trigger.kind === "string"));
  if (!valid) return { ok: false, reason: "corrupt" };

  const task = obj as unknown as Task;
  // Tolerate hand-edited files that dropped a defaulted field.
  if (typeof task.createdDisabled !== "boolean") task.createdDisabled = false;
  if (typeof task.authFailureCount !== "number") task.authFailureCount = 0;
  if (!Array.isArray(task.runs)) task.runs = [];
  task.runs = task.runs.filter(isSafeId);
  return { ok: true, task };
}

async function quarantine(file: string): Promise<void> {
  // Keep the bytes for the user (and a timestamp so a second corruption of the
  // same id does not overwrite the first), get it out of the scheduler's way.
  const dest = `${file}.${Date.now()}.corrupt`;
  await fsp.rename(file, dest).catch(() => {});
}

async function readTaskFile(id: string): Promise<Task | null> {
  const file = taskFile(id);
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    await quarantine(file);
    return null;
  }
  const parsed = parseTask(raw, id);
  if (parsed.ok) return parsed.task;
  if (parsed.reason === "corrupt") await quarantine(file);
  return null;
}

async function writeTaskFile(task: Task): Promise<void> {
  await atomicWrite(taskFile(task.id), JSON.stringify(task, null, 2));
}

// ── tasks ──

export async function getTask(id: string): Promise<Task | null> {
  if (!isSafeId(id)) return null;
  return await readTaskFile(id);
}

/** Every readable task, oldest first. Corrupt files are quarantined on the way. */
export async function listTasks(): Promise<Task[]> {
  let names: string[];
  try {
    names = await fsp.readdir(tasksDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: Task[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isSafeId(id)) continue;
    try {
      const task = await readTaskFile(id);
      if (task) out.push(task);
    } catch {
      // An unreadable file (permissions, I/O) is skipped, never fatal.
    }
  }
  out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out;
}

export type NewTask = Pick<Task, "kind" | "title" | "instruction" | "origin"> &
  Partial<
    Pick<
      Task,
      | "owner"
      | "host"
      | "schedule"
      | "trigger"
      | "envelope"
      | "budget"
      | "notify"
      | "enabled"
      | "createdDisabled"
      | "state"
      | "nextRunAt"
    >
  > & { id?: string };

export async function createTask(input: NewTask, now = Date.now()): Promise<Task> {
  const id = input.id ?? newTaskId();
  if (!isSafeId(id)) throw new Error(`invalid task id: ${id}`);
  const enabled = input.enabled ?? false;
  const task: Task = {
    id,
    version: TASK_SCHEMA_VERSION,
    owner: input.owner ?? null,
    kind: input.kind,
    title: input.title,
    instruction: input.instruction,
    origin: input.origin,
    host: input.host ?? "any",
    ...(input.schedule ? { schedule: input.schedule } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.envelope ? { envelope: input.envelope } : {}),
    budget: input.budget ?? { ...DEFAULT_TASK_BUDGET },
    notify: input.notify ?? (input.kind === "watcher" ? "on_hit" : "always"),
    state: input.state ?? (enabled ? "scheduled" : "draft"),
    enabled,
    createdDisabled: input.createdDisabled ?? !enabled,
    createdAt: now,
    updatedAt: now,
    ...(enabled ? { enabledAt: now } : {}),
    ...(input.nextRunAt !== undefined ? { nextRunAt: input.nextRunAt } : {}),
    authFailureCount: 0,
    runs: [],
  };
  await withFileLock(taskLockPath(id), async () => {
    // Exclusive create: an id collision (or a replayed migration) must not
    // silently overwrite an existing task. The check and the atomic write are
    // both under the per-id lock, so a reader never sees a half-made file.
    if (await pathExists(taskFile(id))) throw new Error(`task ${id} already exists`);
    await writeTaskFile(task);
  });
  return task;
}

/**
 * Read-modify-write one task under its cross-process lock. `mutate` edits the
 * task in place (or returns a replacement); returning `false` aborts the write.
 * Resolves to the stored task, or null when it does not exist.
 */
export async function updateTask(
  id: string,
  mutate: (task: Task) => void | false | Task,
  now = Date.now(),
): Promise<Task | null> {
  if (!isSafeId(id)) return null;
  return await withFileLock(taskLockPath(id), async () => {
    const current = await readTaskFile(id);
    if (!current) return null;
    const result = mutate(current);
    if (result === false) return current;
    const next = result ?? current;
    next.id = id; // the id is the filename; it is not editable
    next.version = TASK_SCHEMA_VERSION;
    next.updatedAt = now;
    await writeTaskFile(next);
    return next;
  });
}

/** Remove a task and its run logs. True when the task existed. */
export async function deleteTask(id: string): Promise<boolean> {
  if (!isSafeId(id)) return false;
  return await withFileLock(taskLockPath(id), async () => {
    try {
      await fsp.unlink(taskFile(id));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    await fsp.rm(runsDir(id), { recursive: true, force: true });
    return true;
  });
}

// ── runs ──

export interface RunEvent {
  type: "tool_call" | "tool_result" | "replayed" | "denied" | "info" | "error" | "resume";
  toolName?: string;
  summary?: string;
  isError?: boolean;
}

type RunRecord =
  | { t: "run"; at: number; run: TaskRun }
  | { t: "msg"; at: number; message: StoredMessage }
  | { t: "event"; at: number; event: RunEvent }
  /** Discard every message after the first `keep` (resume drops a torn turn). */
  | { t: "reset"; at: number; keep: number };

export interface LoadedRun {
  run: TaskRun;
  messages: StoredMessage[];
  events: Array<RunEvent & { at: number }>;
}

async function appendRecord(taskId: string, runId: string, rec: RunRecord): Promise<void> {
  if (!isSafeId(taskId) || !isSafeId(runId)) throw new Error("invalid task/run id");
  await appendLine(runFile(taskId, runId), JSON.stringify(rec));
}

/** Start a run: write its first checkpoint and link it from the task. */
export async function createRun(
  taskId: string,
  init: Partial<Pick<TaskRun, "id" | "input" | "state">> = {},
  now = Date.now(),
): Promise<TaskRun> {
  if (init.id !== undefined && !isSafeId(init.id)) throw new Error(`invalid run id: ${init.id}`);
  const run: TaskRun = {
    id: init.id ?? newRunId(),
    taskId,
    startedAt: now,
    state: init.state ?? "running",
    tokens: { in: 0, out: 0 },
    toolCalls: 0,
    executedDigests: {},
    ...(init.input !== undefined ? { input: init.input } : {}),
  };
  await appendRecord(taskId, run.id, { t: "run", at: now, run });
  let dropped: string[] = [];
  await updateTask(
    taskId,
    (task) => {
      if (task.runs.includes(run.id)) return false;
      task.runs.push(run.id);
      if (task.runs.length > MAX_RUNS_PER_TASK) {
        dropped = task.runs.splice(0, task.runs.length - MAX_RUNS_PER_TASK);
      }
    },
    now,
  );
  for (const old of dropped) {
    await fsp.rm(runFile(taskId, old), { force: true }).catch(() => {});
  }
  return run;
}

/** Persist the run's current state. Called after every tool call. */
export async function checkpointRun(run: TaskRun, now = Date.now()): Promise<void> {
  await appendRecord(run.taskId, run.id, { t: "run", at: now, run });
}

export async function appendRunMessage(
  taskId: string,
  runId: string,
  message: StoredMessage,
  now = Date.now(),
): Promise<void> {
  await appendRecord(taskId, runId, { t: "msg", at: now, message });
}

export async function appendRunEvent(
  taskId: string,
  runId: string,
  event: RunEvent,
  now = Date.now(),
): Promise<void> {
  await appendRecord(taskId, runId, { t: "event", at: now, event });
}

export async function resetRunMessages(
  taskId: string,
  runId: string,
  keep: number,
  now = Date.now(),
): Promise<void> {
  await appendRecord(taskId, runId, { t: "reset", at: now, keep });
}

export async function loadRun(taskId: string, runId: string): Promise<LoadedRun | null> {
  if (!isSafeId(taskId) || !isSafeId(runId)) return null;
  let text: string;
  try {
    text = await fsp.readFile(runFile(taskId, runId), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let run: TaskRun | null = null;
  let messages: StoredMessage[] = [];
  const events: LoadedRun["events"] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec: RunRecord;
    try {
      rec = JSON.parse(line) as RunRecord;
    } catch {
      continue; // torn write — the checkpoint before it is still good
    }
    if (rec.t === "run" && isObject(rec.run)) run = rec.run;
    else if (rec.t === "msg" && isObject(rec.message)) messages.push(rec.message);
    else if (rec.t === "event" && isObject(rec.event)) events.push({ ...rec.event, at: rec.at });
    else if (rec.t === "reset" && Number.isInteger(rec.keep))
      messages = messages.slice(0, rec.keep);
  }
  if (!run || run.id !== runId || run.taskId !== taskId) return null;
  if (!isObject(run.executedDigests)) run.executedDigests = {};
  return { run, messages, events };
}

/** The task's runs, newest first, without their message history. */
export async function listRuns(task: Task): Promise<TaskRun[]> {
  const out: TaskRun[] = [];
  for (const runId of [...task.runs].reverse()) {
    const loaded = await loadRun(task.id, runId).catch(() => null);
    if (loaded) out.push(loaded.run);
  }
  return out;
}
