import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyToolCall, isInsideWorkspace, isKnownBuiltin } from "./classify.js";
import { buildToolRegistry, AUTONOMOUS_BLOCKED_TOOL_NAMES } from "../tools/registry.js";
import { DEFAULT_MUTATING_ACTIONS, DEFAULT_MUTATING_TOOLS } from "../approval.js";
import {
  canonicalJson,
  detectDataClasses,
  payloadDigest,
  redactedPreview,
  auditTargets,
} from "./preview.js";
import type { ToolDefinition } from "../types.js";
import type { ActionCategory } from "./types.js";

const WS = "/work/project";
const sandboxedCtx = { workspaceRoot: WS, sandboxMode: "workspace-write" as const };
const dangerCtx = { workspaceRoot: WS, sandboxMode: "danger-full-access" as const };

function cat(name: string, input: unknown = {}, tool?: ToolDefinition): ActionCategory {
  return classifyToolCall(name, input, tool, sandboxedCtx).category;
}

function fakeTool(name: string, annotations?: ToolDefinition["annotations"]): ToolDefinition {
  return {
    name,
    description: "",
    inputSchema: { type: "object", properties: {} },
    annotations,
    execute: async () => "",
  };
}

test("read-only builtins classify as read", () => {
  for (const name of [
    "read",
    "ls",
    "grep",
    "memory_search",
    "kb_search",
    "kb_read",
    "kb_list",
    "kb_links",
    "web_search",
    "web_fetch",
    "list_agents",
    "inspect_agent",
    "dispatch_status",
    "pr_status",
    "repo_digest",
    "review_diff",
    "soul_read",
    "soul_history",
    "soul_diff",
    "npm_info",
  ]) {
    assert.equal(cat(name), "read", name);
  }
});

test("writes to Lisa's own home classify as self; social_compose is a draft", () => {
  for (const name of [
    "soul_patch",
    "soul_journal",
    "soul_feel",
    "desire_progress_log",
    "desire_revise",
    "desire_close",
    "kb_add",
    "kb_write",
    "kb_ingest",
    "set_mood",
  ]) {
    assert.equal(cat(name), "self", name);
  }
  assert.equal(cat("memory", { action: "append" }), "self");
  assert.equal(cat("memory", { action: "read" }), "read");
  assert.equal(cat("memory", {}), "self");
  assert.equal(cat("skill_manage", { action: "create" }), "self");
  assert.equal(cat("skill_manage", { action: "view" }), "read");
  assert.equal(cat("social_compose"), "draft");
});

test("file writes carry resolved paths and are sandboxed only inside a confined workspace", () => {
  const inside = classifyToolCall("write", { path: "src/a.ts", content: "x" }, undefined, sandboxedCtx);
  assert.equal(inside.category, "write");
  assert.deepEqual(inside.targets, ["/work/project/src/a.ts"]);
  assert.equal(inside.withinWorkspace, true);
  assert.equal(inside.sandboxed, true);

  const danger = classifyToolCall("edit", { path: "src/a.ts" }, undefined, dangerCtx);
  assert.equal(danger.withinWorkspace, true);
  assert.equal(danger.sandboxed, false);

  const outside = classifyToolCall("write", { path: "../../etc/passwd" }, undefined, sandboxedCtx);
  assert.equal(outside.withinWorkspace, false);
  assert.equal(outside.sandboxed, false);
  assert.deepEqual(outside.targets, ["/etc/passwd"]);

  const abs = classifyToolCall("write", { path: "/Users/x/.ssh/config" }, undefined, sandboxedCtx);
  assert.equal(abs.sandboxed, false);

  const patch = classifyToolCall(
    "apply_patch",
    { patches: [{ path: "a.ts" }, { path: "/tmp/b.ts" }] },
    undefined,
    sandboxedCtx,
  );
  assert.equal(patch.withinWorkspace, false, "one escaping path taints the whole patch");
  assert.equal(patch.sandboxed, false);

  // Malformed input never yields "inside the workspace".
  for (const bad of [{}, { path: 7 }, null, "x", { patches: [] }, { patches: [{}] }]) {
    const w = classifyToolCall("write", bad, undefined, sandboxedCtx);
    assert.equal(w.withinWorkspace, false);
    assert.equal(w.sandboxed, false);
    const p = classifyToolCall("apply_patch", bad, undefined, sandboxedCtx);
    assert.equal(p.sandboxed, false);
  }
});

test("a filesystem-root or relative workspace confines nothing", () => {
  assert.equal(isInsideWorkspace("/", "etc/passwd"), false);
  assert.equal(isInsideWorkspace("", "a"), false);
  assert.equal(isInsideWorkspace("relative/dir", "a"), false);
  assert.equal(isInsideWorkspace(WS, "a/../b"), true);
  assert.equal(isInsideWorkspace(WS, "/work/project-evil/x"), false);
});

test("exec tools: only bash is ever sandboxed", () => {
  const bash = classifyToolCall("bash", { command: "ls" }, undefined, sandboxedCtx);
  assert.equal(bash.category, "exec");
  assert.equal(bash.sandboxed, true);
  assert.equal(classifyToolCall("bash", { command: "ls" }, undefined, dangerCtx).sandboxed, false);
  for (const name of [
    "run_checks",
    "redeploy",
    "dispatch_agent",
    "run_on_plan",
    "compare_agents",
    "signal_agent",
    "task",
  ]) {
    const c = classifyToolCall(name, {}, undefined, sandboxedCtx);
    assert.equal(c.category, "exec", name);
    assert.equal(c.sandboxed, false, `${name} bypasses the capability seam`);
  }
  assert.equal(cat("scheduled_dispatch", { action: "list" }), "read");
  assert.equal(cat("scheduled_dispatch", { action: "add" }), "exec");
  assert.equal(cat("scheduled_dispatch", {}), "exec");
});

test("github: mutating actions publish, known reads read, unknown actions publish", () => {
  for (const action of DEFAULT_MUTATING_ACTIONS.github!) {
    assert.equal(cat("github", { action }), "publish", action);
  }
  for (const action of ["issue_list", "issue_view", "pr_view", "run_list", "run_view", "release_list"]) {
    assert.equal(cat("github", { action }), "read", action);
  }
  assert.equal(cat("github", { action: "repo_delete" }), "publish");
  assert.equal(cat("github", {}), "publish");
  const c = classifyToolCall("github", { action: "pr_merge", repo: "o/r" }, undefined, sandboxedCtx);
  assert.equal(c.method, "pr_merge");
  assert.deepEqual(c.targets, ["o/r"]);
});

test("takoapi is network; mcp config edits are writes", () => {
  const call = classifyToolCall("takoapi", { action: "call", agent: "x" }, undefined, sandboxedCtx);
  assert.equal(call.category, "network");
  assert.deepEqual(call.targets, ["takoapi:x"]);
  assert.equal(call.taintSource, true);
  assert.equal(cat("takoapi", { action: "discover" }), "read");
  assert.equal(cat("takoapi", {}), "network");
  assert.equal(cat("mcp", { action: "add" }), "write");
  assert.equal(cat("mcp", { action: "list" }), "read");
  assert.equal(cat("mcp", {}), "write");
});

test("mcp tools: annotations may lower to read, never further; mutating verbs win", () => {
  assert.equal(cat("mcp__gmail__search", {}, fakeTool("x", { readOnlyHint: true })), "read");
  assert.equal(cat("mcp__gmail__search", {}, fakeTool("x")), "write");
  assert.equal(cat("mcp__gmail__search", {}), "write", "no tool definition ⇒ no trust");
  assert.equal(cat("mcp__fs__wipe", {}, fakeTool("x", { destructiveHint: true })), "delete");
  // A server that labels its send tool read-only does not get a free pass.
  assert.equal(cat("mcp__gmail__send_email", {}, fakeTool("x", { readOnlyHint: true })), "send");
  assert.equal(cat("mcp__shop__checkout", {}, fakeTool("x", { readOnlyHint: true })), "purchase");
  assert.equal(cat("mcp__vault__get_password", {}, fakeTool("x", { readOnlyHint: true })), "credential");
  assert.equal(cat("mcp__x__post_tweet", {}, fakeTool("x")), "publish");
  // Nouns that merely contain a verb are not escalated.
  assert.equal(cat("mcp__gmail__list_messages", {}, fakeTool("x", { readOnlyHint: true })), "read");

  const c = classifyToolCall(
    "mcp__gmail__send_email",
    { to: "a@b.co", body: "hi" },
    fakeTool("x"),
    sandboxedCtx,
  );
  assert.equal(c.connector, "gmail");
  assert.deepEqual(c.targets, ["a@b.co"]);
  assert.equal(c.taintSource, true, "openWorldHint unset ⇒ taint source");
  const closed = classifyToolCall(
    "mcp__local__calc",
    {},
    fakeTool("x", { readOnlyHint: true, openWorldHint: false }),
    sandboxedCtx,
  );
  assert.equal(closed.taintSource, false);
  assert.deepEqual(closed.targets, ["mcp:local"]);
});

test("unknown tools are writes that ask, tightened by a mutating verb", () => {
  const c = classifyToolCall("brand_new_tool", { x: 1 }, undefined, sandboxedCtx);
  assert.equal(c.category, "write");
  assert.equal(c.sandboxed, false);
  assert.equal(c.withinWorkspace, false);
  assert.equal(cat("send_invoice"), "send");
  assert.equal(cat("delete_everything"), "delete");
  // A readOnlyHint on a non-MCP unknown tool is not honoured at all.
  assert.equal(cat("plugin_thing", {}, fakeTool("plugin_thing", { readOnlyHint: true })), "write");
});

test("taint sources", () => {
  for (const name of ["web_fetch", "web_search", "kb_ingest", "takoapi", "task"]) {
    assert.equal(classifyToolCall(name, {}, undefined, sandboxedCtx).taintSource, true, name);
  }
  for (const name of ["read", "grep", "write", "memory"]) {
    assert.equal(classifyToolCall(name, {}, undefined, sandboxedCtx).taintSource, false, name);
  }
  const net = (command: string) =>
    classifyToolCall("bash", { command }, undefined, sandboxedCtx).taintSource;
  assert.equal(net("curl https://example.com"), true);
  assert.equal(net("cd x && wget -q u"), true);
  assert.equal(net("git clone git@github.com:o/r"), true);
  assert.equal(net("ls -la"), false);
  assert.equal(net("npm test"), false);
});

test("web_fetch targets the hostname and is egress", () => {
  const c = classifyToolCall("web_fetch", { url: "https://Example.com/a?b=1" }, undefined, sandboxedCtx);
  assert.deepEqual(c.targets, ["example.com"]);
  assert.equal(c.egress, true);
  assert.deepEqual(
    classifyToolCall("web_fetch", { url: "not a url" }, undefined, sandboxedCtx).targets,
    ["web_fetch"],
  );
});

test("every builtin in the registry has an explicit table entry", () => {
  const names = buildToolRegistry({ includeVoice: true }).map((t) => t.name);
  const missing = names.filter((name) => !isKnownBuiltin(name));
  assert.deepEqual(missing, [], "add new builtins to src/warden/classify.ts");
});

test("every tool the legacy gates treat as mutating is side-effecting for Warden", () => {
  const benign = new Set<ActionCategory>(["read", "self", "draft"]);
  for (const name of DEFAULT_MUTATING_TOOLS) {
    assert.equal(benign.has(cat(name, {})), false, name);
  }
  for (const name of AUTONOMOUS_BLOCKED_TOOL_NAMES) {
    if (name === "social_compose") continue; // a draft: publishing is a separate, digest-bound approval
    const category = cat(name, {});
    assert.equal(benign.has(category), false, `${name} → ${category}`);
  }
});

test("digest is canonical and payload-bound", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(payloadDigest("t", { a: 1, b: 2 }), payloadDigest("t", { b: 2, a: 1 }));
  assert.notEqual(payloadDigest("t", { a: 1 }), payloadDigest("t", { a: 2 }));
  assert.notEqual(payloadDigest("t", { a: 1 }), payloadDigest("u", { a: 1 }));
  assert.match(payloadDigest("t", undefined), /^[0-9a-f]{64}$/);
});

test("preview never shows bodies or credentials and is bounded", () => {
  const secret = "sk-ant-api03-PLANTEDSECRETVALUE1234567890";
  const preview = redactedPreview("mcp__gmail__send_email", {
    to: "alice@example.com",
    subject: "hello",
    body: "the launch code is 0000 " + "x".repeat(5000),
    api_key: secret,
    note: `use ${secret} please`,
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.ok(preview.length <= 240);
  assert.equal(preview.includes(secret), false);
  assert.equal(preview.includes("launch code"), false);
  assert.match(preview, /body=<\d+ chars>/);
  assert.match(preview, /subject="hello"/);

  const bash = redactedPreview("bash", {
    command: `curl -H "Authorization: Bearer ${secret}" https://x.test --data password=hunter2`,
  });
  assert.equal(bash.includes(secret), false);
  assert.equal(bash.includes("hunter2"), false);
  assert.ok(redactedPreview("write", { path: "a", content: "y".repeat(10_000) }).length <= 240);
});

test("data classes are detected deterministically", () => {
  assert.deepEqual(detectDataClasses({ to: "bob@example.org" }), ["pii"]);
  assert.deepEqual(detectDataClasses({ text: "call +1 (415) 555-0100" }), ["pii"]);
  assert.deepEqual(detectDataClasses({ token: "abc123def456" }), ["secret"]);
  assert.deepEqual(detectDataClasses({ t: "ghp_abcdefghijklmnopqrstuvwxyz0123" }), ["secret"]);
  assert.deepEqual(detectDataClasses({ card: "4242 4242 4242 4242" }), ["financial"]);
  assert.deepEqual(detectDataClasses({ when: "2026-10-02 18:56:01", n: 12 }), []);
  assert.deepEqual(
    detectDataClasses({ url: "https://github.com/o/r/commit/0123456789abcdef0123456789abcdef01234567" }),
    [],
  );
  assert.deepEqual(detectDataClasses({}, ["health"]), ["health"]);
});

test("audit targets mask recipients", () => {
  const [masked] = auditTargets(["Alice.Smith@example.com"]);
  assert.match(masked!, /^[0-9a-f]{8}@example\.com$/);
  assert.deepEqual(auditTargets(["example.com", "/work/a.ts"]), ["example.com", "/work/a.ts"]);
});
