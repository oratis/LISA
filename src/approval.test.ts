import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildApprovalCallback,
  isMutatingCall,
  DEFAULT_MUTATING_TOOLS,
  DEFAULT_MUTATING_ACTIONS,
  type ApprovalConfig,
} from "./approval.js";

function cfg(over: Partial<ApprovalConfig> = {}): ApprovalConfig {
  return {
    mode: "ask",
    mutatingTools: new Set(DEFAULT_MUTATING_TOOLS),
    mutatingActions: DEFAULT_MUTATING_ACTIONS,
    ...over,
  };
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

  test("DEFAULT_MUTATING_TOOLS covers write/exec + dispatch/signal", () => {
    for (const t of ["write", "edit", "apply_patch", "bash", "dispatch_agent", "signal_agent"]) {
      assert.ok(DEFAULT_MUTATING_TOOLS.has(t), `expected ${t} to be mutating`);
    }
    assert.equal(DEFAULT_MUTATING_TOOLS.has("read"), false);
  });

  test("dispatch_agent / signal_agent prompt under ask-mutating", async () => {
    for (const t of ["dispatch_agent", "signal_agent"]) {
      let prompted = false;
      const cb = buildApprovalCallback(cfg({ mode: "ask-mutating", readLine: async () => { prompted = true; return "y"; } }))!;
      await cb(t, {});
      assert.equal(prompted, true, `${t} should prompt`);
    }
  });
});

describe("action-aware mutating gate (github reads safe, writes gated)", () => {
  test("isMutatingCall: github writes mutate, reads don't", () => {
    const c = cfg();
    assert.equal(isMutatingCall(c, "github", { action: "pr_merge" }), true);
    assert.equal(isMutatingCall(c, "github", { action: "pr_create" }), true);
    assert.equal(isMutatingCall(c, "github", { action: "pr_view" }), false);
    assert.equal(isMutatingCall(c, "github", { action: "issue_list" }), false);
    assert.equal(isMutatingCall(c, "github", {}), false, "no action → not mutating");
    assert.equal(isMutatingCall(c, "dispatch_agent", {}), true, "whole-tool mutating still works");
  });

  test("under ask-mutating: a github read auto-allows, a github write prompts", async () => {
    let prompted = false;
    const reader = async () => { prompted = true; return "y"; };

    const readCb = buildApprovalCallback(cfg({ mode: "ask-mutating", readLine: reader }))!;
    assert.deepEqual(await readCb("github", { action: "pr_view" }), { allow: true });
    assert.equal(prompted, false, "a github read must not prompt");

    const writeCb = buildApprovalCallback(cfg({ mode: "ask-mutating", readLine: reader }))!;
    await writeCb("github", { action: "pr_merge" });
    assert.equal(prompted, true, "a github write must prompt");
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
