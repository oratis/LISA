/**
 * Per-task run lease — the guarantee that one task is never run twice at once.
 *
 * LISA is several processes over one home: `serve --web` ticks the scheduler
 * every 30 s, and launchd wakes `lisa heartbeat run` every 30 min, which runs
 * due tasks through the same runner. Both must take this lease before touching
 * a task; whoever loses simply skips it.
 *
 * Unlike soul/lock.ts (a mutex held for milliseconds) a lease is held for a
 * whole run, so it carries an expiry that the holder keeps pushing forward. A
 * holder that dies stops renewing; the lease then becomes stealable when it
 * expires, or immediately when its pid is provably gone on this host — which is
 * what lets a restarted server resume an interrupted run without waiting.
 *
 * Creation is exclusive via link() (O_EXCL fallback for filesystems without
 * hard links, e.g. gcsfuse), stealing is a rename so two contenders cannot both
 * win.
 */
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDir } from "../fs-utils.js";
import { tasksDir } from "./store.js";

export const DEFAULT_LEASE_TTL_MS = 90_000;

interface LeaseBody {
  owner: string;
  pid: number;
  host: string;
  ts: number;
  expiresAt: number;
}

export interface TaskLease {
  readonly name: string;
  readonly owner: string;
  /** Push the expiry forward. False when the lease is no longer ours. */
  renew(): Promise<boolean>;
  /** Stop renewing and give the lease up (no-op if it was already lost). */
  release(): Promise<void>;
}

export interface AcquireLeaseOptions {
  ttlMs?: number;
  /** Stable identity of the acquiring runner; random per call when unset. */
  owner?: string;
  /** Renew automatically every ttl/3 until released. Default true. */
  autoRenew?: boolean;
  now?: () => number;
}

function leasePath(name: string): string {
  if (!/^[a-z0-9_][a-z0-9_-]{0,80}$/.test(name)) throw new Error(`invalid lease name: ${name}`);
  return path.join(tasksDir(), ".leases", `${name}.lease`);
}

async function readBody(file: string): Promise<LeaseBody | "missing" | "malformed"> {
  try {
    const body = JSON.parse(await fsp.readFile(file, "utf8")) as LeaseBody;
    if (typeof body.owner !== "string" || typeof body.expiresAt !== "number") return "malformed";
    return body;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "malformed";
  }
}

function holderIsGone(body: LeaseBody, now: number): boolean {
  if (body.expiresAt <= now) return true;
  // Liveness is only meaningful for a holder on this host, in ANOTHER process:
  // a second runner inside this process must wait for the expiry like anyone else.
  if (body.host === os.hostname() && body.pid > 0 && body.pid !== process.pid) {
    try {
      process.kill(body.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
  }
  return false;
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
 * Try to take the named lease. Resolves to null — immediately, without
 * waiting — when a live holder has it.
 */
export async function acquireLease(name: string, opts: AcquireLeaseOptions = {}): Promise<TaskLease | null> {
  const file = leasePath(name);
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = opts.now ?? Date.now;
  const owner = opts.owner ?? `${process.pid}-${randomBytes(6).toString("hex")}`;
  await ensureDir(path.dirname(file));

  const body = (): string =>
    JSON.stringify({
      owner,
      pid: process.pid,
      host: os.hostname(),
      ts: now(),
      expiresAt: now() + ttlMs,
    } satisfies LeaseBody);

  let acquired = false;
  // Two attempts: the second follows a successful steal of a dead holder's lease.
  for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
    if (await createExclusive(file, body())) {
      acquired = true;
      break;
    }
    const current = await readBody(file);
    if (current === "missing") continue; // released between our create and read
    if (current !== "malformed" && !holderIsGone(current, now())) return null;
    // Steal: only one contender's rename succeeds; the rest get ENOENT and retry.
    const grave = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.stale`;
    await fsp
      .rename(file, grave)
      .then(() => fsp.rm(grave, { force: true }))
      .catch(() => {});
  }
  if (!acquired) return null;

  let released = false;
  let timer: NodeJS.Timeout | null = null;

  const renew = async (): Promise<boolean> => {
    if (released) return false;
    const current = await readBody(file);
    if (current === "missing" || current === "malformed" || current.owner !== owner) {
      return false; // stolen after an expiry — do not take it back
    }
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fsp.writeFile(tmp, body());
    await fsp.rename(tmp, file);
    return true;
  };

  const stopTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  if (opts.autoRenew !== false) {
    timer = setInterval(
      () => {
        void renew()
          .then((held) => {
            if (!held) stopTimer();
          })
          .catch(() => {});
      },
      Math.max(1000, Math.floor(ttlMs / 3)),
    );
    timer.unref?.();
  }

  return {
    name,
    owner,
    renew,
    release: async () => {
      if (released) return;
      released = true;
      stopTimer();
      const current = await readBody(file);
      if (current !== "missing" && current !== "malformed" && current.owner === owner) {
        await fsp.rm(file, { force: true }).catch(() => {});
      }
    },
  };
}

/** The lease that serialises runs of one task. */
export function acquireTaskLease(taskId: string, opts?: AcquireLeaseOptions): Promise<TaskLease | null> {
  return acquireLease(`task-${taskId}`, opts);
}
