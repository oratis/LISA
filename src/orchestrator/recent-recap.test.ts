import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { _resetJournalForTest, recordEvent } from "./journal.js";
import { recentAgentRecap } from "./recent-recap.js";
import type { AgentSession } from "../integrations/types.js";

const NOW = 1_700_000_000_000;
const WINDOW = 2 * 60 * 60_000; // 2h

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    project: "myrepo",
    cwd: "/x/myrepo",
    state: "done",
    stateReason: "end_turn",
    lastMtime: NOW - 60_000, // 1 min ago
    ...overrides,
  };
}

describe("recentAgentRecap", () => {
  beforeEach(() => _resetJournalForTest());

  test("null when the journal is empty (so callers can inject conditionally)", () => {
    assert.equal(recentAgentRecap(WINDOW, NOW), null);
  });

  test("renders a digest after activity within the window", () => {
    recordEvent(session(), NOW);
    const out = recentAgentRecap(WINDOW, NOW);
    assert.ok(out, "expected a non-null recap");
    assert.match(out!, /myrepo/);
    assert.match(out!, /claude-code/);
  });

  test("null when the only activity is outside the window", () => {
    recordEvent(session({ lastMtime: NOW - 3 * 60 * 60_000 }), NOW); // 3h ago
    assert.equal(recentAgentRecap(WINDOW, NOW), null);
  });
});
