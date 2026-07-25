import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../types.js";
import {
  AUTONOMOUS_BLOCKED_TOOL_NAMES,
  CLOUD_ALLOWED_TOOL_NAMES,
  REMOTE_BLOCKED_TOOL_NAMES,
  autonomousSubset,
  cloudSafeSubset,
  desireReviewSubset,
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
  "run_on_plan",
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
  "desire_revise",
  "desire_close",
  "web_search",
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

describe("desireReviewSubset — scheduled browsing boundary", () => {
  test("keeps only desire review capabilities", () => {
    const names = new Set(desireReviewSubset(SAMPLE).map((t) => t.name));
    assert.deepEqual(
      [...names].sort(),
      [
        "desire_close",
        "desire_progress_log",
        "desire_revise",
        "soul_journal",
        "soul_read",
        "web_fetch",
        "web_search",
      ],
    );
    for (const forbidden of ["bash", "write", "soul_patch", "github", "mcp"]) {
      assert.equal(names.has(forbidden), false, `${forbidden} must be unavailable`);
    }
  });

  test("enforces one search and two fetches in code", async () => {
    const subset = desireReviewSubset(SAMPLE);
    const ctx = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      log: () => {},
    };
    const search = subset.find((t) => t.name === "web_search")!;
    const fetch = subset.find((t) => t.name === "web_fetch")!;
    await search.execute({}, ctx);
    await assert.rejects(() => search.execute({}, ctx), /max 1 web_search/);
    await fetch.execute({}, ctx);
    await fetch.execute({}, ctx);
    await assert.rejects(() => fetch.execute({}, ctx), /max 2 web_fetch/);
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

describe("cloudSafeSubset — hosted multi-tenant toolset", () => {
  test("uses an allow-list and rejects host, process, network-fetch, and unknown plugin tools", () => {
    const unknown = fake("operator_plugin_secret");
    const names = new Set(cloudSafeSubset([...SAMPLE, unknown]).map((t) => t.name));
    for (const blocked of [
      "bash",
      "read",
      "write",
      "grep",
      "ls",
      "task",
      "web_fetch",
      "dispatch_agent",
      "mcp",
      "skill_manage",
      "operator_plugin_secret",
    ]) {
      assert.equal(names.has(blocked), false, `${blocked} must be blocked`);
    }
  });

  test("keeps only explicitly approved tenant-scoped tools", () => {
    const candidates = [...SAMPLE, fake("kb_search"), fake("kb_write"), fake("soul_object")];
    const names = new Set(cloudSafeSubset(candidates).map((t) => t.name));
    for (const kept of ["memory", "memory_search", "soul_read", "soul_object", "kb_search", "kb_write", "set_mood"]) {
      assert.equal(CLOUD_ALLOWED_TOOL_NAMES.has(kept), true);
      assert.equal(names.has(kept), true, `${kept} must stay available`);
    }
    for (const name of names) {
      assert.equal(CLOUD_ALLOWED_TOOL_NAMES.has(name), true, `${name} must be allow-listed`);
    }
  });
});
