/**
 * Per-task run lease — the guarantee that one task is never run twice at once.
 *
 * LISA is several processes over one home: `serve --web` ticks the scheduler
 * every 30 s, and launchd wakes `lisa heartbeat run` every 30 min, which runs
 * due tasks through the same runner. Both must take this lease before touching
 * a task; whoever loses simply skips it.
 *
 * A lease is held for a whole run, so it has to survive three things a short
 * mutex never meets:
 *
 *  1. The holder dies. Its lease becomes stealable — at once when its process
 *     is provably gone on this host, on expiry when it lived on another host.
 *  2. The holder is alive but stalled (a blocked event loop, a sleeping
 *     laptop). On this host a live holder is NEVER stolen from, however long
 *     its lease has been expired: "expired" only means "did not renew", and a
 *     stalled holder that wakes up would otherwise run alongside its thief.
 *     Liveness is the pid PLUS the process start time recorded in the lease, so
 *     a recycled pid does not keep a dead holder's lease alive for ever.
 *  3. The lease is taken from a holder that is still running (another host,
 *     after expiry). The holder must notice and stop. Every lease carries a
 *     fencing token; `verify()` re-reads the file and answers "is it still
 *     mine?". The runner asks before every side-effecting call and every
 *     write, and a failed or erroring renewal reports the lease lost.
 *
 * Mutation is compare-and-swap. Creation is exclusive (link(), O_EXCL where
 * hard links are missing). Stealing, renewing and releasing each run under a
 * short mutex and act only on the exact body they just read — a contender can
 * never remove a lease other than the one it judged stale, and a holder can
 * never renew or release a lease that is no longer its own.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "../soul/lock.js";
import { tasksDir } from "./store.js";

export const DEFAULT_LEASE_TTL_MS = 90_000;
/** A lease file that does not parse is only treated as abandoned once it is this old. */
const MALFORMED_GRACE_MS = 10_000;
/** How far a process start time may differ from the recorded one and still be "the same process". */
const START_TOLERANCE_MS = 5_000;

interface LeaseBody {
  owner: string;
  /** Fencing token: unique per acquisition. */
  token: string;
  pid: number;
  host: string;
  /** When the holder PROCESS started (epoch ms) — tells a live holder from a recycled pid. */
  started: number;
  ts: number;
  expiresAt: number;
}

export interface TaskLease {
  readonly name: string;
  readonly owner: string;
  /** True once a renewal failed or found the lease in someone else's hands. */
  readonly lost: boolean;
  /** Push the expiry forward. False when the lease is no longer ours. */
  renew(): Promise<boolean>;
  /** Fencing check: is the lease on disk still this acquisition? */
  verify(): Promise<boolean>;
  /** Stop renewing and give the lease up (no-op if it was already lost). */
  release(): Promise<void>;
}

export interface AcquireLeaseOptions {
  ttlMs?: number;
  /** Stable identity of the acquiring runner; random per call when unset. */
  owner?: string;
  /** Renew automatically until released. Default true. */
  autoRenew?: boolean;
  /** Renewal period. Default ttl/3. */
  renewEveryMs?: number;
  /** Called once, when a renewal fails, errors, or finds the lease taken. */
  onLost?: () => void;
  now?: () => number;
  /** Test seam: when did the process with this pid start (epoch ms)? null = cannot tell. */
  processStartedAt?: (pid: number) => Promise<number | null>;
}

const SELF_STARTED = Math.round(Date.now() - process.uptime() * 1000);

function leasePath(name: string): string {
  if (!/^[a-z0-9_][a-z0-9_-]{0,80}$/.test(name)) throw new Error(`invalid lease name: ${name}`);
  return path.join(tasksDir(), ".leases", `${name}.lease`);
}

type Read =
  { kind: "missing" } | { kind: "malformed"; ageMs: number } | { kind: "ok"; body: LeaseBody };

async function readLease(file: string): Promise<Read> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw e;
  }
  try {
    const body = JSON.parse(raw) as LeaseBody;
    // `token` / `started` may be absent on a body written by something older or
    // foreign: such a lease is still judged by its holder (pid, host, expiry),
    // it just can never pass anyone's fencing check.
    if (
      body &&
      typeof body.owner === "string" &&
      typeof body.expiresAt === "number" &&
      typeof body.pid === "number" &&
      typeof body.host === "string"
    ) {
      return { kind: "ok", body };
    }
  } catch {
    // fall through
  }
  const stat = await fsp.stat(file).catch(() => null);
  return { kind: "malformed", ageMs: stat ? Date.now() - stat.mtimeMs : 0 };
}

/** Start time of another process on this host, via `ps`. null when it cannot be determined. */
function psStartedAt(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: 2000, env: { ...process.env, LC_ALL: "C", LANG: "C" } },
      (err, stdout) => {
        if (err) return resolve(null);
        const at = Date.parse(stdout.trim().replace(/\s+/g, " "));
        resolve(Number.isFinite(at) ? at : null);
      },
    );
  });
}

/**
 * Is the holder of this lease gone? See the file header for the rules.
 */
async function holderIsGone(
  body: LeaseBody,
  now: number,
  startedAt: (pid: number) => Promise<number | null>,
): Promise<boolean> {
  if (body.host !== os.hostname()) return body.expiresAt <= now;
  if (!(body.pid > 0)) return body.expiresAt <= now;
  // This very process: a second runner in it waits like anyone else.
  if (body.pid === process.pid) {
    return (
      typeof body.started === "number" && Math.abs(body.started - SELF_STARTED) > START_TOLERANCE_MS
    );
  }
  try {
    process.kill(body.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return true; // provably dead
    // EPERM: a process with that pid exists but is not ours — examine it below.
  }
  // Something with that pid is alive. Is it the holder, or a recycled pid?
  if (typeof body.started !== "number") return false;
  const actual = await startedAt(body.pid);
  if (actual === null) return false; // cannot tell ⇒ assume it is the holder
  return Math.abs(actual - body.started) > START_TOLERANCE_MS;
}

async function createExclusive(file: string, body: string): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(tmp, body);
    try {
      await fsp.link(tmp, file);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EPERM") throw e;
      try {
        const fh = await fsp.open(file, "wx");
        try {
          await fh.writeFile(body);
        } finally {
          await fh.close();
        }
        return true;
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e2;
      }
    }
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/** The short mutex every steal / renew / release of one lease runs under. */
function mutate<T>(file: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`${file}.mx`, fn, { staleMs: 15_000, timeoutMs: 5_000, pollMs: 15 });
}

/**
 * Try to take the named lease. Resolves to null — without waiting for the
 * holder — when a live holder has it.
 */
export async function acquireLease(
  name: string,
  opts: AcquireLeaseOptions = {},
): Promise<TaskLease | null> {
  const file = leasePath(name);
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = opts.now ?? Date.now;
  const owner = opts.owner ?? `${process.pid}-${randomBytes(6).toString("hex")}`;
  const token = randomBytes(12).toString("hex");
  const startedAt = opts.processStartedAt ?? psStartedAt;
  // Not recursive: the tasks directory must already exist. A lease is never
  // what brings a deleted home back.
  await fsp.mkdir(path.dirname(file)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });

  const body = (): string =>
    JSON.stringify({
      owner,
      token,
      pid: process.pid,
      host: os.hostname(),
      started: SELF_STARTED,
      ts: now(),
      expiresAt: now() + ttlMs,
    } satisfies LeaseBody);

  let acquired = await createExclusive(file, body());
  if (!acquired) {
    acquired = await mutate(file, async () => {
      // Under the mutex nobody else can steal, renew or release this lease, so
      // what is read here is exactly what gets judged — and removed.
      const current = await readLease(file);
      if (current.kind === "missing") return await createExclusive(file, body());
      if (current.kind === "malformed") {
        if (current.ageMs < MALFORMED_GRACE_MS) return false; // may be mid-write
      } else if (!(await holderIsGone(current.body, now(), startedAt))) {
        return false;
      }
      await fsp.rm(file, { force: true });
      return await createExclusive(file, body());
    });
  }
  if (!acquired) return null;

  let released = false;
  let lost = false;
  let timer: NodeJS.Timeout | null = null;

  const stopTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const markLost = (): void => {
    if (lost || released) return;
    lost = true;
    stopTimer();
    try {
      opts.onLost?.();
    } catch {
      // The callback aborts a run; it must not take the timer down with it.
    }
  };

  const isMine = (read: Read): boolean => read.kind === "ok" && read.body.token === token;

  const renew = async (): Promise<boolean> => {
    if (released || lost) return false;
    const held = await mutate(file, async () => {
      if (!isMine(await readLease(file))) return false;
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await fsp.writeFile(tmp, body());
      await fsp.rename(tmp, file);
      return true;
    });
    if (!held) markLost();
    return held;
  };

  if (opts.autoRenew !== false) {
    timer = setInterval(
      () => {
        // Failed OR errored: either way we can no longer vouch for ownership.
        void renew().catch(() => markLost());
      },
      opts.renewEveryMs ?? Math.max(1000, Math.floor(ttlMs / 3)),
    );
    timer.unref?.();
  }

  return {
    name,
    owner,
    get lost() {
      return lost;
    },
    renew,
    verify: async () => {
      if (released || lost) return false;
      let mine: boolean;
      try {
        mine = isMine(await readLease(file));
      } catch {
        mine = false;
      }
      if (!mine) markLost();
      return mine;
    },
    release: async () => {
      if (released) return;
      released = true;
      stopTimer();
      if (lost) return;
      await mutate(file, async () => {
        if (isMine(await readLease(file))) await fsp.rm(file, { force: true });
      }).catch(() => {});
    },
  };
}

/** The lease that serialises runs of one task. */
export function acquireTaskLease(
  taskId: string,
  opts?: AcquireLeaseOptions,
): Promise<TaskLease | null> {
  return acquireLease(`task-${taskId}`, opts);
}
