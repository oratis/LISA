import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDispatchArgv } from "./dispatch_agent.js";

describe("buildDispatchArgv — headless invocations", () => {
  test("claude → claude -p <task>", () => {
    const { cmd, args } = buildDispatchArgv("claude", "fix the bug");
    assert.equal(cmd, "claude");
    assert.deepEqual(args, ["-p", "fix the bug"]);
  });
  test("codex → codex exec <task>", () => {
    assert.deepEqual(buildDispatchArgv("codex", "do x"), { cmd: "codex", args: ["exec", "do x"] });
  });
  test("opencode → opencode run <task>", () => {
    assert.deepEqual(buildDispatchArgv("opencode", "do x"), { cmd: "opencode", args: ["run", "do x"] });
  });
  test("aider → aider --message <task> --yes", () => {
    assert.deepEqual(buildDispatchArgv("aider", "do x"), {
      cmd: "aider",
      args: ["--message", "do x", "--yes"],
    });
  });
  test("copilot → copilot -p <task>", () => {
    assert.deepEqual(buildDispatchArgv("copilot", "do x"), { cmd: "copilot", args: ["-p", "do x"] });
  });

  test("task is a single argv element — no shell injection surface", () => {
    // A task containing shell metacharacters must NOT be split or interpreted;
    // it's one argv item passed straight to the agent.
    const evil = 'fix; rm -rf ~ && echo "$(whoami)"';
    const { args } = buildDispatchArgv("claude", evil);
    assert.equal(args[args.length - 1], evil, "task passed verbatim as one arg");
    assert.equal(args.length, 2, "no extra args injected");
  });

  test("newlines in the task survive verbatim", () => {
    const multi = "line1\nline2";
    assert.equal(buildDispatchArgv("codex", multi).args[1], multi);
  });
});

describe("launchAgent captures the exit status (F4)", () => {
  // A dispatched agent is spawned detached, so nothing used to observe how it
  // ended: a crash and a clean run both rendered as "✓ finished". Here we put
  // a fake `claude` on PATH that exits with a known code and assert the ledger
  // actually records it.
  //
  // Both timing branches matter. launchAgent waits ~150ms for a spawn error;
  // an agent that exits INSIDE that window emits "close" before the wait
  // resolves, so the listener has to be attached before it and the result
  // stashed until the ledger row exists.
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-launch-"));
  const BIN = path.join(TMP, "bin");
  process.env.LISA_HOME = path.join(TMP, "home");
  process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH ?? ""}`;

  function fakeAgent(script: string): void {
    fs.mkdirSync(BIN, { recursive: true });
    const p = path.join(BIN, "claude");
    fs.writeFileSync(p, `#!/bin/sh\n${script}\n`);
    fs.chmodSync(p, 0o755);
  }

  async function waitForExit(id: string, timeoutMs = 8000) {
    const { loadLedger } = await import("../integrations/dispatch-ledger.js");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const e = loadLedger().find((x) => x.id === id);
      if (e && (typeof e.exitCode === "number" || e.exitSignal)) return e;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test("an agent that crashes immediately still records its exit code", async () => {
    // Exits well inside the 150ms launch race — the regression this guards.
    fakeAgent('echo "boom"\nexit 3');
    const { launchAgent } = await import("./dispatch_agent.js");
    const res = await launchAgent("claude", "do a thing", TMP);
    assert.equal(res.error, undefined, `launch failed: ${res.error ?? ""}`);
    assert.ok(res.id, "expected a ledger id");
    const entry = await waitForExit(res.id as string);
    assert.ok(entry, "exit status was never recorded");
    assert.equal(entry?.exitCode, 3);
    assert.equal(entry?.exitSignal, null);
    assert.equal(typeof entry?.exitedAt, "number");
  });

  test("an agent that outlives the launch race records its exit code too", async () => {
    fakeAgent('sleep 0.4\necho "done"\nexit 0');
    const { launchAgent } = await import("./dispatch_agent.js");
    const res = await launchAgent("claude", "slower thing", TMP);
    assert.equal(res.error, undefined, `launch failed: ${res.error ?? ""}`);
    const entry = await waitForExit(res.id as string);
    assert.ok(entry, "exit status was never recorded");
    assert.equal(entry?.exitCode, 0);
  });

  test("a missing binary is still reported as a launch error, not an exit", async () => {
    const { launchAgent } = await import("./dispatch_agent.js");
    const res = await launchAgent("codex", "x", TMP); // no fake `codex` on PATH
    assert.match(res.error ?? "", /not found on PATH|Failed to launch/);
    assert.equal(res.id, undefined);
  });
});
