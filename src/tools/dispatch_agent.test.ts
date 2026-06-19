import { test, describe } from "node:test";
import assert from "node:assert/strict";
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
