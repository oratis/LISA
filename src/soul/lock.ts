/**
 * Cross-process advisory file lock for soul writes.
 *
 * The in-process commit queue (git.ts enqueueCommit) serializes writes within
 * ONE process, but LISA runs as several processes against the same
 * ~/.lisa/soul/: the web server, the CLI/REPL, and — crucially — the
 * heartbeat/idle runners launched by launchd/cron on their own clock. Two of
 * those writing concurrently can:
 *   - lose a desire-progress append (read-modify-write race), or
 *   - collide on .git/index.lock (one commit fails).
 *
 * withFileLock implements a portable advisory mutex via exclusive file
 * creation (`open(..., "wx")` succeeds only if the file doesn't exist). It
 * self-heals from a crashed holder via a staleness timeout + a best-effort
 * liveness check on the recorded pid.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../fs-utils.js";
import { SOUL_DIR } from "./paths.js";

export interface FileLockOpts {
  /** Treat a held lock as abandoned after this many ms (crashed holder). */
  staleMs?: number;
  /** Give up acquiring after this many ms. */
  timeoutMs?: number;
  /** Poll interval while waiting for the lock. */
  pollMs?: number;
}

const DEFAULTS = { staleMs: 30_000, timeoutMs: 10_000, pollMs: 50 };

interface LockBody {
  pid: number;
  ts: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Is the process holding this lock gone or the lock too old to trust? */
async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  let body: LockBody;
  try {
    body = JSON.parse(await fsp.readFile(lockPath, "utf8")) as LockBody;
  } catch {
    // Unreadable / malformed lock file → treat as stale so we can recover.
    return true;
  }
  if (typeof body.ts !== "number" || Date.now() - body.ts > staleMs) return true;
  // Best-effort liveness: signal 0 throws ESRCH if the pid is dead. Only
  // meaningful on the same host; on a different host kill() may report the
  // wrong answer, so we still rely primarily on the ts timeout above.
  if (typeof body.pid === "number" && body.pid > 0) {
    try {
      process.kill(body.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return true; // holder dead
    }
  }
  return false;
}

/**
 * Run `fn` while holding an exclusive lock at `lockPath`. Releases the lock
 * (deletes the file) when `fn` settles, success or failure.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOpts = {},
): Promise<T> {
  const { staleMs, timeoutMs, pollMs } = { ...DEFAULTS, ...opts };
  await ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + timeoutMs;

  // ── acquire ──
  for (;;) {
    try {
      const fh = await fsp.open(lockPath, "wx");
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() } satisfies LockBody));
      } finally {
        await fh.close();
      }
      break; // acquired
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Held by someone. Steal if stale, else wait.
      if (await isStale(lockPath, staleMs)) {
        await fsp.rm(lockPath, { force: true }).catch(() => {});
        continue; // retry immediately
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring lock ${lockPath} after ${timeoutMs}ms`);
      }
      await delay(pollMs);
    }
  }

  // ── critical section ──
  try {
    return await fn();
  } finally {
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
}

/** The canonical soul write-lock path. */
export const SOUL_LOCK_PATH = path.join(SOUL_DIR, ".write.lock");

/**
 * Run `fn` while holding the soul write-lock. Use this around any
 * read-modify-write of soul state (e.g. desire-progress appends) so a
 * concurrent heartbeat/idle/chat process can't interleave and lose data.
 */
export function withSoulLock<T>(fn: () => Promise<T>, opts?: FileLockOpts): Promise<T> {
  return withFileLock(SOUL_LOCK_PATH, fn, opts);
}
