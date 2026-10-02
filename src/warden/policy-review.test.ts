/**
 * Regression tests for the adversarial review of PR #402. Each test is named
 * for the finding it closes and fails on the reviewed commit (29b21a5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type PolicyContext } from "./policy.js";
import { defaultRules, ownBehavior, parseRules, strictness } from "./rules.js";
import { buildActionRequest } from "./request.js";
import type { ActionRequest } from "./types.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const PROTO_KEYS = ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"];

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return { rules: defaultRules(), grants: [], now: NOW, ...over };
}

function req(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: "act_1",
    at: new Date(NOW).toISOString(),
    uid: null,
    surface: "local-web",
    origin: { kind: "chat" },
    tool: "bash",
    category: "exec",
    targets: [],
    dataClasses: [],
    digest: "d".repeat(64),
    preview: "bash()",
    sandboxed: false,
    tainted: false,
    ...over,
  };
}

function built(name: string, input: unknown, over: Record<string, unknown> = {}): ActionRequest {
  return buildActionRequest(name, input, undefined, {
    uid: null,
    surface: "local-web",
    origin: { kind: "chat" },
    workspaceRoot: "/work/project",
    sandboxMode: "danger-full-access",
    tainted: false,
    ...over,
  }).req;
}

test("review 1: a target or tool named like an Object.prototype member never turns ask into allow", () => {
  for (const key of PROTO_KEYS) {
    assert.equal(
      evaluate(built("github", { action: "pr_merge", number: 7, repo: key }), ctx()).verdict,
      "ask",
      `github repo=${key}`,
    );
    assert.equal(
      evaluate(built("github", { action: "pr_merge", number: 7, cwd: key }), ctx()).verdict,
      "ask",
      `github cwd=${key}`,
    );
    assert.notEqual(
      evaluate(built("some_plugin_tool", { path: key }), ctx()).verdict,
      "allow",
      `unknown tool path=${key}`,
    );
    assert.notEqual(evaluate(built(key, {}), ctx()).verdict, "allow", `tool named ${key}`);
  }
});

test("review 1: prototype keys cannot bypass an explicit user rule either", () => {
  const rules = parseRules({
    categories: { publish: "handoff", exec: "ask", delete: "handoff" },
    tools: { bash: "ask" },
  });
  for (const key of PROTO_KEYS) {
    assert.equal(
      evaluate(built("bash", { command: "rm -rf ~/x", cwd: key }), ctx({ rules })).verdict,
      "ask",
      key,
    );
    assert.equal(
      evaluate(built("github", { action: "pr_merge", number: 1, cwd: key }), ctx({ rules }))
        .verdict,
      "handoff",
      key,
    );
    assert.equal(
      evaluate(built("mcp__gdrive__delete_file", { file_id: "1", path: key }), ctx({ rules }))
        .verdict,
      "handoff",
      key,
    );
    assert.notEqual(
      evaluate(built("dispatch_agent", { agent: key, task: "x" }), ctx({ rules })).verdict,
      "allow",
      key,
    );
  }
});

test("review 1: strictness of anything that is not a behaviour is ask, never below auto", () => {
  const ask = strictness("ask");
  for (const junk of [undefined, null, "", "allow", "AUTO", 0, {}, Object.prototype.toString]) {
    assert.equal(strictness(junk), ask, String(junk));
  }
  assert.ok(strictness("auto") < strictness("preapproved"));
  assert.ok(strictness("preapproved") < ask);
  assert.ok(ask < strictness("handoff"));
});

test("review 1: rule maps are read by own property only, and store odd keys as data", () => {
  const rules = parseRules(
    JSON.parse(
      '{"tools":{"__proto__":"handoff","constructor":"ask"},"targets":{"toString":"handoff"}}',
    ),
  );
  assert.equal(ownBehavior(rules.tools, "__proto__"), "handoff");
  assert.equal(ownBehavior(rules.tools, "constructor"), "ask");
  assert.equal(ownBehavior(rules.tools, "valueOf"), undefined);
  assert.equal(ownBehavior(rules.targets, "toString"), "handoff");
  assert.equal(ownBehavior(rules.categories, "constructor"), undefined);
  assert.equal(ownBehavior({ x: "allow-everything" }, "x"), undefined, "not a behaviour");
  assert.equal(ownBehavior(undefined, "x"), undefined);
  assert.equal(evaluate(built("__proto__", {}), ctx({ rules })).verdict, "handoff");
  assert.throws(() => parseRules({ tools: { bash: "constructor" } }), /invalid behavior/);
});

test("review 12: a target rule loosens only when EVERY target has a rule", () => {
  const rules = parseRules({ categories: { publish: "handoff" }, targets: { "#team": "auto" } });
  const post = (channel: string[]) =>
    req({ tool: "mcp__slack__post_message", category: "publish", targets: channel });
  assert.equal(evaluate(post(["#team"]), ctx({ rules })).verdict, "allow");
  const mixed = evaluate(post(["#team", "#public-announce"]), ctx({ rules }));
  assert.equal(mixed.verdict, "handoff");
  assert.equal(mixed.ruleId, "rule:category:publish");
  // With no tool/category rule, the default (ask) applies to the uncovered recipient.
  const targetsOnly = parseRules({ targets: { "#team": "auto" } });
  assert.equal(evaluate(post(["#team", "#other"]), ctx({ rules: targetsOnly })).verdict, "ask");
  // Partial coverage: the stricter of the tool and the category rule.
  const both = parseRules({
    categories: { publish: "ask" },
    tools: { mcp__slack__post_message: "auto" },
    targets: { "#team": "auto" },
  });
  assert.equal(evaluate(post(["#team", "#other"]), ctx({ rules: both })).verdict, "ask");
  assert.equal(evaluate(post(["#other"]), ctx({ rules: both })).verdict, "allow", "tool rule");
  // A strict rule on one recipient still tightens the whole request.
  const strict = parseRules({ categories: { publish: "auto" }, targets: { "#ceo": "handoff" } });
  assert.equal(evaluate(post(["#ceo", "#other"]), ctx({ rules: strict })).verdict, "handoff");
  // An incomplete target list is never "fully covered".
  assert.equal(
    evaluate({ ...post(["#team"]), targetsComplete: false }, ctx({ rules })).verdict,
    "handoff",
  );
});
