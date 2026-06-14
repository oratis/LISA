import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runHook, fireHooks, type HookEnv } from "./runner.js";
import type { HookSpec } from "../plugins/types.js";

const CWD = process.cwd();
const ENV: HookEnv = {};

// runHook spawns /bin/bash -lc, so these use real (harmless) shell commands —
// the actual mechanism, deterministic and fast for echo/exit.

describe("runHook", () => {
  test("captures stdout + exit code 0", async () => {
    const out = await runHook({ event: "PreToolUse", command: "echo hello" }, ENV, CWD);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /hello/);
  });

  test("captures stderr + a non-zero exit code", async () => {
    const out = await runHook({ event: "PreToolUse", command: "echo oops >&2; exit 2" }, ENV, CWD);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /oops/);
  });

  test("passes HookEnv through to the command", async () => {
    const out = await runHook({ event: "PreToolUse", command: 'echo "$TOOL_NAME"' }, { TOOL_NAME: "bash" }, CWD);
    assert.match(out.stdout, /bash/);
  });
});

describe("fireHooks — matching + exit-code-2 semantics", () => {
  test("PreToolUse exit 2 → blocked, carrying stderr as the reason", async () => {
    const hooks: HookSpec[] = [{ event: "PreToolUse", command: "echo no-thanks >&2; exit 2" }];
    const r = await fireHooks("PreToolUse", hooks, ENV, CWD);
    assert.equal(r.blocked.length, 1);
    assert.match(r.blocked[0]!, /no-thanks/);
  });

  test("PostToolUse exit 2 → rewriteResult from stdout (not a block)", async () => {
    const hooks: HookSpec[] = [{ event: "PostToolUse", command: "echo REWRITTEN; exit 2" }];
    const r = await fireHooks("PostToolUse", hooks, ENV, CWD);
    assert.equal(r.blocked.length, 0);
    assert.match(r.rewriteResult ?? "", /REWRITTEN/);
  });

  test("exit 0 is a no-op (not blocked, no rewrite)", async () => {
    const hooks: HookSpec[] = [{ event: "PreToolUse", command: "echo fine; exit 0" }];
    const r = await fireHooks("PreToolUse", hooks, ENV, CWD);
    assert.deepEqual(r.blocked, []);
    assert.equal(r.rewriteResult, undefined);
  });

  test("only hooks for the fired event run", async () => {
    const hooks: HookSpec[] = [
      { event: "PostToolUse", command: "echo wrong-event >&2; exit 2" },
    ];
    const r = await fireHooks("PreToolUse", hooks, ENV, CWD);
    assert.deepEqual(r.blocked, [], "a PostToolUse hook must not fire on PreToolUse");
  });

  test("matcher: regex on TOOL_NAME gates the hook", async () => {
    const hooks: HookSpec[] = [{ event: "PreToolUse", matcher: "^bash$", command: "echo blocked >&2; exit 2" }];
    const hit = await fireHooks("PreToolUse", hooks, { TOOL_NAME: "bash" }, CWD);
    assert.equal(hit.blocked.length, 1);
    const miss = await fireHooks("PreToolUse", hooks, { TOOL_NAME: "read" }, CWD);
    assert.equal(miss.blocked.length, 0);
  });

  test("an invalid matcher regex falls back to a literal match", async () => {
    const hooks: HookSpec[] = [{ event: "PreToolUse", matcher: "[unclosed", command: "exit 2" }];
    const literal = await fireHooks("PreToolUse", hooks, { TOOL_NAME: "[unclosed" }, CWD);
    assert.equal(literal.blocked.length, 1, "literal match on the bad-regex string");
    const other = await fireHooks("PreToolUse", hooks, { TOOL_NAME: "bash" }, CWD);
    assert.equal(other.blocked.length, 0);
  });
});
