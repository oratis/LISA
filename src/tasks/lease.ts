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
 *     On the hosted edition every holder counts as "another host": instances
 *     can share a hostname and pids, so a pid proves nothing there.
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
 * A lease reported lost because a renewal ERRORED (a transient disk error) is
 * usually still ours on disk. `release()` removes it anyway — compare-and-swap
 * on the token — and if even that fails, the process's own tick removes it
 * later (sweepOrphanLeases): a lease naming a live process is never stolen by
 * anyone else on this host, so an orphan left in place would strand its task
 * until the process exits.
 *
 * Mutation is compare-and-swap. Creation is exclusive (link(), O_EXCL where
 * hard links are missing). Stealing, renewing, releasing and the orphan sweep
 * each run under a short mutex, but none relies on it alone: the mutex is
 * taken from a holder stalled inside it for over 15 s — and, with pid
 * liveness (this host), at once from one whose pid is not alive here; on the
 * hosted edition by age only. So each of them acts on the file after moving
 * it aside to a private name and comparing it there with the body it read
 * (removeIfUnchanged, replaceIfUnchanged): a different body — a lease someone
 * took meanwhile — is put back, and a renewal installs its new body with an
 * exclusive create. A contender never removes a lease other than the one it
 * judged stale, and a holder never renews over or removes a lease that is no
 * longer its own, however late its call lands. An acquisition re-reads the
 * lease after writing it and succeeds only if the file carries its token.
 *
 * The limit: while a file is moved aside its path is empty for an instant
 * (a rename, a read, a link — longer on a FUSE volume). A contender whose
 * exclusive create lands in that instant gets the lease. If the file moved
 * aside was a renewing holder's own, its renewal fails and it stops; if it was
 * someone else's (a late call), it cannot be put back and that holder fails
 * its next verify() and stops. Either way fencing (verify() before every
 * write and side effect) stops the one that lost. verify() waits out its own
 * holder's renewal, so a renewal never makes its own holder look lost.
 *
 * Known gaps (docs/DESIGN_TASK_ENGINE.md, "Known gaps"): a late call stalled
 * past both the mutex staleness and the holder's TTL can put a holder's body
 * back after another holder came and went in the gap, reviving the old lease
 * (ABA); on the hosted edition a dead instance's mutex outlasts the 5 s
 * operation timeout, and without hard links the mutex can be entered twice;
 * a process killed mid-swap leaves an inert `*.judged` file.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isCloud } from "../edition.js";
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
  /**
   * True when the lease was lost because its directory no longer exists: the
   * task, or the whole home, was deleted. Nothing is re-created for it.
   */
  readonly gone: boolean;
  /** Push the expiry forward. False when the lease is no longer ours. */
  renew(): Promise<boolean>;
  /** Fencing check: is the lease on disk still this acquisition? */
  verify(): Promise<boolean>;
  /**
   * Stop renewing and give the lease up. Also after it was reported lost: the
   * file is removed if it still carries this acquisition's token.
   */
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
  /**
   * Judge a holder on this host by its pid and process start time. Default:
   * yes, except on the hosted edition — see pidLivenessDefault().
   */
  pidLiveness?: boolean;
}

/**
 * Whether a holder's pid says anything about it. Not on the hosted edition:
 * Cloud Run instances can share a hostname (and, in containers, pids), so a
 * holder on another instance would look like a dead — or recycled — process
 * here and be stolen from at once. There every holder is treated as remote:
 * stolen from on expiry only.
 */
export function pidLivenessDefault(): boolean {
  return !isCloud();
}

const SELF_STARTED = Math.round(Date.now() - process.uptime() * 1000);

/**
 * Fencing tokens of the leases this process holds right now: acquired (or
 * being acquired) and not yet released. A lease file that names this process
 * but carries none of these tokens is an orphan — a release that could not
 * remove it — and nobody else on this host could ever take it, because its
 * holder (this process) is alive. See sweepOrphanLeases().
 */
const heldHere = new Set<string>();

function leasePath(name: string): string {
  if (!/^[a-z0-9_][a-z0-9_-]{0,80}$/.test(name)) throw new Error(`invalid lease name: ${name}`);
  return path.join(tasksDir(), ".leases", `${name}.lease`);
}

type Read =
  | { kind: "missing" }
  | { kind: "malformed"; ageMs: number; raw: string }
  | { kind: "ok"; body: LeaseBody; raw: string };

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
      return { kind: "ok", body, raw };
    }
  } catch {
    // fall through
  }
  const stat = await fsp.stat(file).catch(() => null);
  return { kind: "malformed", ageMs: stat ? Date.now() - stat.mtimeMs : 0, raw };
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
  pidLiveness: boolean,
): Promise<boolean> {
  if (!pidLiveness || body.host !== os.hostname()) return body.expiresAt <= now;
  if (!(body.pid > 0)) return body.expiresAt <= now;
  if (body.pid === process.pid) {
    // A previous life of this pid.
    if (
      typeof body.started === "number" &&
      Math.abs(body.started - SELF_STARTED) > START_TOLERANCE_MS
    )
      return true;
    // This very process. A run here holding it: a second runner waits like
    // anyone else. Nothing here holding it: an orphan, free to take.
    return !(typeof body.token === "string" && heldHere.has(body.token));
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

/**
 * Remove the lease file only if it still holds exactly `judged` — the body a
 * contender read and found stale. The file is first moved to a private name,
 * so the comparison and the removal are made on the same file even when the
 * mutex was not exclusive (a holder stalled inside it longer than its
 * staleness limit). A body that turns out to be different is someone's fresh
 * lease: it is put back, unless an even newer one already took the path.
 * True when the judged body is no longer at the path.
 */
async function removeIfUnchanged(file: string, judged: string): Promise<boolean> {
  const aside = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.judged`;
  try {
    await fsp.rename(file, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; // already gone
    throw e;
  }
  try {
    const moved = await fsp.readFile(aside, "utf8").catch(() => null);
    if (moved === judged) return true;
    if (moved !== null) await createExclusive(file, moved).catch(() => false);
    else await fsp.link(aside, file).catch(() => {});
    return false;
  } finally {
    await fsp.rm(aside, { force: true }).catch(() => {});
  }
}

/**
 * Renewal's compare-and-swap: replace the lease body only if the file still
 * holds exactly `judged` (the holder's own body, just read). Like
 * removeIfUnchanged, the file is moved aside and compared there, so a renewal
 * that stalled past the mutex's staleness can never overwrite a lease someone
 * took meanwhile: a different body is put back and the renewal fails. The new
 * body is then created exclusively, so if a contender created its lease in
 * the instant the path was empty, that contender keeps it and the renewal
 * fails (the holder stops: fencing). If the new body cannot be written, the
 * judged one is put back — on disk the lease stays the holder's.
 */
async function replaceIfUnchanged(file: string, judged: string, next: string): Promise<boolean> {
  const aside = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.judged`;
  try {
    await fsp.rename(file, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; // gone: not ours
    throw e;
  }
  try {
    const moved = await fsp.readFile(aside, "utf8").catch(() => null);
    if (moved !== judged) {
      if (moved !== null) await createExclusive(file, moved).catch(() => false);
      else await fsp.link(aside, file).catch(() => {});
      return false;
    }
    try {
      return await createExclusive(file, next);
    } catch (e) {
      await fsp.link(aside, file).catch(() => createExclusive(file, judged).catch(() => false));
      throw e;
    }
  } finally {
    await fsp.rm(aside, { force: true }).catch(() => {});
  }
}

/**
 * The short mutex every steal / renew / release of one lease runs under. It
 * never creates a directory: when the lease directory is gone (the task or the
 * whole home was deleted), so is the lease, and the call fails with ENOENT.
 * Without pid liveness (hosted) a mutex holder is judged by age only, like a
 * lease holder: a pid from another instance proves nothing here.
 */
function mutate<T>(file: string, fn: () => Promise<T>, pidLiveness: boolean): Promise<T> {
  return withFileLock(`${file}.mx`, fn, {
    staleMs: 15_000,
    timeoutMs: 5_000,
    pollMs: 15,
    createDir: false,
    pidLiveness,
  });
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
  const pidLiveness = opts.pidLiveness ?? pidLivenessDefault();
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

  const take = async (): Promise<boolean> => {
    const created =
      (await createExclusive(file, body())) ||
      (await mutate(
        file,
        async () => {
          const current = await readLease(file);
          if (current.kind === "missing") return await createExclusive(file, body());
          if (current.kind === "malformed") {
            if (current.ageMs < MALFORMED_GRACE_MS) return false; // may be mid-write
          } else if (!(await holderIsGone(current.body, now(), startedAt, pidLiveness))) {
            return false;
          }
          // Compare-and-swap: only the exact body judged stale is removed.
          if (!(await removeIfUnchanged(file, current.raw))) return false;
          return await createExclusive(file, body());
        },
        pidLiveness,
      ));
    if (!created) return false;
    // Written — but is it still there? A contender that stole the mutex from
    // a stalled holder could have replaced it since. Report success only for
    // the body on disk now.
    const after = await readLease(file);
    return after.kind === "ok" && after.body.token === token;
  };

  // Registered before the file exists: a contender in this process that reads
  // the new lease must never mistake it for an orphan.
  heldHere.add(token);
  let acquired = false;
  try {
    acquired = await take();
  } finally {
    if (!acquired) heldHere.delete(token);
  }
  if (!acquired) return null;

  let released = false;
  let lost = false;
  let gone = false;
  let timer: NodeJS.Timeout | null = null;
  /**
   * Set while a renewal has the file moved aside, and counted: verify() waits
   * out our own renewal and re-reads when one overlapped its read.
   */
  let swapping: Promise<unknown> | null = null;
  let swaps = 0;

  /** The lease directory is gone, and with it the lease (a deleted task or home). */
  const directoryGone = async (): Promise<boolean> => {
    try {
      await fsp.stat(path.dirname(file));
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT";
    }
  };

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

  const isMine = (read: Read): read is Extract<Read, { kind: "ok" }> =>
    read.kind === "ok" && read.body.token === token;

  const renew = async (): Promise<boolean> => {
    if (released || lost) return false;
    let held: boolean;
    try {
      held = await mutate(
        file,
        async () => {
          const current = await readLease(file);
          if (!isMine(current)) return false;
          // Compare-and-swap on the body just read: a renewal that stalled
          // never overwrites a lease someone else took meanwhile.
          swaps++;
          const swap = replaceIfUnchanged(file, current.raw, body());
          swapping = swap.catch(() => {});
          try {
            return await swap;
          } finally {
            swapping = null;
          }
        },
        pidLiveness,
      );
    } catch (e) {
      if (!(await directoryGone())) throw e;
      held = false;
    }
    if (!held) {
      if (await directoryGone()) gone = true;
      markLost();
    }
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
    get gone() {
      return gone;
    },
    renew,
    verify: async () => {
      if (released || lost) return false;
      let mine = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        // Our own renewal leaves the path empty for an instant: not a loss.
        while (swapping) await swapping;
        const seen = swaps;
        try {
          mine = isMine(await readLease(file));
        } catch {
          mine = false;
        }
        if (mine || (swaps === seen && !swapping)) break;
      }
      if (!mine) {
        if (await directoryGone()) gone = true;
        markLost();
      }
      return mine;
    },
    release: async () => {
      if (released) return;
      released = true;
      stopTimer();
      // Lost or not. A renewal that ERRORED marks the lease lost while the
      // file on disk is still this acquisition; left there, it would name a
      // live holder (this process) for as long as the process lives. The
      // removal is compare-and-swap — on the token, then on the exact body
      // moved aside (removeIfUnchanged) — so a lease someone else took is
      // never removed, even by a release that stalled past the mutex's
      // staleness. If it fails, the token is no longer held here and the
      // next tick's sweep removes the orphan.
      try {
        await mutate(
          file,
          async () => {
            const current = await readLease(file);
            if (isMine(current)) await removeIfUnchanged(file, current.raw);
          },
          pidLiveness,
        );
      } catch {
        // swept later
      } finally {
        heldHere.delete(token);
      }
    },
  };
}

/** Is this a lease of this very process that no live acquisition here holds? */
function isOrphanHere(read: Read): read is Extract<Read, { kind: "ok" }> {
  return (
    read.kind === "ok" &&
    read.body.host === os.hostname() &&
    read.body.pid === process.pid &&
    typeof read.body.started === "number" &&
    Math.abs(read.body.started - SELF_STARTED) <= START_TOLERANCE_MS &&
    !(typeof read.body.token === "string" && heldHere.has(read.body.token))
  );
}

/**
 * Remove the leases of this process that no run here holds any more: a
 * release whose removal failed left them behind. Called on every scheduler
 * tick. Another process on this host can never take such a lease (its holder,
 * this process, is alive), so only this process can clean it up. Each removal
 * is compare-and-swap on the body just read. Best effort: what cannot be
 * removed now is tried again at the next tick. Returns how many were removed.
 */
export async function sweepOrphanLeases(opts: { pidLiveness?: boolean } = {}): Promise<number> {
  // Without pid liveness a lease naming "this" pid may be another instance's;
  // an orphan there simply expires and is stolen on expiry.
  if (!(opts.pidLiveness ?? pidLivenessDefault())) return 0;
  const dir = path.join(tasksDir(), ".leases");
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".lease")) continue;
    const file = path.join(dir, name);
    try {
      const seen = await readLease(file);
      if (!isOrphanHere(seen)) continue;
      const judged = seen.raw;
      await mutate(
        file,
        async () => {
          const again = await readLease(file);
          if (isOrphanHere(again) && again.raw === judged) {
            // Compare-and-swap on the body moved aside, like a steal.
            if (await removeIfUnchanged(file, again.raw)) removed++;
          }
        },
        true,
      );
    } catch {
      // next tick
    }
  }
  return removed;
}

/**
 * Is some live runner holding this task's lease right now? Read-only: it takes
 * nothing and steals nothing.
 */
export async function taskLeaseHeld(
  taskId: string,
  now: number = Date.now(),
  opts: { pidLiveness?: boolean } = {},
): Promise<boolean> {
  let read: Read;
  try {
    read = await readLease(leasePath(`task-${taskId}`));
  } catch {
    return false;
  }
  if (read.kind !== "ok") return false;
  return !(await holderIsGone(
    read.body,
    now,
    psStartedAt,
    opts.pidLiveness ?? pidLivenessDefault(),
  ));
}

/** The lease that serialises runs of one task. */
export function acquireTaskLease(
  taskId: string,
  opts?: AcquireLeaseOptions,
): Promise<TaskLease | null> {
  return acquireLease(`task-${taskId}`, opts);
}
