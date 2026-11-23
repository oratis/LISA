import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-cwd-lock-test-"));
process.env.LISA_HOME = path.join(TMP, "home");

const { acquireCwdLock, releaseCwdLock, listActiveCwdLocks, updateCwdLock, resolveCwdRealpath } =
  await import("./cwd-lock.js");

beforeEach(() => {
  fs.rmSync(path.join(TMP, "home"), { recursive: true, force: true });
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("cwd-lock", () => {
  test("prevents concurrent exclusive acquisition on the same resolved realpath (including symlinks)", () => {
    const repo = path.join(TMP, "repo-real");
    const link = path.join(TMP, "repo-link");
    fs.mkdirSync(repo, { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(repo, link);

    assert.equal(resolveCwdRealpath(link), resolveCwdRealpath(repo));

    const first = acquireCwdLock({ cwd: repo, agent: "claude" });
    assert.equal(first.acquired, true);
    assert.equal(first.bypassed, false);
    assert.ok(first.lock);

    const active = listActiveCwdLocks();
    assert.equal(active.length, 1);
    assert.equal(active[0]!.agent, "claude");
    assert.equal(active[0]!.cwd, resolveCwdRealpath(repo));

    const second = acquireCwdLock({ cwd: link, agent: "codex" });
    assert.equal(second.acquired, false);
    assert.equal(second.holder.token, first.lock.token);
    assert.match(second.reason, /claude/);

    // Wrong token cannot release another holder's lock.
    assert.equal(releaseCwdLock(link, { token: "wrong-token" }), false);
    assert.equal(listActiveCwdLocks().length, 1);

    // Owner token releases cleanly, allowing the next run.
    assert.equal(releaseCwdLock(first.lock), true);
    assert.deepEqual(listActiveCwdLocks(), []);

    const third = acquireCwdLock({ cwd: link, agent: "codex" });
    assert.equal(third.acquired, true);
    assert.equal(third.bypassed, false);
    if (third.lock) releaseCwdLock(third.lock);
  });

  test("allows worktree and readOnly runs without blocking or taking an exclusive lock", () => {
    const repo = path.join(TMP, "repo-bypass");
    fs.mkdirSync(repo, { recursive: true });

    const exclusive = acquireCwdLock({ cwd: repo, agent: "claude" });
    assert.equal(exclusive.acquired, true);

    const wt = acquireCwdLock({ cwd: repo, agent: "codex", worktree: true });
    assert.equal(wt.acquired, true);
    assert.equal(wt.bypassed, true);
    if (wt.bypassed) assert.equal(wt.reason, "worktree");

    const ro = acquireCwdLock({ cwd: repo, agent: "gemini", readOnly: true });
    assert.equal(ro.acquired, true);
    assert.equal(ro.bypassed, true);
    if (ro.bypassed) assert.equal(ro.reason, "read-only");

    assert.equal(listActiveCwdLocks().length, 1);
    if (exclusive.lock) releaseCwdLock(exclusive.lock);
  });

  test("reclaims dead-PID and stale locks automatically", () => {
    const repo = path.join(TMP, "repo-stale");
    fs.mkdirSync(repo, { recursive: true });

    const dead = acquireCwdLock({
      cwd: repo,
      agent: "cursor",
      pid: 2_000_000_000,
      startToken: null,
    });
    assert.equal(dead.acquired, true);

    // Dead PID is automatically pruned by listActiveCwdLocks and reclaimed by acquireCwdLock.
    const next = acquireCwdLock({ cwd: repo, agent: "gemini" });
    assert.equal(next.acquired, true);
    assert.equal(next.bypassed, false);
    if (next.lock) {
      const updated = updateCwdLock(next.lock, { dispatchId: "disp-42" });
      assert.equal(updated?.dispatchId, "disp-42");
      releaseCwdLock(next.lock);
    }

    // Age-based staleness also reclaims even if pid is alive.
    const old = acquireCwdLock({
      cwd: repo,
      agent: "claude",
      now: 1000,
    });
    assert.equal(old.acquired, true);
    assert.deepEqual(listActiveCwdLocks({ now: 1000 + 60_000, staleMs: 10_000 }), []);
  });
});
