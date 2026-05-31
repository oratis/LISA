import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ToolContext } from "../types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-signal-"));
process.env.LISA_HOME = TMP;
const LEDGER = path.join(TMP, "dispatches.json");

const { signalAgentTool, formatUptime, formatDispatchLine } = await import("./signal_agent.js");
const { recordDispatch, loadLedger, isAlive } = await import(
  "../integrations/dispatch-ledger.js"
);

function ctx(): ToolContext {
  return { cwd: TMP, signal: new AbortController().signal, log: () => {} };
}

beforeEach(() => {
  fs.rmSync(LEDGER, { force: true });
});

describe("formatUptime", () => {
  test("seconds / minutes / hours", () => {
    assert.equal(formatUptime(8_000), "8s");
    assert.equal(formatUptime(3 * 60_000), "3m");
    assert.equal(formatUptime((2 * 60 + 5) * 60_000), "2h 5m");
    assert.equal(formatUptime(-100), "0s");
  });
});

describe("formatDispatchLine", () => {
  test("renders id, agent, pid, cwd and a truncated task", () => {
    const line = formatDispatchLine(
      { id: "abc", agent: "codex", pid: 1234, cwd: "/proj", task: "do a thing", startedAt: 0 },
      8_000,
    );
    assert.match(line, /abc/);
    assert.match(line, /codex/);
    assert.match(line, /pid 1234/);
    assert.match(line, /\/proj/);
    assert.match(line, /do a thing/);
  });
});

describe("signal_agent — list", () => {
  test("empty ledger reports nothing running", async () => {
    const out = await signalAgentTool.execute({ action: "list" }, ctx());
    assert.match(out, /No agents dispatched by LISA/i);
  });

  test("lists a live dispatched agent", async () => {
    recordDispatch({ agent: "claude", pid: process.pid, cwd: "/here", task: "build it" });
    const out = await signalAgentTool.execute({ action: "list" }, ctx());
    assert.match(out, /1 dispatched agent running/);
    assert.match(out, /claude/);
    assert.match(out, /build it/);
  });
});

describe("signal_agent — cancel guards", () => {
  test("cancel without a target asks for one", async () => {
    const out = await signalAgentTool.execute({ action: "cancel" }, ctx());
    assert.match(out, /needs a target/i);
  });

  test("cancel of an unknown target explains and lists what's running", async () => {
    const out = await signalAgentTool.execute(
      { action: "cancel", target: "ghost" },
      ctx(),
    );
    assert.match(out, /No running dispatched agent matches/i);
  });
});

describe("signal_agent — cancel actually kills the process", () => {
  test("force-cancel terminates a dispatched process and clears the ledger", { timeout: 10_000 }, async () => {
    // A real, long-lived child as its own process-group leader (detached),
    // mirroring how dispatch_agent spawns agents. NOTE: we deliberately do NOT
    // unref() it — the live handle keeps the event loop alive until the 'exit'
    // event fires, so the runner can't drain and cancel this test mid-await
    // (which is racy in CI). libuv reaps the child on exit.
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    assert.ok(typeof child.pid === "number", "spawned with a pid");
    const pid = child.pid;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const entry = recordDispatch({ agent: "claude", pid, cwd: TMP, task: "long-running" });
    assert.equal(isAlive(pid), true);

    try {
      const out = await signalAgentTool.execute(
        { action: "cancel", target: entry.id, force: true },
        ctx(),
      );
      assert.match(out, /Cancelled/);

      await exited; // resolves once the SIGKILL'd child dies and is reaped
      assert.equal(
        loadLedger().find((e) => e.id === entry.id),
        undefined,
        "entry removed from ledger after cancel",
      );
    } finally {
      // Safety net: if the cancel path failed, don't leave a stray process.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
});
