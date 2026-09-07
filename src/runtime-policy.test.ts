import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildNonInteractiveApprovalCallback,
  buildRuntimePolicy,
  describeRuntimePolicy,
  type RuntimePolicyArgs,
} from "./runtime-policy.js";
import { DEFAULT_MUTATING_ACTIONS, DEFAULT_MUTATING_TOOLS } from "./approval.js";

/** Parsed-args defaults, as src/cli-args.ts produces them. */
const ARGS: RuntimePolicyArgs = {
  reflect: true,
  thinking: false,
  compaction: false,
  approval: "auto",
};

const MAC = { LISA_EDITION: "mac", LISA_SANDBOX_MODE: "danger-full-access" };
const CLOUD = { LISA_EDITION: "cloud", LISA_SANDBOX_MODE: "danger-full-access" };

describe("buildRuntimePolicy — the three surfaces", () => {
  test("cli: no scheduled reflection, local-owner capabilities", () => {
    const p = buildRuntimePolicy({ ...ARGS, subcommand: "chat" }, MAC);
    assert.deepEqual(p, {
      surface: "cli",
      // The REPL drives its own reflection; a server heartbeat isn't running.
      reflection: "manual",
      compaction: false,
      approval: "auto",
      thinking: false,
      capabilities: "local-owner",
      sandboxMode: "danger-full-access",
    });
  });

  test("local-web: the only surface with a scheduled reflection heartbeat", () => {
    const p = buildRuntimePolicy({ ...ARGS, subcommand: "serve", serveWeb: true }, MAC);
    assert.deepEqual(p, {
      surface: "local-web",
      reflection: "scheduled",
      compaction: false,
      approval: "auto",
      thinking: false,
      capabilities: "local-owner",
      sandboxMode: "danger-full-access",
    });
  });

  test("cloud: cloud-chat capabilities and NO background reflection", () => {
    const p = buildRuntimePolicy({ ...ARGS, subcommand: "serve", serveWeb: true }, CLOUD);
    assert.deepEqual(p, {
      surface: "cloud",
      // The heartbeat reflects the process-level chat, which on a multi-tenant
      // server belongs to no signed-in user — an unmetered model call.
      reflection: "manual",
      compaction: false,
      approval: "auto",
      thinking: false,
      capabilities: "cloud-chat",
      sandboxMode: "danger-full-access",
    });
  });

  test("the cloud edition wins even for a plain `lisa chat` invocation", () => {
    assert.equal(buildRuntimePolicy({ ...ARGS, subcommand: "chat" }, CLOUD).surface, "cloud");
  });
});

describe("buildRuntimePolicy — flags actually change the policy", () => {
  test("--no-reflect turns reflection off on every surface", () => {
    for (const env of [MAC, CLOUD]) {
      const p = buildRuntimePolicy({ ...ARGS, subcommand: "serve", serveWeb: true, reflect: false }, env);
      assert.equal(p.reflection, "off", JSON.stringify(env));
    }
  });

  test("--think / --compact / --approval flow through", () => {
    const p = buildRuntimePolicy(
      { ...ARGS, subcommand: "serve", serveWeb: true, thinking: true, compaction: true, approval: "ask-mutating" },
      MAC,
    );
    assert.equal(p.thinking, true);
    assert.equal(p.compaction, true);
    assert.equal(p.approval, "ask-mutating");
  });

  test("--sandbox beats LISA_SANDBOX_MODE", () => {
    const p = buildRuntimePolicy({ ...ARGS, sandbox: "read-only" }, { ...MAC, LISA_SANDBOX_MODE: "workspace-write" });
    assert.equal(p.sandboxMode, "read-only");
  });

  test("describeRuntimePolicy prints every field for the startup banner", () => {
    const line = describeRuntimePolicy(buildRuntimePolicy({ ...ARGS, subcommand: "serve", serveWeb: true }, MAC));
    assert.equal(
      line,
      "surface=local-web reflection=scheduled approval=auto thinking=off compaction=off " +
        "capabilities=local-owner sandbox=danger-full-access",
    );
  });
});

describe("non-interactive approval callback", () => {
  const cfg = (mode: "auto" | "ask" | "ask-mutating") => ({
    mode,
    mutatingTools: DEFAULT_MUTATING_TOOLS,
    mutatingActions: DEFAULT_MUTATING_ACTIONS,
  });

  test("auto ⇒ no callback at all (the fast path is untouched)", () => {
    assert.equal(buildNonInteractiveApprovalCallback(cfg("auto"), () => {}), undefined);
  });

  test("ask denies everything, because a server has no terminal to prompt at", async () => {
    const logs: string[] = [];
    const cb = buildNonInteractiveApprovalCallback(cfg("ask"), (m) => logs.push(m))!;
    const d = await cb("read", { path: "/etc/hosts" });
    assert.equal(d.allow, false);
    assert.match(d.reason!, /no interactive approver/);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /\[approval\] denied read — mode=ask/);
  });

  test("the audit line never carries the tool input", async () => {
    const logs: string[] = [];
    const cb = buildNonInteractiveApprovalCallback(cfg("ask"), (m) => logs.push(m))!;
    await cb("write", { path: "/tmp/x", content: "sk-secret-token-value" });
    assert.equal(logs.join("\n").includes("sk-secret-token-value"), false);
  });

  test("ask-mutating allows reads and denies writes, using the CLI's own classifier", async () => {
    const cb = buildNonInteractiveApprovalCallback(cfg("ask-mutating"), () => {})!;
    assert.deepEqual(await cb("read", { path: "/x" }), { allow: true });
    assert.deepEqual(await cb("memory_search", { q: "x" }), { allow: true });
    assert.equal((await cb("bash", { cmd: "rm -rf /" })).allow, false);
    assert.equal((await cb("write", { path: "/x" })).allow, false);
    // Action-dispatched tools follow the same per-action table as the CLI.
    assert.deepEqual(await cb("github", { action: "issue_view" }), { allow: true });
    assert.equal((await cb("github", { action: "issue_create" })).allow, false);
  });
});
