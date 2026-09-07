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

/**
 * The start-token scheme this platform emits ("ps1" on macOS/BSD, "lt1" on
 * Linux). Tokens are only comparable within a scheme, so a test that wants a
 * *mismatching* token has to build it on the same prefix — a literal from
 * another scheme reads as "cannot tell" and falls open by design.
 */
function scheme(): string {
  const tok = processStartToken(process.pid);
  assert.ok(tok, "the platform probe must work for our own pid");
  return tok.slice(0, tok.indexOf(":"));
}

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
      status: "running",
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
    //
    // The scheme prefix is derived, not hardcoded: tokens only compare within
    // one scheme, and the scheme differs by platform ("ps1:" on macOS/BSD,
    // "lt1:" on Linux). A hardcoded "ps:" was both retired and wrong on Linux.
    assert.equal(isAlive(process.pid), true);
    assert.equal(isAlive(process.pid, `${scheme()}:not-the-process-we-launched`), false);
  });

  test("a matching token still reports alive", () => {
    const tok = processStartToken(process.pid) as string;
    assert.equal(isAlive(process.pid, tok), true);
  });

  test("recordDispatch captures the token, and entryIsAlive honours it", () => {
    const e = recordDispatch({ agent: "claude", pid: process.pid, cwd: "/a", task: "t" });
    assert.equal(typeof e.startToken, "string");
    assert.equal(entryIsAlive(e), true);
    assert.equal(entryIsAlive({ ...e, startToken: `${scheme()}:someone-else` }), false);
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

  // A recorded exit is definitive. process.pid is genuinely alive and its
  // startToken genuinely matches, so every one of these assertions inverts if
  // entryIsAlive goes back to asking the OS about a pid we already watched die
  // — which is what made a finished dispatch render "▶ running", and what let
  // signal_agent target a pid the OS had since handed to someone else.
  test("an observed exit wins over the pid probe, even for a live pid", () => {
    const e = recordDispatch({ agent: "claude", pid: process.pid, cwd: "/a", task: "t", now: Date.now() });
    assert.equal(entryIsAlive(e), true, "alive before the exit is recorded");

    recordExit(e.id, 3, null);
    const stored = loadLedger().find((x) => x.id === e.id);
    assert.ok(stored);
    assert.equal(stored.exitCode, 3);
    assert.equal(entryIsAlive(stored), false, "a recorded exit means dead, whatever the pid says");
    assert.equal(findDispatch(e.id), null);
    assert.equal(listLiveDispatches().some((x) => x.id === e.id), false);
    assert.equal(toDispatchView(stored, entryIsAlive(stored)).alive, false);
  });

  test("death by signal counts as an exit too (exitCode is null there)", () => {
    const e = recordDispatch({ agent: "codex", pid: process.pid, cwd: "/a", task: "t", now: Date.now() });
    recordExit(e.id, null, "SIGKILL");
    const stored = loadLedger().find((x) => x.id === e.id);
    assert.ok(stored);
    assert.equal(stored.exitCode, null);
    assert.equal(entryIsAlive(stored), false, "gate on exitedAt, not on a truthy exitCode");
  });

  test("an entry with no recorded exit still falls through to the pid probe", () => {
    const live = recordDispatch({ agent: "claude", pid: process.pid, cwd: "/a", task: "t", now: Date.now() });
    const dead = recordDispatch({ agent: "claude", pid: DEAD_PID, cwd: "/b", task: "t", now: Date.now() });
    assert.equal(entryIsAlive(live), true);
    assert.equal(entryIsAlive(dead), false);
  });
});

describe("startToken is a stable identity, not a rendering of the local clock", () => {
  // `ps -o lstart=` prints in the CALLER's locale and timezone. Measured on
  // macOS for one unchanged pid: TZ alone moved the hour (13:23:46 UTC,
  // 22:23:46 Asia/Tokyo, 09:23:46 America/New_York) and LC_ALL reshaped the
  // whole string ("Mo.  7 Sep." de_DE, "\u4e00  9\u6708/ 7" zh_CN). A `lisa serve`
  // under launchd and a `lisa` CLI from a configured login shell therefore
  // disagreed about every token, so isAlive() called every running dispatch
  // dead and signal_agent deleted the ledger row instead of signalling —
  // leaving a runaway agent permanently uncancellable.
  //
  // Revert the env pin in processStartToken() and this goes red on any host
  // whose local timezone is not UTC.
  test("the token does not move when the caller's TZ/locale does", () => {
    const saved = { tz: process.env.TZ, lc: process.env.LC_ALL, lang: process.env.LANG };
    try {
      process.env.TZ = "UTC";
      process.env.LC_ALL = "C";
      process.env.LANG = "C";
      const a = processStartToken(process.pid);
      process.env.TZ = "Asia/Tokyo";
      process.env.LC_ALL = "de_DE.UTF-8";
      process.env.LANG = "de_DE.UTF-8";
      const b = processStartToken(process.pid);
      process.env.TZ = "America/New_York";
      const c = processStartToken(process.pid);
      assert.ok(a, "probe should succeed for our own pid");
      assert.equal(a, b, "TZ/locale must not change the identity of one process");
      assert.equal(a, c, "TZ must not change the identity of one process");
    } finally {
      if (saved.tz === undefined) delete process.env.TZ; else process.env.TZ = saved.tz;
      if (saved.lc === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = saved.lc;
      if (saved.lang === undefined) delete process.env.LANG; else process.env.LANG = saved.lang;
    }
  });

  test("a token from a retired scheme means 'cannot tell', not 'mismatch'", () => {
    // Entries written before the env pin carry a `ps:`/`lt:` token rendered in
    // whatever locale the writer had. Comparing one against a freshly-pinned
    // token is guaranteed to differ, so a scheme-blind comparison would report
    // every pre-upgrade dispatch dead. Different scheme => fall open, the same
    // path a failed probe already takes.
    assert.equal(isAlive(process.pid, "ps:Mon Sep  7 21:23:33 2026"), true);
    assert.equal(isAlive(process.pid, "lt:99999"), true);
  });

  test("a same-scheme mismatch still means the pid was recycled", () => {
    const current = processStartToken(process.pid);
    assert.ok(current, "probe should succeed for our own pid");
    const scheme = current.slice(0, current.indexOf(":"));
    assert.equal(isAlive(process.pid, `${scheme}:definitely-not-the-real-value`), false);
    assert.equal(isAlive(process.pid, current), true);
  });
});

describe("toDispatchView carries the exit status, not just aliveness", () => {
  // The exit status this PR teaches the ledger to record reached exactly one
  // of three surfaces. /api/dispatch/list and /api/dispatch/status hand
  // clients a DispatchView, and it had no exit fields at all — so the web
  // dashboard rendered `exit 127` as a green "Done" and the iOS ledger as
  // "Alive: no", both indistinguishable from a clean finish.
  test("a clean exit is ok, a non-zero exit is failed", () => {
    const e = recordDispatch({ agent: "claude", pid: DEAD_PID, cwd: "/a", task: "t", now: 5 });
    recordExit(e.id, 0, null);
    const ok = loadLedger().find((x) => x.id === e.id);
    assert.ok(ok);
    assert.equal(toDispatchView(ok, false).status, "ok");
    assert.equal(toDispatchView(ok, false).exitCode, 0);

    recordExit(e.id, 127, null);
    const bad = loadLedger().find((x) => x.id === e.id);
    assert.ok(bad);
    assert.equal(toDispatchView(bad, false).status, "failed");
    assert.equal(toDispatchView(bad, false).exitCode, 127);
  });

  test("death by signal is failed", () => {
    const e = recordDispatch({ agent: "codex", pid: DEAD_PID, cwd: "/a", task: "t", now: 5 });
    recordExit(e.id, null, "SIGKILL");
    const stored = loadLedger().find((x) => x.id === e.id);
    assert.ok(stored);
    const v = toDispatchView(stored, false);
    assert.equal(v.status, "failed");
    assert.equal(v.exitSignal, "SIGKILL");
  });

  test("an unobserved exit is 'unknown' — never rendered as success", () => {
    const e = recordDispatch({ agent: "aider", pid: DEAD_PID, cwd: "/a", task: "t", now: 5 });
    const v = toDispatchView(e, false);
    assert.equal(v.status, "unknown", "no observed exit is not the same as a clean one");
    assert.equal(v.exitCode, undefined);
  });

  test("a live entry is running", () => {
    const e = recordDispatch({ agent: "claude", pid: process.pid, cwd: "/a", task: "t", now: Date.now() });
    assert.equal(toDispatchView(e, true).status, "running");
  });
});

describe("the ledger is written atomically", () => {
  // A bare writeFileSync truncates before it writes, so a concurrent reader
  // sees an empty file and loadLedger()'s catch silently returns [] — every
  // live dispatch lost. recordExit() widened that window by adding a second
  // read-modify-write from an async listener.
  test("no temp file survives a write", () => {
    recordDispatch({ agent: "claude", pid: DEAD_PID, cwd: "/a", task: "t", now: 5 });
    const leftovers = fs.readdirSync(TMP).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "tmp files must be renamed into place, not left behind");
  });

  test("the ledger file is never observed truncated", () => {
    for (let i = 0; i < 20; i++) {
      recordDispatch({ agent: "claude", pid: DEAD_PID - i, cwd: "/a", task: "t", now: 5 + i });
      const raw = fs.readFileSync(LEDGER, "utf8");
      assert.doesNotThrow(() => JSON.parse(raw), "a reader must never see a half-written ledger");
    }
  });
});
