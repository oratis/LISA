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

const fake = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  execute: async () => "",
});

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
    assert.deepEqual([...names].sort(), [
      "desire_close",
      "desire_progress_log",
      "desire_revise",
      "soul_journal",
      "soul_read",
      "web_fetch",
      "web_search",
    ]);
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
    for (const kept of [
      "memory",
      "memory_search",
      "soul_journal",
      "soul_read",
      "web_fetch",
      "set_mood",
    ]) {
      assert.equal(names.has(kept), true, `${kept} must stay available`);
    }
  });
});

describe("cloudSafeSubset — hosted multi-tenant toolset", () => {
  test("uses an allow-list and rejects host, process, ingest, and unknown plugin tools", () => {
    const unknown = fake("operator_plugin_secret");
    const names = new Set(
      cloudSafeSubset([...SAMPLE, unknown, fake("kb_ingest"), fake("takoapi"), fake("github")]).map(
        (t) => t.name,
      ),
    );
    for (const blocked of [
      "bash",
      "read",
      "write",
      "grep",
      "ls",
      "task",
      "dispatch_agent",
      "mcp",
      "skill_manage",
      // Outbound tools other than the two governed web tools stay out.
      "kb_ingest",
      "takoapi",
      "github",
      "operator_plugin_secret",
    ]) {
      assert.equal(names.has(blocked), false, `${blocked} must be blocked`);
    }
  });

  test("admits web_search / web_fetch only as governed hosted instances", async () => {
    const locals = SAMPLE.filter((t) => t.name === "web_search" || t.name === "web_fetch");
    assert.equal(locals.length, 2);
    const subset = cloudSafeSubset(SAMPLE);
    const ctx = { cwd: "/", signal: new AbortController().signal, log: () => {} };
    for (const name of ["web_search", "web_fetch"]) {
      const hosted = subset.find((t) => t.name === name);
      assert.ok(hosted, `${name} must be in the cloud subset`);
      // Not the tool object that was passed in: the local instance (here a fake
      // that would "succeed") is replaced, never wrapped or passed through.
      assert.equal(locals.includes(hosted), false, `${name} must be replaced`);
      // And the replacement is the governed one — outside a tenant request
      // scope it refuses instead of running.
      await assert.rejects(
        () => hosted.execute({ url: "https://example.com/", query: "x" }, ctx),
        /only available inside a signed-in account/,
      );
    }
  });

  test("the cloud subset is idempotent — a second pass keeps the same governed tools", () => {
    const once = cloudSafeSubset(SAMPLE);
    const twice = cloudSafeSubset(once);
    assert.deepEqual(
      twice.map((t) => t.name),
      once.map((t) => t.name),
    );
    for (const name of ["web_search", "web_fetch"]) {
      assert.equal(
        twice.find((t) => t.name === name),
        once.find((t) => t.name === name),
      );
    }
  });

  test("LISA_CLOUD_WEB_TOOLS=0 removes both web tools and nothing else", () => {
    const before = process.env.LISA_CLOUD_WEB_TOOLS;
    const withTools = cloudSafeSubset(SAMPLE).map((t) => t.name);
    process.env.LISA_CLOUD_WEB_TOOLS = "0";
    try {
      const without = cloudSafeSubset(SAMPLE).map((t) => t.name);
      assert.equal(without.includes("web_search"), false);
      assert.equal(without.includes("web_fetch"), false);
      assert.deepEqual(
        without,
        withTools.filter((n) => n !== "web_search" && n !== "web_fetch"),
      );
    } finally {
      if (before === undefined) delete process.env.LISA_CLOUD_WEB_TOOLS;
      else process.env.LISA_CLOUD_WEB_TOOLS = before;
    }
  });

  test("keeps only explicitly approved tenant-scoped tools", () => {
    const candidates = [...SAMPLE, fake("kb_search"), fake("kb_write"), fake("soul_object")];
    const names = new Set(cloudSafeSubset(candidates).map((t) => t.name));
    for (const kept of [
      "memory",
      "memory_search",
      "soul_read",
      "soul_object",
      "kb_search",
      "kb_write",
      "set_mood",
    ]) {
      assert.equal(CLOUD_ALLOWED_TOOL_NAMES.has(kept), true);
      assert.equal(names.has(kept), true, `${kept} must stay available`);
    }
    for (const name of names) {
      assert.equal(CLOUD_ALLOWED_TOOL_NAMES.has(name), true, `${name} must be allow-listed`);
    }
  });
});
