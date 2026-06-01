import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatSessionLine } from "./list_agents.js";
import type { AgentSession } from "../integrations/types.js";

const NOW = 1_000_000_000_000;

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    agent: "claude-code",
    sessionId: "abc",
    project: "LISA",
    state: "working",
    stateReason: "user",
    lastMtime: NOW - 90_000, // 1m ago
    ...overrides,
  };
}

describe("list_agents formatSessionLine", () => {
  test("renders state, project, agent and relative time", () => {
    const line = formatSessionLine(session(), NOW);
    assert.match(line, /\[working\] LISA \(claude-code, 1m ago\)/);
  });

  test("surfaces a pending permission over other activity", () => {
    const line = formatSessionLine(
      session({ activity: { turnCount: 3, lastTools: ["Edit"], filesTouched: [], pendingPermission: "Bash" } }),
      NOW,
    );
    assert.match(line, /needs permission: Bash/);
  });

  test("shows branch, last command name, and basenames of files", () => {
    const line = formatSessionLine(
      session({
        activity: {
          turnCount: 5,
          lastTools: ["Read", "Bash"],
          filesTouched: ["/Users/x/repo/src/web/server.ts"],
          lastCommandName: "git",
          gitBranch: "main",
        },
      }),
      NOW,
    );
    assert.match(line, /@main/);
    assert.match(line, /\$ git/);
    assert.match(line, /files: server\.ts/);
  });

  test("never leaks full paths beyond the basename (structural only)", () => {
    const line = formatSessionLine(
      session({ activity: { turnCount: 1, lastTools: [], filesTouched: ["/Users/secret/private/notes.md"] } }),
      NOW,
    );
    assert.doesNotMatch(line, /\/Users\/secret/);
    assert.match(line, /notes\.md/);
  });
});
