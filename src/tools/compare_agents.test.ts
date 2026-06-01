import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatStatusLine, formatJobHeader } from "./compare_agents.js";
import type { ComparisonEntry, ComparisonJob } from "../integrations/comparisons.js";

function entry(over: Partial<ComparisonEntry> = {}): ComparisonEntry {
  return { agent: "claude", worktree: "/wt/claude", branch: "lisa-compare/ab12-claude", pid: 100, ...over };
}

describe("compare_agents formatStatusLine", () => {
  test("shows state and changed count", () => {
    assert.match(formatStatusLine(entry(), "working", 4), /claude: working · 4 file\(s\) changed/);
  });
  test("no session yet", () => {
    assert.match(formatStatusLine(entry(), null, 0), /claude: no session yet · 0 file/);
  });
  test("launch failure is surfaced", () => {
    assert.match(formatStatusLine(entry({ launchError: "ENOENT" }), null, 0), /failed to launch — ENOENT/);
  });
});

describe("compare_agents formatJobHeader", () => {
  test("renders id, agent count, repo, task", () => {
    const job: ComparisonJob = {
      id: "ab12cd34",
      task: "implement dark mode",
      repo: "/Users/x/app",
      createdAt: 0,
      entries: [entry(), entry({ agent: "codex" })],
    };
    const out = formatJobHeader(job);
    assert.match(out, /compare ab12cd34 \(2 agents\) in \/Users\/x\/app/);
    assert.match(out, /task: "implement dark mode"/);
  });
});
