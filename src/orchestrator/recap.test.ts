import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildRecap, formatRecap } from "./recap.js";
import type { AgentEvent } from "./journal.js";

function ev(over: Partial<AgentEvent>): AgentEvent {
  return {
    agent: "claude-code",
    sessionId: "s1",
    project: "proj",
    state: "working",
    stateReason: "tool",
    at: 1000,
    ...over,
  };
}

describe("buildRecap", () => {
  test("empty window → zero + clear headline", () => {
    const r = buildRecap([], 0, 10_000);
    assert.equal(r.totalSessions, 0);
    assert.match(r.headline, /No agent activity/);
    assert.equal(formatRecap(r), r.headline);
  });

  test("filters out events before sinceMs", () => {
    const r = buildRecap([ev({ at: 100 }), ev({ sessionId: "s2", at: 9000 })], 1000, 10_000);
    assert.equal(r.totalSessions, 1);
  });

  test("latest state per session wins; tallies finished/errored/active", () => {
    const events: AgentEvent[] = [
      ev({ sessionId: "a", project: "foo", state: "working", at: 1000 }),
      ev({ sessionId: "a", project: "foo", state: "done", stateReason: "exit", at: 2000 }),
      ev({ sessionId: "b", project: "foo", agent: "codex", state: "error", stateReason: "is_error", error: "boom", at: 1500 }),
      ev({ sessionId: "c", project: "bar", state: "working", at: 1800 }),
    ];
    const r = buildRecap(events, 0, 3000);
    assert.equal(r.totalSessions, 3);
    const foo = r.projects.find((p) => p.project === "foo")!;
    assert.equal(foo.finished, 1);
    assert.equal(foo.errored, 1);
    assert.deepEqual(foo.agents, ["claude-code", "codex"]);
    const bar = r.projects.find((p) => p.project === "bar")!;
    assert.equal(bar.active, 1);
    // errored project sorts first
    assert.equal(r.projects[0]!.project, "foo");
    assert.match(r.headline, /3 agent sessions across 2 projects/);
  });

  test("notable lines include error detail + finishes", () => {
    const events = [
      ev({ sessionId: "x", agent: "codex", state: "error", stateReason: "is_error", error: "model not found", at: 1000 }),
    ];
    const r = buildRecap(events, 0, 2000);
    const proj = r.projects[0]!;
    assert.ok(proj.notable.some((n) => /codex errored: model not found/.test(n)));
  });

  test("collects touched file basenames from activity summaries", () => {
    const events = [
      ev({ sessionId: "x", activity: "Edit · src/foo.ts", at: 1000 }),
      ev({ sessionId: "x", state: "waiting", stateReason: "end_turn", activity: "Bash · $npm", at: 1100 }),
    ];
    const r = buildRecap(events, 0, 2000);
    assert.ok(r.projects[0]!.files.includes("foo.ts"));
  });

  test("formatRecap renders headline + per-project lines", () => {
    const events = [
      ev({ sessionId: "a", project: "foo", state: "done", stateReason: "exit", at: 1000 }),
    ];
    const out = formatRecap(buildRecap(events, 0, 2000));
    assert.match(out, /foo · claude-code/);
    assert.match(out, /✓ claude-code finished/);
  });
});
