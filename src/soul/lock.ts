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
 * withFileLock implements a portable advisory mutex by writing the lock body to
 * a private temp file and then `link()`-ing it into place — link() fails if the
 * target exists, so the lock is created exclusively AND already holds its full
 * content (no window where a contender can read a half-written file and mistake
 * it for stale). It self-heals from a crashed holder via a staleness timeout +
 * a best-effort liveness check on the recorded pid, stealing atomically by
 * renaming the stale file away so racing contenders can't clobber each other.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../fs-utils.js";
import { soulDir } from "./paths.js";

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
  } catch (e) {
    // The file vanished between the failed create and our read — the holder
    // released it. There's nothing to steal; let the caller retry the create
    // race. (Treating this as "stale" would race a concurrent acquirer into an
    // unconditional rm that could delete a *different* holder's fresh lock.)
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
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
    // Write the lock body to a private temp file first, then atomically link it
    // into place. link() fails with EEXIST if the lock already exists, so
    // exclusive creation and "the lock file always has complete content" hold
    // simultaneously — a contender can never observe a half-written lock and
    // mistake it for malformed/stale. The temp name is unique per attempt so
    // concurrent acquirers in the *same* process don't clobber each other.
    const tmp = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ pid: process.pid, ts: Date.now() } satisfies LockBody));
      try {
        await fsp.link(tmp, lockPath);
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
      break; // acquired
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Held by someone. Steal if stale, else wait.
      if (await isStale(lockPath, staleMs)) {
        // Steal atomically: rename the stale file to a unique name so only one
        // contender can claim it. Losers get ENOENT and just retry the link
        // race — nobody unconditionally rm's a path that may already hold a
        // fresh lock from a concurrent acquirer.
        await fsp
          .rename(lockPath, tmp)
          .then(() => fsp.rm(tmp, { force: true }))
          .catch(() => {});
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
export const SOUL_LOCK_PATH = path.join(soulDir(), ".write.lock");

/**
 * Run `fn` while holding the soul write-lock. Use this around any
 * read-modify-write of soul state (e.g. desire-progress appends) so a
 * concurrent heartbeat/idle/chat process can't interleave and lose data.
 */
export function withSoulLock<T>(fn: () => Promise<T>, opts?: FileLockOpts): Promise<T> {
  return withFileLock(SOUL_LOCK_PATH, fn, opts);
}
