import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-dstatus-"));
process.env.LISA_HOME = TMP;
const LEDGER = path.join(TMP, "dispatches.json");

const { recordDispatch, dispatchLogDir } = await import("../integrations/dispatch-ledger.js");
const { dispatchStatusTool } = await import("./dispatch_status.js");

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

  test("distinguishes running vs finished and shows the output tail", async () => {
    const now = Date.now();
    withLog(process.pid, "still going...", now); // our own pid → alive → running
    withLog(DEAD_PID, "FINAL RESULT: done", now); // dead → finished
    const out = await dispatchStatusTool.execute({}, CTX);
    assert.match(out, /▶ running/);
    assert.match(out, /✓ finished/);
    assert.match(out, /FINAL RESULT: done/);
  });

  test("by id returns that one with its output", async () => {
    const e = withLog(DEAD_PID, "the answer is 42", Date.now());
    const out = await dispatchStatusTool.execute({ id: e.id }, CTX);
    assert.match(out, /✓ finished/);
    assert.match(out, /the answer is 42/);
  });

  test("unknown id → not found", async () => {
    assert.match(await dispatchStatusTool.execute({ id: "nope" }, CTX), /No dispatch found/);
  });
});
