import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate to a throwaway LISA_HOME before importing the ledger (it reads the
// env lazily, but set it up front to be safe).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-dispatch-out-"));
process.env.LISA_HOME = TMP;
const LEDGER = path.join(TMP, "dispatches.json");

const {
  recordDispatch,
  listLiveDispatches,
  listRecentDispatches,
  readDispatchOutput,
  dispatchLogDir,
} = await import("./dispatch-ledger.js");

const DEAD_PID = 2_000_000_000;

beforeEach(() => {
  fs.rmSync(LEDGER, { force: true });
  fs.rmSync(dispatchLogDir(), { recursive: true, force: true });
});

describe("recordDispatch — logPath", () => {
  test("stores logPath when given; omits the key when not", () => {
    const a = recordDispatch({ agent: "claude", pid: process.pid, cwd: "/a", task: "t", logPath: "/x/y.log", now: 1000 });
    assert.equal(a.logPath, "/x/y.log");
    const b = recordDispatch({ agent: "codex", pid: process.pid + 1, cwd: "/b", task: "t", now: 1000 });
    assert.equal("logPath" in b, false);
  });
});

describe("retention (finished dispatches stay readable, old ones age out)", () => {
  test("a recently-finished (dead) entry is retained on disk, but not 'live'", () => {
    const now = Date.now();
    fs.writeFileSync(
      LEDGER,
      JSON.stringify([{ id: "deadrecent", agent: "claude", pid: DEAD_PID, cwd: "/a", task: "t", startedAt: now - 1000 }]),
    );
    assert.equal(listLiveDispatches().length, 0); // dead → not live
    assert.equal(listRecentDispatches().length, 1); // but kept for readback
  });

  test("a dead entry past the retention window is dropped, and its log deleted", () => {
    fs.mkdirSync(dispatchLogDir(), { recursive: true });
    const logFile = path.join(dispatchLogDir(), "old.log");
    fs.writeFileSync(logFile, "old output");
    fs.writeFileSync(
      LEDGER,
      JSON.stringify([{ id: "deadold", agent: "claude", pid: DEAD_PID, cwd: "/a", task: "t", startedAt: 2, logPath: logFile }]),
    );
    listLiveDispatches();
    assert.equal(listRecentDispatches().length, 0);
    assert.equal(fs.existsSync(logFile), false);
  });
});

describe("readDispatchOutput", () => {
  test("returns the tail of the captured log", () => {
    fs.mkdirSync(dispatchLogDir(), { recursive: true });
    const logFile = path.join(dispatchLogDir(), "x.log");
    fs.writeFileSync(logFile, "line1\nline2\nthe-end");
    const out = readDispatchOutput(
      { id: "i", agent: "claude", pid: 1, cwd: "/", task: "t", startedAt: 0, logPath: logFile },
      1000,
    );
    assert.match(out, /the-end/);
  });
  test("caps to maxBytes (tail) with an ellipsis", () => {
    fs.mkdirSync(dispatchLogDir(), { recursive: true });
    const logFile = path.join(dispatchLogDir(), "big.log");
    fs.writeFileSync(logFile, "A".repeat(100) + "TAIL");
    const out = readDispatchOutput(
      { id: "i", agent: "claude", pid: 1, cwd: "/", task: "t", startedAt: 0, logPath: logFile },
      10,
    );
    assert.match(out, /^…/);
    assert.match(out, /TAIL$/);
  });
  test("no logPath → empty string", () => {
    assert.equal(readDispatchOutput({ id: "i", agent: "claude", pid: 1, cwd: "/", task: "t", startedAt: 0 }), "");
  });
});
