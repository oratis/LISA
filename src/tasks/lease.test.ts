import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { homeScope } from "../paths.js";
import { acquireLease, acquireTaskLease } from "./lease.js";
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
    const a = await acquireLease("renewing", {
      ttlMs: 60_000,
      renewEveryMs: 15,
      onLost: () => lost++,
    });
    assert.ok(a);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(lost, 0, "healthy renewals");
    await fsp.rm(leaseFile("renewing"));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(lost, 1);
    assert.equal(a.lost, true);
    assert.equal(await a.verify(), false);
    await a.release();

    // An erroring renewal (the lease directory is gone): also lost.
    let lost2 = 0;
    const b = await acquireLease("erroring", {
      ttlMs: 60_000,
      renewEveryMs: 15,
      onLost: () => lost2++,
    });
    assert.ok(b);
    await fsp.rm(path.dirname(leaseFile("erroring")), { recursive: true, force: true });
    await fsp.writeFile(path.dirname(leaseFile("erroring")), "not a directory");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(lost2, 1);
    await b.release();
    await fsp.rm(path.dirname(leaseFile("erroring")), { force: true });
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
