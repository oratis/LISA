/**
 * Dispatch ledger (L3 DISPATCH) — a small persistent record of the CLI agents
 * LISA has launched via dispatch_agent, so she can later signal them
 * (list / cancel) from a *different* turn, or even after a restart.
 *
 * dispatch_agent spawns agents **detached**, so they outlive LISA's own
 * process and the transient child handle is gone by the next turn. This ledger
 * persists the (pid, agent, cwd, task, startedAt) tuple to
 * `~/.lisa/dispatches.json` so the orchestrator can reconnect observed work to
 * a controllable process.
 *
 * SAFETY: the ledger only ever holds agents LISA *herself* dispatched — never
 * the user's own manually-started sessions (those are discovered via session
 * files and have no associated pid). signal_agent can therefore only stop work
 * LISA started, never an arbitrary user process.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DispatchEntry {
  /** Stable handle, `${pid}-${startedAt.toString(36)}`. */
  id: string;
  agent: string;
  pid: number;
  cwd: string;
  /** Task snippet (first 200 chars) — for display only. */
  task: string;
  /** Epoch ms when dispatched. */
  startedAt: number;
  /** Captured stdout+stderr file for this agent (D1 feedback), if any. */
  logPath?: string;
}

/** How long a finished dispatch (and its output log) is retained for readback. */
const RETAIN_MS = 24 * 60 * 60_000;

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}

/** Resolved lazily (reads env at call time) so tests can point lisaHome() at a tmp dir. */
function ledgerPath(): string {
  return path.join(lisaHome(), "dispatches.json");
}

/** Directory for per-dispatch captured-output logs. */
export function dispatchLogDir(): string {
  return path.join(lisaHome(), "dispatches");
}

/** Read the ledger; tolerant of a missing or corrupt file (returns []). */
export function loadLedger(): DispatchEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(ledgerPath(), "utf8");
  } catch {
    return []; // no file yet
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is DispatchEntry =>
        !!e &&
        typeof (e as DispatchEntry).pid === "number" &&
        typeof (e as DispatchEntry).id === "string",
    );
  } catch {
    return []; // corrupt JSON — treat as empty rather than throwing
  }
}

function saveLedger(entries: DispatchEntry[]): void {
  const file = ledgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

/**
 * Is a process still alive? Signal 0 probes for existence without delivering a
 * signal. EPERM means the process exists but is owned by another user (still
 * "alive"); ESRCH means it's gone.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Record a freshly dispatched agent. Returns the stored entry. */
export function recordDispatch(d: {
  agent: string;
  pid: number;
  cwd: string;
  task: string;
  /** Captured-output log file for this agent (D1 feedback). */
  logPath?: string;
  /** Override the clock (tests). */
  now?: number;
}): DispatchEntry {
  const startedAt = d.now ?? Date.now();
  const entry: DispatchEntry = {
    id: `${d.pid}-${startedAt.toString(36)}`,
    agent: d.agent,
    pid: d.pid,
    cwd: d.cwd,
    task: d.task.slice(0, 200),
    startedAt,
    ...(d.logPath ? { logPath: d.logPath } : {}),
  };
  // Drop any stale same-pid entry, and age out finished dispatches older than
  // the retention window so the file (and its logs) don't grow unbounded.
  const cutoff = startedAt - RETAIN_MS;
  const entries = loadLedger().filter(
    (e) => e.pid !== d.pid && (isAlive(e.pid) || e.startedAt >= cutoff),
  );
  entries.push(entry);
  saveLedger(entries);
  return entry;
}

/**
 * Live dispatched agents. Rewrites the ledger to retain live agents AND
 * recently-finished ones (so their captured output stays readable via
 * dispatch_status); only truly-aged-out entries (and their logs) are dropped.
 */
export function listLiveDispatches(): DispatchEntry[] {
  const all = loadLedger();
  const now = Date.now();
  const keep = all.filter((e) => isAlive(e.pid) || now - e.startedAt < RETAIN_MS);
  if (keep.length !== all.length) {
    for (const e of all) {
      if (!keep.includes(e) && e.logPath) {
        try {
          fs.unlinkSync(e.logPath);
        } catch {
          // log already gone — ignore
        }
      }
    }
    saveLedger(keep);
  }
  return all.filter((e) => isAlive(e.pid));
}

/** All retained dispatches (live + recently-finished). For status / result readback. */
export function listRecentDispatches(): DispatchEntry[] {
  return loadLedger();
}

/** Serializable view of a ledger entry for the HTTP API (GET /api/dispatch/list).
 *  Structural only — task is already a 200-char snippet; logPath is reduced to a
 *  boolean so the raw capture path never leaks to a remote client. Pure. */
export interface DispatchView {
  id: string;
  agent: string;
  pid: number;
  cwd: string;
  task: string;
  /** ISO-8601, matching /api/agents/sessions' lastMtime serialization. */
  startedAt: string;
  alive: boolean;
  hasLog: boolean;
}

export function toDispatchView(e: DispatchEntry, alive: boolean): DispatchView {
  return {
    id: e.id,
    agent: e.agent,
    pid: e.pid,
    cwd: e.cwd,
    task: e.task,
    startedAt: new Date(e.startedAt).toISOString(),
    alive,
    hasLog: !!e.logPath,
  };
}

/** Tail (up to maxBytes) of a dispatch's captured output. "" if none/unreadable. */
export function readDispatchOutput(entry: DispatchEntry, maxBytes = 2000): string {
  if (!entry.logPath) return "";
  try {
    const st = fs.statSync(entry.logPath);
    if (st.size === 0) return "";
    const fd = fs.openSync(entry.logPath, "r");
    try {
      const len = Math.min(maxBytes, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return (st.size > len ? "…" : "") + buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Find a *live* dispatch by id or by pid (as a string). Null if absent/dead. */
export function findDispatch(target: string): DispatchEntry | null {
  const live = listLiveDispatches();
  return (
    live.find((e) => e.id === target) ??
    live.find((e) => String(e.pid) === target) ??
    null
  );
}

/** Drop an entry from the ledger by id. */
export function removeDispatch(id: string): void {
  const entries = loadLedger();
  const next = entries.filter((e) => e.id !== id);
  if (next.length !== entries.length) saveLedger(next);
}
