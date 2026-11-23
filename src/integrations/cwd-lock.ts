/**
 * Dispatch D3 — Same-`cwd` concurrency lock.
 *
 * Prevents two non-worktree, mutating `dispatch_agent` runs from modifying the
 * exact same resolved `realpath` directory concurrently, while allowing isolated
 * git-worktree (`worktree: true`) and read-only (`readOnly: true`) runs.
 *
 * Uses atomic exclusive file creation (`link()` over a private temp file, with
 * `O_EXCL` fallback on filesystems without hard links), canonical `realpath`
 * hashing so symlinks and raw paths resolve to the same lock, and self-healing
 * reclamation for dead PIDs or expired locks.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAlive, processStartToken } from "./dispatch-ledger.js";

const DEFAULT_STALE_MS = 24 * 60 * 60_000;

export interface CwdLockInfo {
  /** Deterministic key for the resolved cwd. */
  key: string;
  /** Lock file path on disk. */
  lockPath: string;
  /** Canonical realpath of the locked cwd. */
  cwd: string;
  /** Unique ownership token so a holder only releases its own lock. */
  token: string;
  /** Agent kind holding the lock. */
  agent: string;
  /** PID of the process holding the lock (initially launcher, then child). */
  pid: number;
  /** Kernel start-time fingerprint guarding against PID reuse. */
  startToken?: string;
  /** Associated dispatch ledger id, if recorded. */
  dispatchId?: string;
  /** Epoch ms when acquired. */
  acquiredAt: number;
  mode: "exclusive";
}

export interface AcquireCwdLockOpts {
  cwd: string;
  agent: string;
  pid?: number;
  startToken?: string | null;
  dispatchId?: string;
  /** True when the run uses an isolated git worktree (bypasses exclusive lock). */
  worktree?: boolean;
  /** True when the run is read-only / non-mutating (bypasses exclusive lock). */
  readOnly?: boolean;
  /** Age after which an un-updated lock is considered stale (default 24h). */
  staleMs?: number;
  /** Clock override (tests). */
  now?: number;
}

export type AcquireCwdLockResult =
  | {
      acquired: true;
      bypassed: false;
      resolvedCwd: string;
      lock: CwdLockInfo;
    }
  | {
      acquired: true;
      bypassed: true;
      reason: "worktree" | "read-only";
      resolvedCwd: string;
      lock: null;
    }
  | {
      acquired: false;
      resolvedCwd: string;
      holder: CwdLockInfo;
      reason: string;
    };

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}

/** Directory holding per-cwd advisory lock files. Resolved lazily for test isolation. */
export function cwdLockDir(): string {
  return path.join(lisaHome(), "cwd-locks");
}

/**
 * Resolve `cwd` through symlinks even if trailing subdirectories do not exist yet,
 * mirroring `src/warden/paths.ts` realPath semantics.
 */
export function resolveCwdRealpath(cwd: string): string {
  const abs = path.resolve(cwd);
  try {
    return fs.realpathSync(abs);
  } catch {
    const missing: string[] = [];
    let probe = abs;
    while (probe !== path.dirname(probe)) {
      missing.unshift(path.basename(probe));
      probe = path.dirname(probe);
      try {
        return path.join(fs.realpathSync(probe), ...missing);
      } catch {
        /* continue walking up */
      }
    }
    return abs;
  }
}

export function cwdLockKey(resolvedCwd: string): string {
  return crypto.createHash("sha256").update(resolvedCwd).digest("hex").slice(0, 32);
}

export function cwdLockPath(resolvedCwd: string): string {
  return path.join(cwdLockDir(), `${cwdLockKey(resolvedCwd)}.lock`);
}

function readLockFile(
  filePath: string,
): { status: "missing" } | { status: "corrupt" } | { status: "ok"; lock: CwdLockInfo } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "corrupt" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CwdLockInfo>;
    if (
      !parsed ||
      typeof parsed.cwd !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.agent !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.acquiredAt !== "number"
    ) {
      return { status: "corrupt" };
    }
    return {
      status: "ok",
      lock: {
        key: parsed.key ?? cwdLockKey(parsed.cwd),
        lockPath: filePath,
        cwd: parsed.cwd,
        token: parsed.token,
        agent: parsed.agent,
        pid: parsed.pid,
        ...(parsed.startToken ? { startToken: parsed.startToken } : {}),
        ...(parsed.dispatchId ? { dispatchId: parsed.dispatchId } : {}),
        acquiredAt: parsed.acquiredAt,
        mode: "exclusive",
      },
    };
  } catch {
    return { status: "corrupt" };
  }
}

function isLockStale(lock: CwdLockInfo, now: number, staleMs: number): boolean {
  if (!Number.isFinite(lock.acquiredAt) || now - lock.acquiredAt > staleMs) return true;
  if (!isAlive(lock.pid, lock.startToken)) return true;
  return false;
}

function createExclusiveLockFile(lockPath: string, body: string): void {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${lockPath}.${process.pid.toString(36)}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    try {
      fs.linkSync(tmp, lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EPERM") throw err;
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Acquire an exclusive concurrency lock on the resolved `realpath` of `opts.cwd`.
 * Bypassed when `opts.worktree` or `opts.readOnly` is true.
 */
export function acquireCwdLock(opts: AcquireCwdLockOpts): AcquireCwdLockResult {
  const resolvedCwd = resolveCwdRealpath(opts.cwd);
  if (opts.worktree) {
    return {
      acquired: true,
      bypassed: true,
      reason: "worktree",
      resolvedCwd,
      lock: null,
    };
  }
  if (opts.readOnly) {
    return {
      acquired: true,
      bypassed: true,
      reason: "read-only",
      resolvedCwd,
      lock: null,
    };
  }

  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pid = opts.pid ?? process.pid;
  const startToken = opts.startToken === undefined ? processStartToken(pid) : opts.startToken;
  const key = cwdLockKey(resolvedCwd);
  const lockPath = cwdLockPath(resolvedCwd);
  const lock: CwdLockInfo = {
    key,
    lockPath,
    cwd: resolvedCwd,
    token: crypto.randomUUID(),
    agent: opts.agent,
    pid,
    ...(startToken ? { startToken } : {}),
    ...(opts.dispatchId ? { dispatchId: opts.dispatchId } : {}),
    acquiredAt: now,
    mode: "exclusive",
  };
  const body = JSON.stringify(lock, null, 2);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      createExclusiveLockFile(lockPath, body);
      return { acquired: true, bypassed: false, resolvedCwd, lock };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readLockFile(lockPath);
      if (existing.status === "missing") continue;
      if (existing.status === "ok" && !isLockStale(existing.lock, now, staleMs)) {
        return {
          acquired: false,
          resolvedCwd,
          holder: existing.lock,
          reason:
            `${existing.lock.agent} (pid ${existing.lock.pid}` +
            `${existing.lock.dispatchId ? `, dispatch ${existing.lock.dispatchId}` : ""}) ` +
            `already holds the exclusive cwd lock for ${resolvedCwd}`,
        };
      }
      // Atomically steal stale/corrupt lock before retrying.
      const stealTmp = `${lockPath}.steal.${process.pid.toString(36)}.${crypto.randomBytes(3).toString("hex")}`;
      try {
        fs.renameSync(lockPath, stealTmp);
        fs.unlinkSync(stealTmp);
      } catch {
        /* another contender won the steal or release race; retry */
      }
    }
  }

  // Final probe if all retry attempts raced.
  const existing = readLockFile(lockPath);
  if (existing.status === "ok") {
    return {
      acquired: false,
      resolvedCwd,
      holder: existing.lock,
      reason: `${existing.lock.agent} (pid ${existing.lock.pid}) holds the cwd lock for ${resolvedCwd}`,
    };
  }
  throw new Error(`failed to acquire cwd lock for ${resolvedCwd}`);
}

/**
 * Update a held lock's metadata (e.g. child pid/startToken/dispatchId after spawn)
 * while verifying ownership via `lock.token`.
 */
export function updateCwdLock(
  lock: CwdLockInfo,
  patch: { pid?: number; startToken?: string | null; dispatchId?: string },
): CwdLockInfo | null {
  const existing = readLockFile(lock.lockPath);
  if (existing.status !== "ok" || existing.lock.token !== lock.token) return null;

  const updated: CwdLockInfo = {
    ...existing.lock,
    ...(typeof patch.pid === "number" ? { pid: patch.pid } : {}),
    ...(patch.startToken === null
      ? { startToken: undefined }
      : patch.startToken !== undefined
        ? { startToken: patch.startToken }
        : {}),
    ...(patch.dispatchId !== undefined ? { dispatchId: patch.dispatchId } : {}),
  };
  if (updated.startToken === undefined) delete updated.startToken;

  const tmp = `${lock.lockPath}.${process.pid.toString(36)}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
    fs.renameSync(tmp, lock.lockPath);
    return updated;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Release a cwd lock. When given a `CwdLockInfo` (or `opts.token`), only deletes
 * the lock if its on-disk ownership token matches — preventing a finished caller
 * from accidentally removing a subsequent holder's lock.
 */
export function releaseCwdLock(
  target: CwdLockInfo | string,
  opts: { token?: string; pid?: number } = {},
): boolean {
  const lockPath =
    typeof target === "string" ? cwdLockPath(resolveCwdRealpath(target)) : target.lockPath;
  const expectedToken = typeof target === "string" ? opts.token : target.token;
  const expectedPid = typeof target === "string" ? opts.pid : undefined;

  const existing = readLockFile(lockPath);
  if (existing.status === "missing") return false;
  if (existing.status === "ok") {
    if (expectedToken && existing.lock.token !== expectedToken) return false;
    if (expectedPid !== undefined && existing.lock.pid !== expectedPid) return false;
  } else if (expectedToken) {
    return false;
  }

  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List currently active cwd locks, automatically pruning dead-PID / stale locks
 * by default (`pruneStale !== false`).
 */
export function listActiveCwdLocks(
  opts: {
    pruneStale?: boolean;
    now?: number;
    staleMs?: number;
  } = {},
): CwdLockInfo[] {
  const dir = cwdLockDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const prune = opts.pruneStale !== false;
  const active: CwdLockInfo[] = [];

  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    const full = path.join(dir, name);
    const read = readLockFile(full);
    if (read.status === "missing") continue;
    if (read.status === "corrupt" || isLockStale(read.lock, now, staleMs)) {
      if (prune) {
        try {
          fs.unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    active.push(read.lock);
  }

  return active.sort((a, b) => b.acquiredAt - a.acquiredAt);
}
