import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatDetail } from "./inspect_agent.js";
import type { AgentSession } from "../integrations/types.js";

const NOW = 1_000_000_000_000;

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    agent: "claude-code",
    sessionId: "abcd1234-ef",
    project: "LISA",
    cwd: "/Users/x/LISA",
    state: "working",
    stateReason: "user",
    lastMtime: NOW - 30_000,
    ...over,
  };
}

describe("inspect_agent formatDetail", () => {
  test("renders header, state, cwd", () => {
    const out = formatDetail(session(), NOW);
    assert.match(out, /LISA · claude-code · abcd1234-ef/);
    assert.match(out, /state: working \(user\) · last active 30s ago/);
    assert.match(out, /cwd: \/Users\/x\/LISA/);
  });

  test("lists activity detail and caps files at 15", () => {
    const files = Array.from({ length: 20 }, (_, i) => `/Users/x/LISA/f${i}.ts`);
    const out = formatDetail(
      session({
        activity: {
          turnCount: 12,
          lastTools: ["Read", "Edit", "Bash"],
          filesTouched: files,
          lastCommandName: "npm",
          gitBranch: "main",
          tokens: { input: 1000, output: 200 },
        },
      }),
      NOW,
    );
    assert.match(out, /branch: main/);
    assert.match(out, /turns: 12/);
    assert.match(out, /tools: Read → Edit → Bash/);
    assert.match(out, /files touched \(20\):/);
    assert.match(out, /… \+5 more/);
    assert.match(out, /tokens: 1000 in \/ 200 out/);
  });

  test("surfaces pending permission and errors", () => {
    const out = formatDetail(
      session({ state: "error", activity: { turnCount: 1, lastTools: [], filesTouched: [], pendingPermission: "Bash", lastError: "ENOENT" } }),
      NOW,
    );
    assert.match(out, /waiting on permission: Bash/);
    assert.match(out, /error: ENOENT/);
  });
});
