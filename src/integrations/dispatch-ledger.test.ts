import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the ledger to a throwaway dir. dispatch-ledger reads lisaHome()
// lazily (at call time), so setting it here — before any function runs — is
// enough; this test file runs in its own process.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-ledger-"));
process.env.LISA_HOME = TMP;
const LEDGER = path.join(TMP, "dispatches.json");

const {
  recordDispatch,
  loadLedger,
  listLiveDispatches,
  findDispatch,
  removeDispatch,
  isAlive,
  entryIsAlive,
  processStartToken,
  recordExit,
  toDispatchView,
} = await import("./dispatch-ledger.js");

/** A pid that is essentially never a running process. */
const DEAD_PID = 2_000_000_000;

beforeEach(() => {
  fs.rmSync(LEDGER, { force: true });
});

describe("isAlive", () => {
  test("our own pid is alive", () => {
    assert.equal(isAlive(process.pid), true);
  });
  test("a bogus high pid is dead", () => {
    assert.equal(isAlive(DEAD_PID), false);
  });
  test("pid <= 1 is treated as not-ours / dead", () => {
    assert.equal(isAlive(1), false);
    assert.equal(isAlive(0), false);
    assert.equal(isAlive(-5), false);
  });
});

describe("recordDispatch / loadLedger", () => {
  test("round-trips an entry with a deterministic id", () => {
    const e = recordDispatch({
      agent: "codex",
      pid: process.pid,
      cwd: "/tmp/x",
      task: "fix the thing",
      now: 1000,
    });
    assert.equal(e.id, `${process.pid}-${(1000).toString(36)}`);
    assert.equal(e.agent, "codex");
    const all = loadLedger();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], e);
  });

  test("task is truncated to 200 chars", () => {
    const e = recordDispatch({
      agent: "claude",
      pid: process.pid,
      cwd: "/x",
      task: "z".repeat(500),
    });
    assert.equal(e.task.length, 200);
  });

  test("re-recording the same pid replaces the stale entry (recycled pid)", () => {
    recordDispatch({ agent: "claude", pid: process.pid, cwd: "/a", task: "first", now: 1 });
    recordDispatch({ agent: "codex", pid: process.pid, cwd: "/b", task: "second", now: 2 });
    const all = loadLedger();
    assert.equal(all.length, 1);
    assert.equal(all[0].agent, "codex");
    assert.equal(all[0].cwd, "/b");
  });

  test("missing file → empty ledger", () => {
    assert.deepEqual(loadLedger(), []);
  });

  test("corrupt JSON → empty ledger (no throw)", () => {
    fs.writeFileSync(LEDGER, "{not json");
    assert.deepEqual(loadLedger(), []);
  });
});

describe("listLiveDispatches", () => {
  test("prunes dead entries and rewrites the file", () => {
    // One live (our pid), one dead — written straight to disk.
    fs.writeFileSync(
      LEDGER,
      JSON.stringify([
        { id: "live", agent: "claude", pid: process.pid, cwd: "/a", task: "t", startedAt: 1 },
        { id: "dead", agent: "codex", pid: DEAD_PID, cwd: "/b", task: "t", startedAt: 2 },
      ]),
    );
    const live = listLiveDispatches();
    assert.equal(live.length, 1);
    assert.equal(live[0].id, "live");
    // The dead one was pruned from disk too.
    assert.equal(loadLedger().length, 1);
  });
});

describe("findDispatch / removeDispatch", () => {
  test("finds a live entry by id and by pid string", () => {
    const e = recordDispatch({ agent: "claude", pid: process.pid, cwd: "/a", task: "t" });
    assert.equal(findDispatch(e.id)?.id, e.id);
    assert.equal(findDispatch(String(process.pid))?.id, e.id);
    assert.equal(findDispatch("nope"), null);
  });

  test("removeDispatch drops the entry", () => {
    const e = recordDispatch({ agent: "claude", pid: process.pid, cwd: "/a", task: "t" });
    removeDispatch(e.id);
    assert.deepEqual(loadLedger(), []);
  });
});

describe("toDispatchView", () => {
  test("maps a ledger entry to a structural, ISO-timestamped view", () => {
    const view = toDispatchView(
      { id: "48213-x", agent: "claude", pid: 48213, cwd: "/p", task: "t", startedAt: 0, logPath: "/l.log" },
      true,
    );
    assert.deepEqual(view, {
      id: "48213-x",
      agent: "claude",
      pid: 48213,
      cwd: "/p",
      task: "t",
      startedAt: "1970-01-01T00:00:00.000Z",
      alive: true,
      hasLog: true,
    });
  });
  test("hasLog false when no logPath; alive reflects the arg (no raw path leaks)", () => {
    const view = toDispatchView(
      { id: "1-y", agent: "codex", pid: 1, cwd: "/q", task: "u", startedAt: 0 },
      false,
    );
    assert.equal(view.hasLog, false);
    assert.equal(view.alive, false);
    assert.equal("logPath" in view, false);
  });
});

describe("pid reuse guard (start-time fingerprint)", () => {
  test("a live pid has a readable start token", () => {
    const tok = processStartToken(process.pid);
    assert.equal(typeof tok, "string");
    assert.ok((tok as string).length > 0);
  });

  test("the token is stable across reads for the same process", () => {
    assert.equal(processStartToken(process.pid), processStartToken(process.pid));
  });

  test("no token for a dead pid or pid <= 1", () => {
    assert.equal(processStartToken(DEAD_PID), null);
    assert.equal(processStartToken(1), null);
    assert.equal(processStartToken(0), null);
  });

  test("a live pid whose start token does NOT match is reported dead", () => {
    // This is the pid-reuse case: the pid exists, but it is a different
    // process than the one we dispatched. Without this, signal_agent would
    // SIGTERM/SIGKILL the whole process group of an unrelated process.
    assert.equal(isAlive(process.pid), true);
    assert.equal(isAlive(process.pid, "ps:not-the-process-we-launched"), false);
  });

  test("a matching token still reports alive", () => {
    const tok = processStartToken(process.pid) as string;
    assert.equal(isAlive(process.pid, tok), true);
  });

  test("recordDispatch captures the token, and entryIsAlive honours it", () => {
    const e = recordDispatch({ agent: "claude", pid: process.pid, cwd: "/a", task: "t" });
    assert.equal(typeof e.startToken, "string");
    assert.equal(entryIsAlive(e), true);
    assert.equal(entryIsAlive({ ...e, startToken: "ps:someone-else" }), false);
  });

  test("entries without a token keep the old pid-only behavior", () => {
    // Ledger files written before this field existed must not vanish.
    const e = recordDispatch({
      agent: "codex",
      pid: process.pid,
      cwd: "/a",
      task: "t",
      startToken: null,
    });
    assert.equal("startToken" in e, false);
    assert.equal(entryIsAlive(e), true);
  });
});

describe("recordExit", () => {
  test("records a clean exit", () => {
    const e = recordDispatch({ agent: "claude", pid: DEAD_PID, cwd: "/a", task: "t", now: 5 });
    recordExit(e.id, 0, null, 99);
    const stored = loadLedger().find((x) => x.id === e.id);
    assert.equal(stored?.exitCode, 0);
    assert.equal(stored?.exitSignal, null);
    assert.equal(stored?.exitedAt, 99);
  });

  test("records a nonzero exit — the crash case F4 was about", () => {
    const e = recordDispatch({ agent: "codex", pid: DEAD_PID, cwd: "/a", task: "t", now: 5 });
    recordExit(e.id, 1, null);
    assert.equal(loadLedger().find((x) => x.id === e.id)?.exitCode, 1);
  });

  test("records death by signal", () => {
    const e = recordDispatch({ agent: "aider", pid: DEAD_PID, cwd: "/a", task: "t", now: 5 });
    recordExit(e.id, null, "SIGKILL");
    const stored = loadLedger().find((x) => x.id === e.id);
    assert.equal(stored?.exitCode, null);
    assert.equal(stored?.exitSignal, "SIGKILL");
  });

  test("a fresh entry has no exit status — undefined, not 0", () => {
    const e = recordDispatch({ agent: "claude", pid: DEAD_PID, cwd: "/a", task: "t", now: 5 });
    assert.equal(e.exitCode, undefined);
    assert.equal(loadLedger().find((x) => x.id === e.id)?.exitCode, undefined);
  });

  test("an unknown id is a silent no-op (entry already aged out)", () => {
    recordDispatch({ agent: "claude", pid: DEAD_PID, cwd: "/a", task: "t", now: 5 });
    assert.doesNotThrow(() => recordExit("no-such-id", 0, null));
    assert.equal(loadLedger().length, 1);
  });
});
