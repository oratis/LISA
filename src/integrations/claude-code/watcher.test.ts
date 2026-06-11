import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyStaleness, TOOL_STALL_THRESHOLD_MS } from "./watcher.js";
import type { SessionActivity } from "../types.js";

function activity(over: Partial<SessionActivity> = {}): SessionActivity {
  return { turnCount: 5, lastTools: ["Read", "Bash"], filesTouched: [], ...over };
}

describe("applyStaleness — a running tool is NOT a permission prompt", () => {
  test("tool stalled 10s stays working with no pendingPermission (the false-urgent bug)", () => {
    // An auto-approved tool that runs 10s (npm test, long Bash, WebFetch)
    // stops the jsonl growing — that must not be reported as a permission
    // prompt, or the advisor fires an urgent "approve?" for it.
    const d = applyStaleness("working", "tool_use", 10_000, activity());
    assert.equal(d.state, "working");
    assert.equal(d.stateReason, "tool_use");
    assert.equal(d.activity?.pendingPermission, undefined);
  });

  test("fresh tool_use stays working", () => {
    const d = applyStaleness("working", "tool_use", 1_000, activity());
    assert.equal(d.state, "working");
    assert.equal(d.stateReason, "tool_use");
  });

  test("tool stalled past the long threshold → waiting/'stalled on <tool>', still no pendingPermission", () => {
    const d = applyStaleness("working", "tool_use", TOOL_STALL_THRESHOLD_MS + 5_000, activity());
    assert.equal(d.state, "waiting");
    assert.equal(d.stateReason, "stalled on Bash");
    assert.equal(d.activity?.pendingPermission, undefined);
  });

  test("long tool stall without activity (metadata tier) → plain 'stalled'", () => {
    const d = applyStaleness("working", "tool_use", TOOL_STALL_THRESHOLD_MS + 5_000);
    assert.equal(d.state, "waiting");
    assert.equal(d.stateReason, "stalled");
  });
});

describe("applyStaleness — idle flips and the explicit permission signal", () => {
  test("stale assistant/user turns still flip to waiting/idle", () => {
    const a = applyStaleness("working", "assistant", 6_000);
    assert.equal(a.state, "waiting");
    assert.equal(a.stateReason, "idle");
    const u = applyStaleness("working", "user", 6_000);
    assert.equal(u.state, "waiting");
    assert.equal(u.stateReason, "idle");
  });

  test("fresh assistant turn stays working", () => {
    const d = applyStaleness("working", "assistant", 1_000);
    assert.equal(d.state, "working");
    assert.equal(d.stateReason, "assistant");
  });

  test("the parser's EXPLICIT permission signal still attaches pendingPermission", () => {
    // parser.ts only emits reason "permission" for a system entry with a
    // permission subtype — that path keeps driving the urgent advisor flow.
    const d = applyStaleness("waiting", "permission", 30_000, activity());
    assert.equal(d.state, "waiting");
    assert.equal(d.stateReason, "permission");
    assert.equal(d.activity?.pendingPermission, "Bash");
  });

  test("a stale pendingPermission carried in the activity snapshot is stripped", () => {
    const d = applyStaleness("working", "user", 0, activity({ pendingPermission: "Bash" }));
    assert.equal(d.state, "working");
    assert.equal(d.activity?.pendingPermission, undefined);
  });

  test("waiting/end_turn passes through untouched no matter how old", () => {
    const d = applyStaleness("waiting", "end_turn", 30 * 60_000, activity());
    assert.equal(d.state, "waiting");
    assert.equal(d.stateReason, "end_turn");
    assert.equal(d.activity?.pendingPermission, undefined);
  });
});
