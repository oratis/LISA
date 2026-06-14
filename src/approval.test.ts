import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildApprovalCallback,
  DEFAULT_MUTATING_TOOLS,
  type ApprovalConfig,
} from "./approval.js";

function cfg(over: Partial<ApprovalConfig> = {}): ApprovalConfig {
  return { mode: "ask", mutatingTools: new Set(DEFAULT_MUTATING_TOOLS), ...over };
}

describe("buildApprovalCallback — mode gating", () => {
  test("'auto' → no callback (everything auto-allowed)", () => {
    assert.equal(buildApprovalCallback(cfg({ mode: "auto" })), undefined);
  });

  test("'ask-mutating' auto-allows a non-mutating tool WITHOUT prompting", async () => {
    let prompted = false;
    const cb = buildApprovalCallback(cfg({ mode: "ask-mutating", readLine: async () => { prompted = true; return "y"; } }))!;
    const d = await cb("read", { path: "x" });
    assert.deepEqual(d, { allow: true });
    assert.equal(prompted, false, "non-mutating tools must not trigger a prompt");
  });

  test("'ask-mutating' prompts for a mutating tool", async () => {
    const cb = buildApprovalCallback(cfg({ mode: "ask-mutating", readLine: async () => "y" }))!;
    assert.deepEqual(await cb("bash", { cmd: "ls" }), { allow: true });
  });

  test("DEFAULT_MUTATING_TOOLS covers the write/exec tools", () => {
    for (const t of ["write", "edit", "apply_patch", "bash"]) {
      assert.ok(DEFAULT_MUTATING_TOOLS.has(t), `expected ${t} to be mutating`);
    }
    assert.equal(DEFAULT_MUTATING_TOOLS.has("read"), false);
  });
});

describe("buildApprovalCallback — answer parsing (security-critical)", () => {
  test("'y' / 'yes' (any case) → allow", async () => {
    for (const ans of ["y", "yes", "Y", "YES", "  yes  "]) {
      const cb = buildApprovalCallback(cfg({ mode: "ask", readLine: async () => ans }))!;
      assert.deepEqual(await cb("bash", {}), { allow: true }, `"${ans}" should allow`);
    }
  });

  test("'n' / empty / anything else → deny (default-deny)", async () => {
    const cb = buildApprovalCallback(cfg({ mode: "ask", readLine: async () => "n" }))!;
    const d = await cb("bash", {});
    assert.equal(d.allow, false);

    const empty = buildApprovalCallback(cfg({ mode: "ask", readLine: async () => "" }))!;
    assert.equal((await empty("bash", {})).allow, false, "empty input defaults to deny");
  });

  test("a non-yes answer is captured as the denial reason", async () => {
    const cb = buildApprovalCallback(cfg({ mode: "ask", readLine: async () => "too risky" }))!;
    const d = await cb("bash", {});
    assert.equal(d.allow, false);
    assert.equal(d.reason, "too risky");
  });

  test("'yes' is matched exactly — 'yesterday' does NOT allow", async () => {
    const cb = buildApprovalCallback(cfg({ mode: "ask", readLine: async () => "yesterday" }))!;
    assert.equal((await cb("bash", {})).allow, false, "substring of 'yes' must not auto-allow");
  });
});
