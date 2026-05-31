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
}

/** Resolved lazily (reads env at call time) so tests can point LISA_HOME at a tmp dir. */
function ledgerPath(): string {
  const home = process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
  return path.join(home, "dispatches.json");
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
  };
  // Drop any stale entry that reused this pid before appending.
  const entries = loadLedger().filter((e) => e.pid !== d.pid);
  entries.push(entry);
  saveLedger(entries);
  return entry;
}

/** Live dispatched agents, pruning any that have since exited. */
export function listLiveDispatches(): DispatchEntry[] {
  const all = loadLedger();
  const live = all.filter((e) => isAlive(e.pid));
  if (live.length !== all.length) saveLedger(live); // prune the dead
  return live;
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
