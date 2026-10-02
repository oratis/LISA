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
    return await homeScope.run(home, fn);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
}

const leaseFile = (name: string) => path.join(tasksDir(), ".leases", `${name}.lease`);

test("a held lease cannot be taken again until it is released", async () => {
  await withHome(async () => {
    const a = await acquireTaskLease("t_0123456789ab", { autoRenew: false });
    assert.ok(a);
    assert.equal(await acquireTaskLease("t_0123456789ab", { autoRenew: false }), null);
    // A different task is unaffected.
    const other = await acquireTaskLease("t_ba9876543210", { autoRenew: false });
    assert.ok(other);
    await a.release();
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

test("an expired lease is stolen, and the old holder cannot renew or release it", async () => {
  await withHome(async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const a = await acquireLease("expiring", { ttlMs: 1000, autoRenew: false, now });
    assert.ok(a);
    clock += 500;
    assert.equal(await acquireLease("expiring", { ttlMs: 1000, autoRenew: false, now }), null);
    assert.equal(await a.renew(), true); // expiry is now clock + 1000
    clock += 900;
    assert.equal(await acquireLease("expiring", { ttlMs: 1000, autoRenew: false, now }), null);
    clock += 200;
    const b = await acquireLease("expiring", { ttlMs: 1000, autoRenew: false, now });
    assert.ok(b);
    assert.equal(await a.renew(), false);
    await a.release(); // must not delete b's lease
    assert.equal(await acquireLease("expiring", { ttlMs: 1000, autoRenew: false, now }), null);
    await b.release();
  });
});

test("a lease whose holder process is dead is stolen immediately", async () => {
  await withHome(async () => {
    await fsp.mkdir(path.dirname(leaseFile("orphan")), { recursive: true });
    await fsp.writeFile(
      leaseFile("orphan"),
      JSON.stringify({
        owner: "dead",
        // No process has this pid (above the kernel's pid ceiling on every supported OS).
        pid: 2 ** 30,
        host: os.hostname(),
        ts: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    const lease = await acquireLease("orphan", { autoRenew: false });
    assert.ok(lease);
    await lease.release();
  });
});

test("a live holder on another host is respected until expiry", async () => {
  await withHome(async () => {
    await fsp.mkdir(path.dirname(leaseFile("remote")), { recursive: true });
    await fsp.writeFile(
      leaseFile("remote"),
      JSON.stringify({
        owner: "peer",
        pid: 2 ** 30,
        host: "some-other-host",
        ts: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    assert.equal(await acquireLease("remote", { autoRenew: false }), null);
  });
});

test("a malformed lease file is treated as abandoned", async () => {
  await withHome(async () => {
    await fsp.mkdir(path.dirname(leaseFile("garbled")), { recursive: true });
    await fsp.writeFile(leaseFile("garbled"), "{ half a lea");
    const lease = await acquireLease("garbled", { autoRenew: false });
    assert.ok(lease);
    await lease.release();
  });
});

test("lease names are path-safe", async () => {
  await withHome(async () => {
    await assert.rejects(acquireLease("../../etc/passwd"), /invalid lease name/);
  });
});
