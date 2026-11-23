import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../types.js";
import { buildDispatchArgv, resolveDispatchBinary } from "./dispatch_agent.js";

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
    assert.deepEqual(buildDispatchArgv("opencode", "do x"), {
      cmd: "opencode",
      args: ["run", "do x"],
    });
  });
  test("aider → aider --message <task> --yes", () => {
    assert.deepEqual(buildDispatchArgv("aider", "do x"), {
      cmd: "aider",
      args: ["--message", "do x", "--yes"],
    });
  });
  test("copilot → copilot -p <task>", () => {
    assert.deepEqual(buildDispatchArgv("copilot", "do x"), {
      cmd: "copilot",
      args: ["-p", "do x"],
    });
  });
  test("cursor → agent -p <task> (respecting LISA_CURSOR_CMD)", () => {
    assert.deepEqual(buildDispatchArgv("cursor", "do x", {}), {
      cmd: "agent",
      args: ["-p", "do x"],
    });
    assert.deepEqual(buildDispatchArgv("cursor", "do x", { LISA_CURSOR_CMD: "cursor-agent" }), {
      cmd: "cursor-agent",
      args: ["-p", "do x"],
    });
  });
  test("gemini → gemini -p <task> (respecting LISA_GEMINI_CLI_CMD)", () => {
    assert.deepEqual(buildDispatchArgv("gemini", "do x", {}), {
      cmd: "gemini",
      args: ["-p", "do x"],
    });
    assert.deepEqual(
      buildDispatchArgv("gemini", "do x", { LISA_GEMINI_CLI_CMD: "/opt/bin/gemini-cli" }),
      { cmd: "/opt/bin/gemini-cli", args: ["-p", "do x"] },
    );
  });

  test("task is a single argv element — no shell injection surface", () => {
    // A task containing shell metacharacters must NOT be split or interpreted;
    // it's one argv item passed straight to the agent.
    const evil = 'fix; rm -rf ~ && echo "$(whoami)"';
    for (const agent of ["claude", "cursor", "gemini"] as const) {
      const { args } = buildDispatchArgv(agent, evil, {});
      assert.equal(args[args.length - 1], evil, `${agent}: task passed verbatim as one arg`);
      assert.equal(args.length, 2, `${agent}: no extra args injected`);
    }
  });

  test("newlines in the task survive verbatim", () => {
    const multi = "line1\nline2";
    assert.equal(buildDispatchArgv("codex", multi).args[1], multi);
    assert.equal(buildDispatchArgv("cursor", multi, {}).args[1], multi);
    assert.equal(buildDispatchArgv("gemini", multi, {}).args[1], multi);
  });
});

describe("resolveDispatchBinary — Cursor CLI & Gemini CLI binary resolution", () => {
  test("cursor resolves agent, falls back to cursor-agent, honours LISA_CURSOR_CMD, and rejects relative overrides", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-cursor-bin-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      const cursorAgent = path.join(bin, "cursor-agent");
      fs.writeFileSync(cursorAgent, "#!/bin/sh\necho ca\n", { mode: 0o755 });

      // Fallback to cursor-agent when `agent` is absent
      const r1 = resolveDispatchBinary("cursor", { PATH: bin });
      assert.equal(r1.ok, true);
      if (r1.ok) assert.equal(r1.cmd, cursorAgent);

      // `agent` wins when present
      const agentBin = path.join(bin, "agent");
      fs.writeFileSync(agentBin, "#!/bin/sh\necho agent\n", { mode: 0o755 });
      const r2 = resolveDispatchBinary("cursor", { PATH: bin });
      assert.equal(r2.ok, true);
      if (r2.ok) assert.equal(r2.cmd, agentBin);

      // LISA_CURSOR_CMD explicit override
      const custom = path.join(tmp, "custom cursor");
      fs.writeFileSync(custom, "#!/bin/sh\necho custom\n", { mode: 0o755 });
      const r3 = resolveDispatchBinary("cursor", { PATH: bin, LISA_CURSOR_CMD: custom });
      assert.equal(r3.ok, true);
      if (r3.ok) assert.equal(r3.cmd, custom);

      // Relative override is rejected (never executes repo-planted relative path)
      const rBad = resolveDispatchBinary("cursor", { PATH: bin, LISA_CURSOR_CMD: "bin/agent" });
      assert.equal(rBad.ok, false);
      if (!rBad.ok) assert.match(rBad.error, /No executable found/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("gemini resolves gemini on PATH, honours LISA_GEMINI_CLI_CMD, and rejects relative overrides", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-gemini-bin-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      const gemBin = path.join(bin, "gemini");
      fs.writeFileSync(gemBin, "#!/bin/sh\necho gemini\n", { mode: 0o755 });

      const r1 = resolveDispatchBinary("gemini", { PATH: bin });
      assert.equal(r1.ok, true);
      if (r1.ok) assert.equal(r1.cmd, gemBin);

      const rBad = resolveDispatchBinary("gemini", {
        PATH: bin,
        LISA_GEMINI_CLI_CMD: "./planted-gemini",
      });
      assert.equal(rBad.ok, false);

      const rMiss = resolveDispatchBinary("gemini", { PATH: path.join(tmp, "empty") });
      assert.equal(rMiss.ok, false);
      if (!rMiss.ok) assert.match(rMiss.error, /No executable found/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("opencode and aider resolve strictly via absolute PATH entries (rejecting relative/empty PATH)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-oa-bin-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      for (const agent of ["opencode", "aider"] as const) {
        const miss = resolveDispatchBinary(agent, { PATH: ".:relative" });
        assert.equal(miss.ok, false, `${agent} must reject relative PATH`);

        const exe = path.join(bin, agent);
        fs.writeFileSync(exe, "#!/bin/sh\necho ok\n", { mode: 0o755 });
        const hit = resolveDispatchBinary(agent, { PATH: bin });
        assert.equal(hit.ok, true);
        if (hit.ok) assert.equal(hit.cmd, exe);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("launchAgent captures the exit status (F4)", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-launch-"));
  const BIN = path.join(TMP, "bin");
  process.env.LISA_HOME = path.join(TMP, "home");
  process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH ?? ""}`;

  function fakeBin(name: string, script: string): void {
    fs.mkdirSync(BIN, { recursive: true });
    const p = path.join(BIN, name);
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
    fakeBin("claude", 'echo "boom"\nexit 3');
    const { launchAgent } = await import("./dispatch_agent.js");
    const res = await launchAgent("claude", "do a thing", TMP);
    assert.equal(res.error, undefined, `launch failed: ${res.error ?? ""}`);
    assert.ok(res.id, "expected a ledger id");
    const entry = await waitForExit(res.id);
    assert.ok(entry, "exit status was never recorded");
    assert.equal(entry?.exitCode, 3);
    assert.equal(entry?.exitSignal, null);
    assert.equal(typeof entry?.exitedAt, "number");
  });

  test("an agent that outlives the launch race records its exit code too", async () => {
    fakeBin("claude", 'sleep 0.4\necho "done"\nexit 0');
    const { launchAgent } = await import("./dispatch_agent.js");
    const res = await launchAgent("claude", "slower thing", TMP);
    assert.equal(res.error, undefined, `launch failed: ${res.error ?? ""}`);
    const entry = await waitForExit(res.id);
    assert.ok(entry, "exit status was never recorded");
    assert.equal(entry?.exitCode, 0);
  });

  test("launches cursor and gemini backends headlessly and captures output + exit", async () => {
    fakeBin("cursor-agent", 'printf "CURSOR:%s" "$2"\nexit 0');
    fakeBin("gemini", 'printf "GEMINI:%s" "$2"\nexit 0');
    const { launchAgent } = await import("./dispatch_agent.js");

    const cur = await launchAgent("cursor", "polish ui", TMP);
    assert.equal(cur.error, undefined, cur.error);
    assert.ok(cur.id);
    const curEntry = await waitForExit(cur.id);
    assert.equal(curEntry?.exitCode, 0);
    assert.match(fs.readFileSync(cur.logPath!, "utf8"), /CURSOR:polish ui/);

    const gem = await launchAgent("gemini", "analyze repo", TMP);
    assert.equal(gem.error, undefined, gem.error);
    assert.ok(gem.id);
    const gemEntry = await waitForExit(gem.id);
    assert.equal(gemEntry?.exitCode, 0);
    assert.match(fs.readFileSync(gem.logPath!, "utf8"), /GEMINI:analyze repo/);
  });

  test("a missing binary is still reported as a launch error, not an exit", async () => {
    const { launchAgent } = await import("./dispatch_agent.js");
    const previousPath = process.env.PATH;
    process.env.PATH = BIN;
    const override = process.env.LISA_PTY_CODEX_CMD;
    process.env.LISA_PTY_CODEX_CMD = path.join(TMP, "missing-codex");
    try {
      const res = await launchAgent("codex", "x", TMP);
      assert.match(res.error ?? "", /not found on PATH|Failed to launch|No executable found/);
      assert.equal(res.id, undefined);
    } finally {
      process.env.PATH = previousPath;
      if (override === undefined) delete process.env.LISA_PTY_CODEX_CMD;
      else process.env.LISA_PTY_CODEX_CMD = override;
    }
  });

  test("dispatch_agent wires same-cwd concurrency lock (symlink-aware) while allowing worktree/readOnly", async () => {
    fakeBin("claude", "sleep 2");
    fakeBin("gemini", "echo readonly-ok");
    fakeBin("cursor-agent", "echo worktree-ok");

    const { dispatchAgentTool } = await import("./dispatch_agent.js");
    const { listActiveCwdLocks, releaseCwdLock } = await import("../integrations/cwd-lock.js");
    const realDir = path.join(TMP, "work-real");
    const linkDir = path.join(TMP, "work-link");
    fs.mkdirSync(realDir, { recursive: true });
    if (!fs.existsSync(linkDir)) fs.symlinkSync(realDir, linkDir);

    const ctx: ToolContext = { cwd: realDir, signal: new AbortController().signal, log: () => {} };

    const first = await dispatchAgentTool.execute(
      { agent: "claude", task: "edit files", cwd: realDir },
      ctx,
    );
    assert.match(first, /Launched claude/);
    const pidMatch = first.match(/pid (\d+)/);
    const firstPid = pidMatch ? Number(pidMatch[1]) : undefined;

    try {
      // Second non-worktree run via symlink pointing to the same realpath must be refused.
      const clash = await dispatchAgentTool.execute(
        { agent: "gemini", task: "also edit", cwd: linkDir },
        ctx,
      );
      assert.match(clash, /Refusing to launch gemini/);

      // readOnly and worktree runs are allowed concurrently.
      const ro = await dispatchAgentTool.execute(
        { agent: "gemini", task: "read files", cwd: linkDir, readOnly: true },
        ctx,
      );
      assert.match(ro, /Launched gemini/);

      const wt = await dispatchAgentTool.execute(
        { agent: "cursor", task: "worktree edit", cwd: linkDir, worktree: true },
        ctx,
      );
      assert.match(wt, /Launched cursor/);
    } finally {
      if (firstPid) {
        try {
          process.kill(-firstPid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      for (const l of listActiveCwdLocks()) releaseCwdLock(l);
    }
  });

  test("dispatch_agent supports recommendOnly and agent:'auto' capability routing", async () => {
    fakeBin("gemini", "echo auto-gem");
    const { dispatchAgentTool } = await import("./dispatch_agent.js");
    const { adviseNowTool } = await import("./advise_now.js");
    const ctx: ToolContext = { cwd: TMP, signal: new AbortController().signal, log: () => {} };

    const preview = await dispatchAgentTool.execute(
      {
        agent: "auto",
        task: "Analyze the entire codebase docs and screenshots",
        recommendOnly: true,
      },
      ctx,
    );
    assert.match(preview, /Recommended agent:/);

    const adv = await adviseNowTool.execute(
      {
        task: "Analyze the entire codebase docs and screenshots",
      },
      ctx,
    );
    assert.match(adv, /Recommended agent: gemini/);

    const launched = await dispatchAgentTool.execute(
      {
        agent: "auto",
        task: "Analyze the entire codebase documentation and multimodal diagram",
        cwd: path.join(TMP, "auto-dir"),
      },
      (() => {
        fs.mkdirSync(path.join(TMP, "auto-dir"), { recursive: true });
        return ctx;
      })(),
    );
    assert.match(launched, /Launched /);
    assert.match(launched, /Routing rationale:/);
    // Allow fast fake binary to finish & release its lock
    await new Promise((r) => setTimeout(r, 100));
  });
});
