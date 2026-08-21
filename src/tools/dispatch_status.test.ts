import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-dstatus-"));
process.env.LISA_HOME = TMP;
const LEDGER = path.join(TMP, "dispatches.json");

const { recordDispatch, recordExit, dispatchLogDir } = await import(
  "../integrations/dispatch-ledger.js"
);
const { dispatchStatusTool, statusLabel } = await import("./dispatch_status.js");

const CTX = {} as ToolContext; // execute doesn't use ctx
const DEAD_PID = 2_000_000_000;

beforeEach(() => {
  fs.rmSync(LEDGER, { force: true });
  fs.rmSync(dispatchLogDir(), { recursive: true, force: true });
});

function withLog(pid: number, content: string, now: number) {
  fs.mkdirSync(dispatchLogDir(), { recursive: true });
  const logPath = path.join(dispatchLogDir(), `t-${pid}.log`);
  fs.writeFileSync(logPath, content);
  return recordDispatch({ agent: "claude", pid, cwd: "/r", task: "do the thing", logPath, now });
}

describe("dispatch_status", () => {
  test("empty → friendly message", async () => {
    assert.match(await dispatchStatusTool.execute({}, CTX), /No dispatched agents/);
  });

  test("distinguishes running vs exited and shows the output tail", async () => {
    const now = Date.now();
    withLog(process.pid, "still going...", now); // our own pid → alive → running
    withLog(DEAD_PID, "FINAL RESULT: done", now); // dead, no exit code on record
    const out = await dispatchStatusTool.execute({}, CTX);
    assert.match(out, /▶ running/);
    // A dead pid with no observed exit status must NOT be reported as success.
    assert.match(out, /• exited \(status not captured\)/);
    assert.doesNotMatch(out, /✓ finished/);
    assert.match(out, /FINAL RESULT: done/);
  });

  test("by id returns that one with its output", async () => {
    const e = withLog(DEAD_PID, "the answer is 42", Date.now());
    const out = await dispatchStatusTool.execute({ id: e.id }, CTX);
    assert.match(out, /• exited \(status not captured\)/);
    assert.match(out, /the answer is 42/);
  });

  test("unknown id → not found", async () => {
    assert.match(await dispatchStatusTool.execute({ id: "nope" }, CTX), /No dispatch found/);
  });
});

describe("dispatch_status labels — success is only claimed when observed", () => {
  const base = { id: "1-a", agent: "claude", pid: DEAD_PID, cwd: "/r", task: "t", startedAt: 0 };

  test("a running agent", () => {
    assert.equal(statusLabel({ ...base }, true), "▶ running");
  });

  test("exit 0 is the only success", () => {
    assert.equal(statusLabel({ ...base, exitCode: 0 }, false), "✓ exit 0");
  });

  test("a nonzero exit is shown as a failure, not a checkmark", () => {
    assert.equal(statusLabel({ ...base, exitCode: 1 }, false), "✗ exit 1");
    assert.equal(statusLabel({ ...base, exitCode: 127 }, false), "✗ exit 127");
  });

  test("death by signal names the signal (OOM-kill, cancel, …)", () => {
    assert.equal(
      statusLabel({ ...base, exitCode: null, exitSignal: "SIGKILL" }, false),
      "✗ killed by SIGKILL",
    );
  });

  test("no observed status is reported as unknown — the F4 regression", () => {
    // The agent is spawned detached: if LISA exited first, nothing ever saw the
    // exit. Previously this rendered identically to a clean run.
    assert.equal(statusLabel({ ...base }, false), "• exited (status not captured)");
  });

  test("an exited entry that ran long is still judged by its recorded code", async () => {
    const e = withLog(DEAD_PID, "boom", Date.now());
    recordExit(e.id, 2, null);
    const out = await dispatchStatusTool.execute({ id: e.id }, CTX);
    assert.match(out, /✗ exit 2/);
    assert.doesNotMatch(out, /status not captured/);
  });
});
