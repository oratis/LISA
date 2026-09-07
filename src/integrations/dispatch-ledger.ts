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

/**
 * Write the ledger atomically — tmp file then rename, the sync twin of
 * atomicWrite() in ../fs-utils.ts.
 *
 * A bare writeFileSync truncates before it writes, so a concurrent reader sees
 * an empty or half-written file and loadLedger()'s catch silently returns [],
 * losing every live dispatch. That window is real here and got wider with
 * recordExit(): a `lisa serve` and a `lisa` CLI run share one ~/.lisa, and
 * recordExit fires from an async "close" listener, so a second read-modify-
 * write can land in the middle of the first. rename(2) is atomic within a
 * filesystem, so a reader sees either the old ledger or the new one.
 */
function saveLedger(entries: DispatchEntry[]): void {
  const file = ledgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid.toString(36)}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // never existed — ignore
    }
    throw err;
  }
}

/**
 * Boot epoch (seconds) from /proc/stat, cached for the life of the process.
 *
 * The Linux token below is `starttime` in clock ticks *since boot*, so on its
 * own it repeats after a reboot: a fresh process can be handed both the same
 * pid and the same ticks-since-boot as a pre-reboot entry still inside the 24h
 * retention window, and the guard would wave it through as the same process.
 * Scoping the token to btime makes the pair unique across reboots.
 */
let cachedBtime: string | null | undefined;
function linuxBootEpoch(): string | null {
  if (cachedBtime !== undefined) return cachedBtime;
  try {
    const m = /^btime\s+(\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    cachedBtime = m?.[1] ?? null;
  } catch {
    cachedBtime = null;
  }
  return cachedBtime ?? null;
}

/**
 * Kernel start time of a running process, as an opaque comparable string.
 * Together with the pid this is a stable process identity: the pair cannot be
 * reused, because a recycled pid necessarily started later.
 *
 * Linux reads field 22 of /proc/<pid>/stat (starttime, in clock ticks since
 * boot), scoped to the boot epoch. Everything else shells out to
 * `ps -o lstart=`, which POSIX gives us on macOS and the BSDs. Returns null if
 * the process is gone or the probe fails — callers must treat null as "cannot
 * tell", never as a mismatch.
 *
 * The `ps` environment is pinned to LC_ALL=C / TZ=UTC because `lstart` is
 * rendered in the caller's locale and timezone, which makes it useless as an
 * identity across processes that do not share them. Measured on macOS for one
 * unchanged pid: TZ alone produced "Mon Sep  7 13:23:46 2026" (UTC),
 * "22:23:46" (Asia/Tokyo), "09:23:46" (America/New_York), and LC_ALL reshaped
 * the whole string ("Mo.  7 Sep." for de_DE, "一  9月/ 7" for zh_CN). A
 * `lisa serve` under launchd and a `lisa` CLI run from a configured login
 * shell therefore disagreed about every token, so isAlive() reported every
 * running dispatch dead — and signal_agent, seeing "already exited", deleted
 * the ledger row instead of signalling, making a runaway agent permanently
 * uncancellable.
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
      if (!starttime) return null;
      const boot = linuxBootEpoch();
      return boot ? `lt1:${boot}:${starttime}` : `lt1:?:${starttime}`;
    } catch {
      return null;
    }
  }
  try {
    const res = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
    });
    if (res.status !== 0 || !res.stdout) return null;
    const line = res.stdout.trim();
    return line ? `ps1:${line}` : null;
  } catch {
    return null;
  }
}

/**
 * The scheme prefix of a token ("ps1", "lt1", and the retired "ps"/"lt").
 *
 * Tokens are only comparable within one scheme. Entries written before the
 * locale pinning above carry a `ps:` token rendered in whatever locale the
 * writer happened to have, so comparing one against a freshly-pinned `ps1:`
 * token is guaranteed to mismatch and would report every pre-upgrade dispatch
 * dead. Different schemes mean "cannot tell", which is the same fail-open path
 * a failed probe already takes.
 */
function tokenScheme(token: string): string {
  const i = token.indexOf(":");
  return i === -1 ? token : token.slice(0, i);
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
    // Only comparable within one token scheme — see tokenScheme(). A null
    // probe, or a token written by an older scheme, means "cannot tell".
    if (current && tokenScheme(current) === tokenScheme(startToken) && current !== startToken) {
      return false; // pid was recycled
    }
  }
  return true;
}

/**
 * isAlive for a ledger entry — an observed exit is definitive, then the start
 * token.
 *
 * recordExit() sets `exitedAt` only for a child we actually watched terminate,
 * so once it is set the pid is stale by definition and must never be probed
 * again. Skipping that check let a recycled pid resurrect a finished dispatch:
 * dispatch_status printed "▶ running" for an entry whose exit code sat in the
 * same JSON object, and — for an entry with no startToken, which is every
 * agent that died inside launchAgent's 150 ms race — signal_agent would deliver
 * SIGTERM / SIGKILL to the unrelated process group that now owns the pid.
 *
 * Gate on `exitedAt`, not `exitCode`: a signal death legitimately stores
 * exitCode: null.
 */
export function entryIsAlive(e: DispatchEntry): boolean {
  if (e.exitedAt !== undefined) return false;
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
  // Probe each entry at most once. entryIsAlive() can shell out to `ps`
  // (measured 1.79 ms vs 0.001 ms for kill(pid, 0)) and this runs inside the
  // /api/dispatch/list request handler over an unbounded ledger, so the old
  // shape — one probe in the `keep` filter, a second in the returned filter —
  // blocked the event loop for twice as long as it needed to.
  const recent = new Set<DispatchEntry>();
  const live = new Set<DispatchEntry>();
  for (const e of all) {
    // Cheap test first: a recent entry is retained whether or not it is alive,
    // but it still needs the probe to decide whether it is *returned*.
    if (now - e.startedAt < RETAIN_MS) recent.add(e);
    if (entryIsAlive(e)) live.add(e);
  }
  const keep = all.filter((e) => live.has(e) || recent.has(e));
  if (keep.length !== all.length) {
    const kept = new Set(keep);
    for (const e of all) {
      if (!kept.has(e) && e.logPath) {
        try {
          fs.unlinkSync(e.logPath);
        } catch {
          // log already gone — ignore
        }
      }
    }
    saveLedger(keep);
  }
  return all.filter((e) => live.has(e));
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
  /**
   * What actually happened, for clients that would otherwise have to infer it
   * from `alive` alone:
   *
   * - `running`  — still alive.
   * - `ok`       — observed exit code 0.
   * - `failed`   — observed a non-zero exit code, or death by signal.
   * - `unknown`  — not alive, and no exit was ever observed (the agent
   *                outlived the LISA process that launched it).
   *
   * `alive: false` on its own says nothing about success: the child is
   * detached, so a crash, an OOM kill and a clean finish all look identical
   * from the pid. Rendering the three as one green "Done" is what this
   * replaces.
   */
  status: DispatchStatusKind;
  /** Observed exit code; null when it died by signal, absent when unobserved. */
  exitCode?: number | null;
  /** Signal name when it died by signal. */
  exitSignal?: string | null;
  /** ISO-8601 when the exit was observed. */
  exitedAt?: string;
}

export type DispatchStatusKind = "running" | "ok" | "failed" | "unknown";

/**
 * Classify a ledger entry. Gated on `exitedAt` (set only for an exit we
 * actually watched) rather than on `exitCode`, because a signal death
 * legitimately stores exitCode: null.
 */
export function dispatchStatusKind(e: DispatchEntry, alive: boolean): DispatchStatusKind {
  if (alive) return "running";
  if (e.exitedAt === undefined) return "unknown";
  if (e.exitSignal) return "failed";
  if (typeof e.exitCode === "number") return e.exitCode === 0 ? "ok" : "failed";
  return "unknown";
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
    status: dispatchStatusKind(e, alive),
    ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
    ...(e.exitSignal ? { exitSignal: e.exitSignal } : {}),
    ...(e.exitedAt !== undefined ? { exitedAt: new Date(e.exitedAt).toISOString() } : {}),
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
