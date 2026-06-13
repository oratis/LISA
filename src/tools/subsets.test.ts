import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../types.js";
import {
  AUTONOMOUS_BLOCKED_TOOL_NAMES,
  REMOTE_BLOCKED_TOOL_NAMES,
  autonomousSubset,
  remoteSafeSubset,
} from "./registry.js";

const fake = (name: string): ToolDefinition =>
  ({ name, description: name, inputSchema: { type: "object" }, execute: async () => "" }) as ToolDefinition;

const SAMPLE = [
  "bash",
  "write",
  "edit",
  "apply_patch",
  "read",
  "grep",
  "ls",
  "task",
  "redeploy",
  "dispatch_agent",
  "signal_agent",
  "scheduled_dispatch",
  "compare_agents",
  "run_checks",
  "github",
  "mcp",
  "takoapi",
  "skill_manage",
  "memory",
  "memory_search",
  "soul_patch",
  "soul_journal",
  "soul_feel",
  "soul_read",
  "desire_progress_log",
  "web_fetch",
  "set_mood",
].map(fake);

describe("autonomousSubset — self-driven runs (desire heartbeats / idle)", () => {
  test("strips shell / fs-mutation / dispatch / github / mcp", () => {
    const names = new Set(autonomousSubset(SAMPLE).map((t) => t.name));
    for (const blocked of AUTONOMOUS_BLOCKED_TOOL_NAMES) {
      assert.equal(names.has(blocked), false, `${blocked} must be blocked`);
    }
  });

  test("keeps soul / memory / journal / skill / read tools", () => {
    const names = new Set(autonomousSubset(SAMPLE).map((t) => t.name));
    for (const kept of [
      "read",
      "grep",
      "ls",
      "memory",
      "memory_search",
      "soul_patch",
      "soul_journal",
      "soul_feel",
      "desire_progress_log",
      "skill_manage",
      "web_fetch",
      "set_mood",
    ]) {
      assert.equal(names.has(kept), true, `${kept} must stay available`);
    }
  });

  test("LISA_AUTONOMOUS_FULL_TOOLS=1 restores the full set", () => {
    process.env.LISA_AUTONOMOUS_FULL_TOOLS = "1";
    try {
      assert.equal(autonomousSubset(SAMPLE).length, SAMPLE.length);
    } finally {
      delete process.env.LISA_AUTONOMOUS_FULL_TOOLS;
    }
  });
});

describe("remoteSafeSubset — IM-channel toolset", () => {
  test("blocks everything autonomous blocks, plus skill_manage", () => {
    const names = new Set(remoteSafeSubset(SAMPLE).map((t) => t.name));
    for (const blocked of REMOTE_BLOCKED_TOOL_NAMES) {
      assert.equal(names.has(blocked), false, `${blocked} must be blocked`);
    }
    assert.equal(names.has("skill_manage"), false);
  });

  test("task is blocked — its closure captures the FULL toolset and would bypass the boundary", () => {
    const names = new Set(remoteSafeSubset(SAMPLE).map((t) => t.name));
    assert.equal(names.has("task"), false);
  });

  test("conversational + soul tools survive for the phone use-case", () => {
    const names = new Set(remoteSafeSubset(SAMPLE).map((t) => t.name));
    for (const kept of ["memory", "memory_search", "soul_journal", "soul_read", "web_fetch", "set_mood"]) {
      assert.equal(names.has(kept), true, `${kept} must stay available`);
    }
  });
});
