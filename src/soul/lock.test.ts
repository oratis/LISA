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

  test("mutual exclusion: concurrent holders never overlap (structural)", async () => {
    const lp = lockPath();
    // Prove mutual exclusion by STRUCTURE, not by timing margins, so the test
    // can't flake on a slow/loaded runner:
    //   1. A live counter of holders currently inside the critical section. A
    //      correct lock keeps it at exactly 1; a broken lock that lets two in
    //      pushes it to 2 and trips the assertion immediately — regardless of
    //      how long anyone sleeps or how loaded the machine is.
    //   2. An enter/exit event log that must be strictly paired: every holder's
    //      "-enter" is immediately followed by its own "-exit", never another
    //      holder's marker.
    // The short sleep below only creates a yield point where a *broken* lock
    // could interleave; the assertions never depend on its duration.
    let inside = 0;
    let maxInside = 0;
    const events: string[] = [];
    async function critical(tag: string) {
      await withFileLock(lp, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        assert.equal(inside, 1, `holder ${tag} entered while another holder was inside the lock`);
        events.push(`${tag}-enter`);
        await new Promise((r) => setTimeout(r, 5)); // yield: a broken lock would interleave here
        events.push(`${tag}-exit`);
        inside--;
      }, { pollMs: 1 });
    }
    // Several real contenders (not just two) — more contention, stronger proof.
    const tags = ["A", "B", "C", "D", "E"];
    await Promise.all(tags.map(critical));

    assert.equal(maxInside, 1, "at most one holder may be inside the lock at any instant");
    // Strict pairing: enter_i immediately followed by that same holder's exit_i.
    assert.equal(events.length, tags.length * 2, "every holder enters and exits exactly once");
    for (let i = 0; i < events.length; i += 2) {
      const enter = events[i];
      assert.ok(enter.endsWith("-enter"), `expected an enter marker at index ${i}, got "${enter}"`);
      const tag = enter.slice(0, -"-enter".length);
      assert.equal(
        events[i + 1],
        `${tag}-exit`,
        `holder ${tag}'s enter must be immediately followed by its own exit (no interleaving)`,
      );
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
