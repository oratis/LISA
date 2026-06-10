import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detectPermission,
  detectStuck,
  detectConflict,
  detectCostSpike,
  detectReady,
  detectIdleCapacity,
  STUCK_MS,
  COST_SPIKE_TOKENS,
} from "./detectors.js";
import { decide, scoreSuggestion, applyDismissal } from "./engine.js";
import { emptyAdvisorState, type AdvisorInput, type Suggestion } from "./types.js";
import type { AgentSession } from "../integrations/types.js";

const NOW = 1_700_000_000_000;

function sess(over: Partial<AgentSession>): AgentSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    project: "proj",
    state: "working",
    stateReason: "tool_use",
    lastMtime: NOW,
    ...over,
  };
}
function input(sessions: AgentSession[], extra: Partial<AdvisorInput> = {}): AdvisorInput {
  return { sessions, now: NOW, ...extra };
}

describe("detectors — permission", () => {
  test("pending permission → urgent + approve action", () => {
    const s = sess({ activity: { turnCount: 5, lastTools: ["Bash"], filesTouched: [], pendingPermission: "Bash" } });
    const out = detectPermission(input([s]));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.urgency, "urgent");
    assert.equal(out[0]!.action?.kind, "approve");
  });
  test("a long-running auto-approved tool (10s mtime stall) → NO urgent permission alarm", () => {
    // The watcher no longer fabricates pendingPermission from staleness: a
    // tool that has merely been running for 10s is still working/tool_use
    // with plain activity. Neither the permission nor the stuck detector
    // may fire for it.
    const s = sess({
      state: "working",
      stateReason: "tool_use",
      lastMtime: NOW - 10_000,
      activity: { turnCount: 5, lastTools: ["Bash"], filesTouched: [] },
    });
    assert.equal(detectPermission(input([s])).length, 0);
    assert.equal(detectStuck(input([s])).length, 0);
  });
});

describe("detectors — stuck", () => {
  test("waiting with a non-clean reason + stale → stuck", () => {
    const s = sess({ state: "waiting", stateReason: "idle", lastMtime: NOW - STUCK_MS - 1000 });
    const out = detectStuck(input([s]));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.category, "stuck");
  });
  test("error + stale → stuck", () => {
    const s = sess({ state: "error", stateReason: "is_error", lastMtime: NOW - STUCK_MS - 1000 });
    const out = detectStuck(input([s]));
    assert.equal(out.length, 1);
    assert.match(out[0]!.text, /errored/);
  });
  test("waiting/end_turn (cleanly finished) is NOT stuck — the v1 noise bug", () => {
    // This is the fix: a finished-and-idle session is normal, not stuck.
    const s = sess({ state: "waiting", stateReason: "end_turn", lastMtime: NOW - STUCK_MS - 999_999 });
    assert.equal(detectStuck(input([s])).length, 0);
  });
  test("working session is never stuck (it's progressing)", () => {
    const s = sess({ state: "working", lastMtime: NOW - STUCK_MS - 1000 });
    assert.equal(detectStuck(input([s])).length, 0);
  });
  test("fresh waiting session → no stuck", () => {
    const s = sess({ state: "waiting", stateReason: "idle", lastMtime: NOW - 1000 });
    assert.equal(detectStuck(input([s])).length, 0);
  });
  test("a genuinely long tool stall (waiting/'stalled on …') → ordinary notice, never urgent", () => {
    // What the watcher emits for a tool whose jsonl has been quiet a long
    // time. After STUCK_MS it surfaces — but only as a notice via
    // detectStuck, not as an urgent permission alarm.
    const s = sess({
      state: "waiting",
      stateReason: "stalled on Bash",
      lastMtime: NOW - STUCK_MS - 5 * 60_000,
      activity: { turnCount: 5, lastTools: ["Bash"], filesTouched: [], lastCommandName: "npm" },
    });
    assert.equal(detectPermission(input([s])).length, 0, "no urgent permission alarm");
    const out = detectStuck(input([s]));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.urgency, "notice");
    assert.match(out[0]!.text, /stalled/);
  });
  test("pending permission is NOT double-reported as stuck", () => {
    const s = sess({
      state: "waiting",
      stateReason: "permission",
      lastMtime: NOW - STUCK_MS - 1,
      activity: { turnCount: 1, lastTools: ["Bash"], filesTouched: [], pendingPermission: "Bash" },
    });
    assert.equal(detectStuck(input([s])).length, 0);
  });
  test("more than the collapse threshold → one rolled-up suggestion", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      sess({ sessionId: "s" + i, state: "error", stateReason: "is_error", lastMtime: NOW - STUCK_MS - 1000 }),
    );
    const out = detectStuck(input(many));
    assert.equal(out.length, 1, "collapsed into a single line");
    assert.match(out[0]!.text, /5 agent sessions/);
    assert.match(out[0]!.text, /5 errored/);
  });
});

describe("detectors — conflict", () => {
  test("two agents in the same cwd → conflict", () => {
    const a = sess({ agent: "claude-code", sessionId: "a", cwd: "/repo", state: "working" });
    const b = sess({ agent: "codex", sessionId: "b", cwd: "/repo", state: "working" });
    const out = detectConflict(input([a, b]));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.action?.kind, "serialize");
    assert.match(out[0]!.text, /both working/);
  });
  test("different cwds → no conflict", () => {
    const a = sess({ sessionId: "a", cwd: "/repo1" });
    const b = sess({ sessionId: "b", cwd: "/repo2" });
    assert.equal(detectConflict(input([a, b])).length, 0);
  });
});

describe("detectors — cost spike", () => {
  test("combined tokens over threshold → notice", () => {
    const a = sess({ sessionId: "a", activity: { turnCount: 1, lastTools: [], filesTouched: [], tokens: { input: COST_SPIKE_TOKENS, output: 100 } } });
    const out = detectCostSpike(input([a]));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.category, "cost_spike");
  });
  test("under threshold → nothing", () => {
    const a = sess({ activity: { turnCount: 1, lastTools: [], filesTouched: [], tokens: { input: 1000, output: 100 } } });
    assert.equal(detectCostSpike(input([a])).length, 0);
  });
});

describe("detectors — ready / idle", () => {
  test("end_turn waiting → ready", () => {
    const s = sess({ state: "waiting", stateReason: "end_turn" });
    const out = detectReady(input([s]));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.category, "ready");
  });
  test("idle capacity when nothing runs + pending desires", () => {
    const out = detectIdleCapacity(input([], { pendingDesireCount: 2 }));
    assert.equal(out.length, 1);
    assert.match(out[0]!.text, /2 standing/);
  });
  test("no idle suggestion when something is running", () => {
    const out = detectIdleCapacity(input([sess({ state: "working" })], { pendingDesireCount: 5 }));
    assert.equal(out.length, 0);
  });
});

describe("engine — relevance bar + throttle + dedup", () => {
  function cand(over: Partial<Suggestion>): Suggestion {
    return {
      id: "x",
      category: "stuck",
      urgency: "notice",
      text: "t",
      conditionHash: "h",
      ts: NOW,
      score: 0,
      action: { label: "Look", kind: "look" },
      ...over,
    };
  }

  test("urgent always surfaces, even within throttle window", () => {
    const state = { ...emptyAdvisorState(), lastDigestAt: NOW - 1000 }; // just digested
    const { decision } = decide([cand({ id: "u", urgency: "urgent" })], state, NOW);
    assert.equal(decision.surface.length, 1);
  });

  test("non-urgent suppressed while within throttle window", () => {
    const state = { ...emptyAdvisorState(), lastDigestAt: NOW - 1000 };
    const { decision } = decide([cand({ id: "n", urgency: "notice" })], state, NOW);
    assert.equal(decision.surface.length, 0);
    assert.equal(decision.suppressed.length, 1);
  });

  test("non-urgent surfaces when throttle window has passed", () => {
    const state = emptyAdvisorState(); // lastDigestAt = 0, long ago
    const { decision, nextState } = decide([cand({ id: "n" })], state, NOW);
    assert.equal(decision.surface.length, 1);
    assert.equal(nextState.lastDigestAt, NOW, "digest clock advanced");
  });

  test("duplicate (same condition) is suppressed; changed condition re-surfaces", () => {
    const state = emptyAdvisorState();
    // First run surfaces + records.
    const r1 = decide([cand({ id: "d", conditionHash: "h1" })], state, NOW);
    assert.equal(r1.decision.surface.length, 1);
    // Same condition shortly after → dup.
    const r2 = decide([cand({ id: "d", conditionHash: "h1" })], r1.nextState, NOW + 1000);
    assert.equal(r2.decision.surface.length, 0);
    // Condition changed → fresh (but throttle now applies, so give it room).
    const stateClear = { ...r1.nextState, lastDigestAt: 0 };
    const r3 = decide([cand({ id: "d", conditionHash: "h2" })], stateClear, NOW + 2000);
    assert.equal(r3.decision.surface.length, 1);
  });

  test("below the relevance bar → suppressed", () => {
    const state = emptyAdvisorState();
    // info + no action → score = 1 * 0.5 = 0.5 < 1.5
    const { decision } = decide([cand({ id: "lo", urgency: "info", action: undefined })], state, NOW);
    assert.equal(decision.surface.length, 0);
  });

  test("dismissals decay a category's score (learns to shut up)", () => {
    let state = emptyAdvisorState();
    const before = scoreSuggestion(cand({ urgency: "notice" }), state);
    state = applyDismissal(state, "x", "stuck");
    state = applyDismissal(state, "x", "stuck");
    const after = scoreSuggestion(cand({ urgency: "notice" }), state);
    assert.ok(after < before, "score drops after dismissals");
  });
});
