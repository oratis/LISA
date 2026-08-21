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

import { spawnSync } from "node:child_process";
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
  /**
   * Kernel start-time fingerprint of the process, captured at dispatch.
   * Guards against pid reuse: a recycled pid answers `kill(pid, 0)` exactly
   * like the original, so pid alone is not an identity. Absent when the
   * platform probe failed, and on entries written before this field existed —
   * those fall back to the old pid-only behavior.
   */
  startToken?: string;
  /**
   * Exit status, once observed. `undefined` means we never saw the process
   * exit (LISA was not running when it finished) — which is NOT the same as
   * "finished successfully", and must not be rendered as success.
   */
  exitCode?: number | null;
  /** Signal that killed it, when it died by signal (exitCode is null then). */
  exitSignal?: string | null;
  /** Epoch ms when the exit was observed. */
  exitedAt?: number;
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
 * Kernel start time of a running process, as an opaque comparable string.
 * Together with the pid this is a stable process identity: the pair cannot be
 * reused, because a recycled pid necessarily started later.
 *
 * Linux reads field 22 of /proc/<pid>/stat (starttime, in clock ticks since
 * boot). Everything else shells out to `ps -o lstart=`, which POSIX gives us on
 * macOS and the BSDs. Returns null if the process is gone or the probe fails —
 * callers must treat null as "cannot tell", never as a mismatch.
 */
export function processStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm (field 2) is parenthesized and may contain spaces or ')', so
      // split after the LAST ')' — fields 3.. are then whitespace-separated.
      const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const starttime = rest[19]; // field 22 == index 19 of fields 3..
      return starttime ? `lt:${starttime}` : null;
    } catch {
      return null;
    }
  }
  try {
    const res = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    const line = res.stdout.trim();
    return line ? `ps:${line}` : null;
  } catch {
    return null;
  }
}

/**
 * Is a process still alive? Signal 0 probes for existence without delivering a
 * signal. EPERM means the process exists but is owned by another user (still
 * "alive"); ESRCH means it's gone.
 *
 * `startToken` (when we recorded one at dispatch) additionally guards against
 * pid reuse. Without it, a pid recycled by the OS inside the 24h retention
 * window reports "alive" and — worse — makes signal_agent deliver SIGTERM /
 * SIGKILL to whatever unrelated process group now owns that pid. If the token
 * is present and the live process's token differs, this is a different process
 * and we report dead. A null probe result means "cannot tell" and is treated
 * as a match, preserving the old behavior rather than silently hiding agents.
 */
export function isAlive(pid: number, startToken?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (startToken) {
    const current = processStartToken(pid);
    if (current && current !== startToken) return false; // pid was recycled
  }
  return true;
}

/** isAlive for a ledger entry — always consults the recorded start token. */
export function entryIsAlive(e: DispatchEntry): boolean {
  return isAlive(e.pid, e.startToken);
}

/** Record a freshly dispatched agent. Returns the stored entry. */
export function recordDispatch(d: {
  agent: string;
  pid: number;
  cwd: string;
  task: string;
  /** Captured-output log file for this agent (D1 feedback). */
  logPath?: string;
  /** Process start-time fingerprint; defaults to probing the live pid. */
  startToken?: string | null;
  /** Override the clock (tests). */
  now?: number;
}): DispatchEntry {
  const startedAt = d.now ?? Date.now();
  const startToken = d.startToken === undefined ? processStartToken(d.pid) : d.startToken;
  const entry: DispatchEntry = {
    id: `${d.pid}-${startedAt.toString(36)}`,
    agent: d.agent,
    pid: d.pid,
    cwd: d.cwd,
    task: d.task.slice(0, 200),
    startedAt,
    ...(d.logPath ? { logPath: d.logPath } : {}),
    ...(startToken ? { startToken } : {}),
  };
  // Drop any stale same-pid entry, and age out finished dispatches older than
  // the retention window so the file (and its logs) don't grow unbounded.
  const cutoff = startedAt - RETAIN_MS;
  const entries = loadLedger().filter(
    (e) => e.pid !== d.pid && (entryIsAlive(e) || e.startedAt >= cutoff),
  );
  entries.push(entry);
  saveLedger(entries);
  return entry;
}

/**
 * Record the observed exit of a dispatched agent. Called from the "close"
 * listener in launchAgent while LISA's own process is still alive; a dispatch
 * that outlives LISA simply never gets one, and stays exitCode: undefined.
 * No-op if the entry is already gone from the ledger.
 */
export function recordExit(
  id: string,
  code: number | null,
  signal: NodeJS.Signals | string | null,
  now = Date.now(),
): void {
  const entries = loadLedger();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  entry.exitCode = code;
  entry.exitSignal = signal ?? null;
  entry.exitedAt = now;
  saveLedger(entries);
}

/**
 * Live dispatched agents. Rewrites the ledger to retain live agents AND
 * recently-finished ones (so their captured output stays readable via
 * dispatch_status); only truly-aged-out entries (and their logs) are dropped.
 */
export function listLiveDispatches(): DispatchEntry[] {
  const all = loadLedger();
  const now = Date.now();
  const keep = all.filter((e) => entryIsAlive(e) || now - e.startedAt < RETAIN_MS);
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
  return all.filter((e) => entryIsAlive(e));
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
