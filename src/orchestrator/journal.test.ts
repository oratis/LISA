import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordEvent,
  eventsSince,
  allEvents,
  summarizeActivity,
  _resetJournalForTest,
} from "./journal.js";
import type { AgentSession } from "../integrations/types.js";

function sess(over: Partial<AgentSession> = {}): AgentSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    project: "proj",
    state: "working",
    stateReason: "tool",
    lastMtime: 1000,
    ...over,
  };
}

beforeEach(() => _resetJournalForTest());

describe("summarizeActivity", () => {
  test("tool · $cmd · file", () => {
    const s = sess({
      activity: { turnCount: 1, lastTools: ["Read", "Edit"], filesTouched: ["/a/b/foo.ts"], lastCommandName: "npm" },
    });
    assert.equal(summarizeActivity(s), "Edit · $npm · foo.ts");
  });
  test("no activity → undefined", () => {
    assert.equal(summarizeActivity(sess()), undefined);
  });
});

describe("recordEvent", () => {
  test("records a transition", () => {
    const ev = recordEvent(sess({ state: "working" }), 5000);
    assert.ok(ev);
    assert.equal(allEvents().length, 1);
    assert.equal(ev!.at, 1000); // uses lastMtime
  });

  test("collapses consecutive same state+reason for a session", () => {
    recordEvent(sess({ state: "working", stateReason: "tool", lastMtime: 1 }));
    const dup = recordEvent(sess({ state: "working", stateReason: "tool", lastMtime: 2 }));
    assert.equal(dup, null);
    assert.equal(allEvents().length, 1);
  });

  test("records when state changes", () => {
    recordEvent(sess({ state: "working", lastMtime: 1 }));
    const e2 = recordEvent(sess({ state: "waiting", stateReason: "end_turn", lastMtime: 2 }));
    assert.ok(e2);
    assert.equal(allEvents().length, 2);
  });

  test("falls back to `now` when lastMtime is missing/zero", () => {
    const ev = recordEvent(sess({ lastMtime: 0 }), 9999);
    assert.equal(ev!.at, 9999);
  });

  test("captures error from activity.lastError", () => {
    const ev = recordEvent(sess({ state: "error", stateReason: "is_error", activity: { turnCount: 0, lastTools: [], filesTouched: [], lastError: "boom" } }));
    assert.equal(ev!.error, "boom");
  });
});

describe("eventsSince", () => {
  test("filters by timestamp", () => {
    recordEvent(sess({ sessionId: "a", state: "working", lastMtime: 100 }));
    recordEvent(sess({ sessionId: "b", state: "working", lastMtime: 5000 }));
    const recent = eventsSince(1000);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.sessionId, "b");
  });
});
