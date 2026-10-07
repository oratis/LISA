import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { homeScope } from "../paths.js";
import { acquireLease, acquireTaskLease, sweepOrphanLeases, taskLeaseHeld } from "./lease.js";
import { tasksDir } from "./store.js";

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-tasks-lease-"));
  try {
    return await homeScope.run(home, async () => {
      await fsp.mkdir(tasksDir(), { recursive: true });
      return await fn();
    });
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
}

const leaseFile = (name: string) => path.join(tasksDir(), ".leases", `${name}.lease`);
const SELF_STARTED = Math.round(Date.now() - process.uptime() * 1000);

async function plant(name: string, body: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(path.dirname(leaseFile(name)), { recursive: true });
  await fsp.writeFile(leaseFile(name), JSON.stringify(body));
}
const ownerOf = async (name: string) =>
  (JSON.parse(await fsp.readFile(leaseFile(name), "utf8")) as { owner: string }).owner;
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Delete a directory the way a test means it: all at once. A recursive rm is
 * not atomic — renewals still running would see the lease file gone while its
 * directory still exists, or write into it mid-removal (ENOTEMPTY). Moving
 * the directory away first makes every path under it vanish in one step.
 */
async function vanish(dir: string): Promise<void> {
  const away = `${dir}.gone-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fsp.rename(dir, away);
  await fsp.rm(away, { recursive: true, force: true, maxRetries: 10 });
}

const exists = (file: string) =>
  fsp.stat(file).then(
    () => true,
    () => false,
  );

/** Make fs calls of one kind fail with `code` for paths `match` accepts, while `on()` is true. */
function failing<K extends "writeFile" | "rm" | "rename">(
  kind: K,
  match: (target: string) => boolean,
  code: string,
): { on: boolean; restore(): void } {
  const real = fsp[kind].bind(fsp) as (...args: unknown[]) => Promise<unknown>;
  const state = {
    on: true,
    restore: () => {
      (fsp as Record<string, unknown>)[kind] = real;
    },
  };
  (fsp as Record<string, unknown>)[kind] = async (target: unknown, ...rest: unknown[]) => {
    if (state.on && match(String(target))) {
      throw Object.assign(new Error(`${code}: injected`), { code });
    }
    return real(target, ...rest);
  };
  return state;
}

test("a held lease cannot be taken again until it is released", async () => {
  await withHome(async () => {
    const a = await acquireTaskLease("t_0123456789ab", { autoRenew: false });
    assert.ok(a);
    assert.equal(await a.verify(), true);
    assert.equal(await acquireTaskLease("t_0123456789ab", { autoRenew: false }), null);
    // A different task is unaffected.
    const other = await acquireTaskLease("t_ba9876543210", { autoRenew: false });
    assert.ok(other);
    await a.release();
    assert.equal(await a.verify(), false, "released is not owned");
    const b = await acquireTaskLease("t_0123456789ab", { autoRenew: false });
    assert.ok(b);
    await b.release();
    await other.release();
  });
});

test("of many simultaneous contenders exactly one wins", async () => {
  await withHome(async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, () => acquireLease("contended", { autoRenew: false })),
    );
    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1);
    await winners[0]!.release();
  });
});

test("a LIVE holder on this host is never stolen from, however long its lease has been expired", async () => {
  await withHome(async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const a = await acquireLease("stalled", { ttlMs: 1000, autoRenew: false, now });
    assert.ok(a);
    clock += 10 * 60_000; // ten minutes with no renewal: a blocked loop, a sleeping laptop
    assert.equal(await acquireLease("stalled", { ttlMs: 1000, autoRenew: false, now }), null);
    assert.equal(await a.verify(), true, "still the owner");
    assert.equal(await a.renew(), true);
    await a.release();

    // The same for a live holder in ANOTHER process on this host (pid 1 is always alive).
    await plant("other-proc", {
      owner: "peer",
      token: "tok",
      pid: 1,
      host: os.hostname(),
      started: 12345,
      ts: 0,
      expiresAt: 1, // long expired
    });
    const cannotTell = await acquireLease("other-proc", {
      autoRenew: false,
      processStartedAt: async () => null,
    });
    assert.equal(
      cannotTell,
      null,
      "when the process cannot be identified it is assumed to be the holder",
    );
    const sameProcess = await acquireLease("other-proc", {
      autoRenew: false,
      processStartedAt: async () => 12345 + 900,
    });
    assert.equal(sameProcess, null);
  });
});

test("a holder whose process is gone is stolen from at once: dead pid, or a recycled one", async () => {
  await withHome(async () => {
    await plant("dead", {
      owner: "dead",
      token: "tok",
      pid: 2 ** 30, // above every supported OS's pid ceiling
      host: os.hostname(),
      started: 1,
      ts: Date.now(),
      expiresAt: Date.now() + 3_600_000, // not even expired
    });
    const a = await acquireLease("dead", { autoRenew: false });
    assert.ok(a);
    await a.release();

    // pid 1 is alive, but it started at a different time than the lease records:
    // the holder died and its pid was handed to another process.
    await plant("recycled", {
      owner: "ghost",
      token: "tok",
      pid: 1,
      host: os.hostname(),
      started: 1_000_000,
      ts: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    const b = await acquireLease("recycled", {
      autoRenew: false,
      processStartedAt: async () => 9_000_000,
    });
    assert.ok(b);
    await b.release();

    // A lease that claims OUR pid but another process start: a previous life of this pid.
    await plant("previous-life", {
      owner: "ghost",
      token: "tok",
      pid: process.pid,
      host: os.hostname(),
      started: SELF_STARTED - 3_600_000,
      ts: 0,
      expiresAt: Date.now() + 3_600_000,
    });
    const c = await acquireLease("previous-life", { autoRenew: false });
    assert.ok(c);
    await c.release();
  });
});

test("a holder on another host is respected until expiry, then stolen from", async () => {
  await withHome(async () => {
    const body = {
      owner: "peer",
      token: "tok",
      pid: 4242,
      host: "some-other-host",
      started: 1,
      ts: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    };
    await plant("remote", body);
    assert.equal(await acquireLease("remote", { autoRenew: false }), null);
    await plant("remote", { ...body, expiresAt: Date.now() - 1 });
    const lease = await acquireLease("remote", { autoRenew: false });
    assert.ok(lease);
    await lease.release();
  });
});

test("fencing: a holder whose lease was taken cannot verify, renew or release it", async () => {
  await withHome(async () => {
    let lostCalls = 0;
    const a = await acquireLease("fenced", { autoRenew: false, onLost: () => lostCalls++ });
    assert.ok(a);
    // Another host steals it after an expiry (written directly: same effect on disk).
    await plant("fenced", {
      owner: "thief",
      token: "other-token",
      pid: 7,
      host: "some-other-host",
      started: 1,
      ts: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    assert.equal(await a.verify(), false);
    assert.equal(a.lost, true);
    assert.equal(lostCalls, 1);
    assert.equal(await a.renew(), false);
    await a.release();
    assert.equal(await ownerOf("fenced"), "thief", "the thief's lease is untouched");
    assert.equal(lostCalls, 1, "reported once");
  });
});

test("a renewal that finds the lease gone, or errors, reports it lost", async () => {
  await withHome(async () => {
    let lost = 0;
    const a = await acquireLease("renewing", { autoRenew: false, onLost: () => lost++ });
    assert.ok(a);
    try {
      assert.equal(await a.renew(), true);
      assert.equal(lost, 0);
      await fsp.rm(leaseFile("renewing"));
      assert.equal(await a.renew(), false);
      assert.equal(lost, 1);
      assert.equal(a.lost, true);
      assert.equal(await a.verify(), false);
    } finally {
      await a.release();
    }

    const noticed = deferred();
    const b = await acquireLease("erroring", {
      ttlMs: 60_000,
      renewEveryMs: 15,
      onLost: () => noticed.resolve(),
    });
    assert.ok(b);
    try {
      await vanish(path.dirname(leaseFile("erroring")));
      await fsp.writeFile(path.dirname(leaseFile("erroring")), "not a directory");
      await noticed.promise;
      assert.equal(b.lost, true);
    } finally {
      await b.release();
      await fsp.rm(path.dirname(leaseFile("erroring")), { force: true });
    }
  });
});

test("release waits for an in-flight renewal and concurrent renewals share one operation", async () => {
  await withHome(async () => {
    const lease = await acquireLease("drain", { autoRenew: false });
    assert.ok(lease);
    const entered = deferred();
    const proceed = deferred();
    const realRename = fsp.rename.bind(fsp);
    fsp.rename = async (from, to) => {
      if (String(from) === leaseFile("drain")) {
        entered.resolve();
        await proceed.promise;
      }
      return realRename(from, to);
    };
    try {
      const first = lease.renew();
      await entered.promise;
      assert.equal(lease.renew(), first);
      let released = false;
      const releasing = lease.release().then(() => {
        released = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(released, false);
      proceed.resolve();
      await first;
      await releasing;
      assert.equal(await exists(leaseFile("drain")), false);
      assert.equal(await exists(`${leaseFile("drain")}.mx`), false);
      assert.equal(await lease.renew(), false);
    } finally {
      proceed.resolve();
      fsp.rename = realRename;
      await lease.release();
    }
  });
});

test("stealing is compare-and-swap: a slow contender cannot remove a lease it did not judge (reviewer probe t4c)", async () => {
  await withHome(async () => {
    const name = "forced";
    await plant(name, {
      owner: "dead",
      token: "t",
      pid: 2 ** 30,
      host: os.hostname(),
      started: 1,
      ts: 1,
      expiresAt: 2,
    });
    // B is descheduled inside its steal: every removal B makes is delayed.
    const realRm = fsp.rm.bind(fsp);
    let delayed = false;
    (fsp as { rm: typeof fsp.rm }).rm = async (target, options) => {
      if (!delayed && String(target) === leaseFile(name)) {
        delayed = true;
        await new Promise((r) => setTimeout(r, 150));
      }
      return realRm(target, options);
    };
    try {
      const pB = acquireLease(name, { owner: "B", autoRenew: false });
      await new Promise((r) => setTimeout(r, 30));
      const A = await acquireLease(name, { owner: "A", autoRenew: false });
      const B = await pB;
      assert.equal([A, B].filter(Boolean).length, 1, "exactly one of them holds the lease");
      const holder = (A ?? B)!;
      assert.equal(await ownerOf(name), holder.owner);
      assert.equal(await holder.verify(), true);
      assert.equal(await holder.renew(), true);
      await holder.release();
    } finally {
      (fsp as { rm: typeof fsp.rm }).rm = realRm;
    }
  });
});

test("a lease file that does not parse is abandoned only once it is old enough to not be mid-write", async () => {
  await withHome(async () => {
    await fsp.mkdir(path.dirname(leaseFile("garbled")), { recursive: true });
    await fsp.writeFile(leaseFile("garbled"), "{ half a lea");
    assert.equal(
      await acquireLease("garbled", { autoRenew: false }),
      null,
      "fresh: may be mid-write",
    );
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(leaseFile("garbled"), old, old);
    const lease = await acquireLease("garbled", { autoRenew: false });
    assert.ok(lease);
    await lease.release();
  });
});

test("lease names are path-safe, and a lease never re-creates a deleted tasks directory", async () => {
  await withHome(async () => {
    await assert.rejects(acquireLease("../../etc/passwd"), /invalid lease name/);
    await fsp.rm(tasksDir(), { recursive: true, force: true });
    await assert.rejects(acquireLease("orphan", { autoRenew: false }));
    await assert.rejects(fsp.stat(tasksDir()), /ENOENT/);
  });
});

test("a lease reported lost because a renewal ERRORED is still removed on release: it was still ours (reviewer probe h2-stuck)", async () => {
  await withHome(async () => {
    let lost = 0;
    const a = await acquireLease("transient", {
      ttlMs: 60_000,
      renewEveryMs: 15,
      onLost: () => lost++,
    });
    assert.ok(a);
    // The lease directory refuses writes for a moment: the renewal errors.
    const dir = path.dirname(leaseFile("transient"));
    const fault = failing("writeFile", (p) => p.startsWith(dir), "EACCES");
    try {
      for (let i = 0; i < 100 && lost === 0; i++) await new Promise((r) => setTimeout(r, 10));
    } finally {
      fault.on = false;
      fault.restore();
    }
    assert.equal(lost, 1);
    assert.equal(a.lost, true);
    assert.equal(
      await ownerOf("transient"),
      a.owner,
      "on disk the lease is still this acquisition",
    );
    await a.release();
    assert.equal(
      await exists(leaseFile("transient")),
      false,
      "released, not left to block the task",
    );
    const b = await acquireLease("transient", { autoRenew: false });
    assert.ok(b);
    await b.release();
  });
});

test("a lease this process could not release is an orphan: the sweep removes it, a contender here takes it, a held one is untouched", async () => {
  await withHome(async () => {
    const orphan = async (name: string): Promise<void> => {
      const a = await acquireLease(name, { autoRenew: false });
      assert.ok(a);
      // Its removal fails (the move aside, or the unlink): the file stays,
      // naming this live process.
      const faults = [
        failing("rm", (p) => p === leaseFile(name), "EIO"),
        failing("rename", (p) => p === leaseFile(name), "EIO"),
      ];
      try {
        await a.release();
      } finally {
        for (const f of faults.reverse()) f.restore();
      }
      assert.equal(await ownerOf(name), a.owner);
    };

    await orphan("swept");
    const held = await acquireLease("held", { autoRenew: false });
    assert.ok(held);
    assert.equal(await sweepOrphanLeases(), 1);
    assert.equal(await exists(leaseFile("swept")), false);
    assert.equal(await held.verify(), true, "a lease a run here still holds is not an orphan");
    assert.equal(await sweepOrphanLeases(), 0);

    await orphan("taken");
    const c = await acquireLease("taken", { autoRenew: false });
    assert.ok(c, "a contender in the same process takes an orphan at once");
    assert.equal(await acquireLease("taken", { autoRenew: false }), null, "but not a held lease");
    await c.release();
    await held.release();
  });
});

test("a lease whose directory was deleted is gone: renewal, verify and release create nothing (reviewer probe m3-renew-home)", async () => {
  await withHome(async () => {
    let lost = 0;
    const a = await acquireLease("deleted", {
      ttlMs: 60_000,
      renewEveryMs: 15,
      onLost: () => lost++,
    });
    assert.ok(a);
    await vanish(tasksDir()); // the task or the home was deleted
    for (let i = 0; i < 100 && lost === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(lost, 1);
    assert.equal(a.gone, true);
    assert.equal(await a.verify(), false);
    await a.release();
    await assert.rejects(fsp.stat(tasksDir()), /ENOENT/, "nothing was re-created");

    // verify() alone reaches the same verdict.
    await fsp.mkdir(tasksDir(), { recursive: true });
    const b = await acquireLease("deleted-too", { autoRenew: false });
    assert.ok(b);
    await vanish(tasksDir());
    assert.equal(await b.verify(), false);
    assert.equal(b.gone, true);
    await b.release();
    await assert.rejects(fsp.stat(tasksDir()), /ENOENT/);
  });
});

test("a contender stalled inside the steal mutex past its staleness cannot win alongside the one that stole the mutex (reviewer probe h2-t4c-new)", async () => {
  await withHome(async () => {
    const name = "stalled-steal";
    const file = leaseFile(name);
    await plant(name, {
      owner: "dead",
      token: "t",
      pid: 2 ** 30,
      host: os.hostname(),
      started: 1,
      ts: 1,
      expiresAt: 2,
    });
    // B is descheduled at the moment it acts on the body it judged stale —
    // whichever call that is (removing it, or moving it aside).
    const stalled = deferred();
    const resume = deferred();
    const realRm = fsp.rm.bind(fsp);
    const realRename = fsp.rename.bind(fsp);
    let first = true;
    const stallOnce = async (target: unknown): Promise<void> => {
      if (first && String(target) === file) {
        first = false;
        stalled.resolve();
        await resume.promise;
      }
    };
    (fsp as { rm: typeof fsp.rm }).rm = async (target, options) => {
      await stallOnce(target);
      return realRm(target, options);
    };
    (fsp as { rename: typeof fsp.rename }).rename = async (from, to) => {
      await stallOnce(from);
      return realRename(from, to);
    };
    // B's stall outlasts the mutex's 15 s staleness: the clock jumps 20 s.
    const realNow = Date.now;
    try {
      const pB = acquireLease(name, { owner: "B", autoRenew: false });
      await stalled.promise;
      Date.now = () => realNow() + 20_000;
      const A = await acquireLease(name, { owner: "A", autoRenew: false });
      resume.resolve();
      const B = await pB;
      assert.equal([A, B].filter(Boolean).length, 1, "exactly one acquisition reports success");
      const holder = (A ?? B)!;
      assert.equal(await ownerOf(name), holder.owner);
      assert.equal(await holder.verify(), true);
      await holder.release();
    } finally {
      Date.now = realNow;
      (fsp as { rm: typeof fsp.rm }).rm = realRm;
      (fsp as { rename: typeof fsp.rename }).rename = realRename;
    }
  });
});

test("hosted edition: a holder is never judged by its pid — instances can share a hostname — only expiry frees its lease", async () => {
  await withHome(async () => {
    const realHostname = os.hostname;
    const realEdition = process.env.LISA_EDITION;
    // Every Cloud Run instance may call itself the same thing.
    (os as { hostname: () => string }).hostname = () => "localhost";
    try {
      const otherInstance = {
        owner: "instance-2",
        token: "tok",
        host: "localhost",
        started: 1,
        ts: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      // A pid that does not exist in THIS instance, and one that happens to equal ours.
      for (const [name, pid] of [
        ["task-hosted_dead", 2 ** 30],
        ["task-hosted_same", process.pid],
      ] as const) {
        await plant(name, { ...otherInstance, pid });
        assert.equal(
          await acquireLease(name, { autoRenew: false, pidLiveness: false }),
          null,
          `${name}: unexpired, so respected`,
        );
        assert.equal(await taskLeaseHeld(name.slice(5), Date.now(), { pidLiveness: false }), true);
        process.env.LISA_EDITION = "cloud"; // the hosted edition's default
        assert.equal(await acquireLease(name, { autoRenew: false }), null, `${name}: by default`);
        assert.equal(await sweepOrphanLeases(), 0, "no orphan sweep hosted");
        delete process.env.LISA_EDITION;
        // Expired: now it is stolen.
        await plant(name, { ...otherInstance, pid, expiresAt: Date.now() - 1 });
        const lease = await acquireLease(name, { autoRenew: false, pidLiveness: false });
        assert.ok(lease, `${name}: stolen on expiry`);
        await lease.release();
      }
      // The Mac edition, for contrast: a dead pid on "this host" is stolen at once.
      await plant("task-mac_dead", { ...otherInstance, pid: 2 ** 30 });
      const mac = await acquireLease("task-mac_dead", { autoRenew: false });
      assert.ok(mac);
      await mac.release();
    } finally {
      (os as { hostname: () => string }).hostname = realHostname;
      if (realEdition === undefined) delete process.env.LISA_EDITION;
      else process.env.LISA_EDITION = realEdition;
    }
  });
});

/**
 * On the `nth` read of `file`, run `meanwhile` before handing back what was
 * read — a holder that read its lease under the mutex and then stalled past
 * the mutex's staleness, while a contender took the lease.
 */
function afterRead(
  file: string,
  nth: number,
  meanwhile: () => Promise<void>,
): { fired: boolean; restore(): void } {
  const real = fsp.readFile.bind(fsp) as (...args: unknown[]) => Promise<unknown>;
  let reads = 0;
  const state = {
    fired: false,
    restore: () => {
      (fsp as Record<string, unknown>).readFile = real;
    },
  };
  (fsp as Record<string, unknown>).readFile = async (target: unknown, ...rest: unknown[]) => {
    const out = await real(target, ...rest);
    if (!state.fired && String(target) === file && ++reads === nth) {
      state.fired = true;
      state.restore();
      await meanwhile();
    }
    return out;
  };
  return state;
}

test("a late release, renewal or sweep never acts on the next holder's lease: each is compare-and-swap on the body moved aside (reviewer probe n1-release-stall)", async () => {
  for (const op of ["release", "renew", "sweep"] as const) {
    await withHome(async () => {
      const name = `late-${op}`;
      const file = leaseFile(name);
      const a = await acquireLease(name, { owner: "A", autoRenew: false });
      assert.ok(a);
      if (op === "sweep") {
        // A release that could not remove the file: an orphan of this process.
        const faults = [
          failing("rm", (p) => p === file, "EIO"),
          failing("rename", (p) => p === file, "EIO"),
        ];
        try {
          await a.release();
        } finally {
          for (const f of faults.reverse()) f.restore();
        }
      }
      // B judges A's lease stale (its mutex stolen from A's stalled call) and takes it.
      let b: Awaited<ReturnType<typeof acquireLease>> = null;
      const hook = afterRead(file, op === "sweep" ? 2 : 1, async () => {
        await fsp.rm(file);
        b = await acquireLease(name, { owner: "B", autoRenew: false });
      });
      try {
        if (op === "release") await a.release();
        if (op === "renew") assert.equal(await a.renew(), false, "not ours any more");
        if (op === "sweep") assert.equal(await sweepOrphanLeases(), 0);
      } finally {
        hook.restore();
      }
      assert.ok(hook.fired);
      const holder = b as Awaited<ReturnType<typeof acquireLease>>;
      assert.ok(holder, "B took the lease");
      assert.equal(await ownerOf(name), "B", `${op}: B's lease is still on disk`);
      assert.equal(await holder.verify(), true, `${op}: B still holds it`);
      if (op === "renew") assert.equal(a.lost, true, "the late renewal reports the lease lost");
      await holder.release();
    });
  }
});

test("a renewal never makes its own holder's verify() fail, though it moves the file aside", async () => {
  await withHome(async () => {
    let lost = 0;
    const a = await acquireLease("busy", { autoRenew: false, onLost: () => lost++ });
    assert.ok(a);
    for (let i = 0; i < 200; i++) {
      const [renewed, ...verified] = await Promise.all([
        a.renew(),
        a.verify(),
        a.verify(),
        a.verify(),
      ]);
      assert.equal(renewed, true);
      assert.deepEqual(verified, [true, true, true], `round ${i}`);
    }
    assert.equal(lost, 0);
    assert.equal(await ownerOf("busy"), a.owner);
    await a.release();
    assert.equal(await exists(leaseFile("busy")), false);
  });
});
