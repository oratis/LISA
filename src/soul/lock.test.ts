import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "./lock.js";

let dir: string;
before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-lock-test-"));
});
after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

let n = 0;
const lockPath = () => path.join(dir, `lock-${n++}.lock`);

describe("withFileLock", () => {
  test("returns the wrapped function's value", async () => {
    const out = await withFileLock(lockPath(), async () => 42);
    assert.equal(out, 42);
  });

  test("releases the lock after success (file removed)", async () => {
    const lp = lockPath();
    await withFileLock(lp, async () => "ok");
    await assert.rejects(() => fsp.stat(lp), /ENOENT/, "lock file should be gone");
  });

  test("releases the lock after the fn throws", async () => {
    const lp = lockPath();
    await assert.rejects(() => withFileLock(lp, async () => { throw new Error("boom"); }), /boom/);
    await assert.rejects(() => fsp.stat(lp), /ENOENT/, "lock released on error too");
  });

  test("mutual exclusion: concurrent holders run serially, never interleave", async () => {
    const lp = lockPath();
    const events: string[] = [];
    async function critical(tag: string) {
      await withFileLock(lp, async () => {
        events.push(`${tag}-enter`);
        await new Promise((r) => setTimeout(r, 30));
        events.push(`${tag}-exit`);
      }, { pollMs: 5 });
    }
    await Promise.all([critical("A"), critical("B")]);
    // Whichever ran first, its enter/exit must be adjacent — no interleaving.
    const a = events.indexOf("A-enter");
    const b = events.indexOf("B-enter");
    if (a < b) {
      assert.deepEqual(events, ["A-enter", "A-exit", "B-enter", "B-exit"]);
    } else {
      assert.deepEqual(events, ["B-enter", "B-exit", "A-enter", "A-exit"]);
    }
  });

  test("times out if the lock is held and never released", async () => {
    const lp = lockPath();
    // Hold the lock with a long-running critical section. Signal once we're
    // actually INSIDE it, so the contender below can't race ahead of the
    // holder acquiring the lock (which made this flaky under parallel load).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const inside = new Promise<void>((r) => (acquired = r));
    const holder = withFileLock(lp, async () => {
      acquired();
      await held;
    }, { staleMs: 60_000 });
    await inside; // holder definitely owns the lock now

    // A second acquirer should give up after its timeout. Generous timeout so
    // CI/parallel-load jitter can't make it spuriously succeed; correctness is
    // that it rejects, not how fast.
    await assert.rejects(
      () => withFileLock(lp, async () => "never", { timeoutMs: 300, pollMs: 10, staleMs: 60_000 }),
      /timed out acquiring lock/,
    );
    release();
    await holder;
  });

  test("steals a stale lock (crashed holder)", async () => {
    const lp = lockPath();
    // Simulate a crashed holder: a lock file with an ancient timestamp + a
    // pid that's almost certainly dead.
    await fsp.writeFile(lp, JSON.stringify({ pid: 999999, ts: Date.now() - 999_999 }));
    const out = await withFileLock(lp, async () => "stolen", { staleMs: 1000, timeoutMs: 1000 });
    assert.equal(out, "stolen", "should steal the stale lock and run");
  });

  test("steals a malformed lock file", async () => {
    const lp = lockPath();
    await fsp.writeFile(lp, "{ not json");
    const out = await withFileLock(lp, async () => "recovered", { timeoutMs: 1000 });
    assert.equal(out, "recovered");
  });
});
