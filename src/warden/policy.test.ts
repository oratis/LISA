import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultBehavior, envelopeCovers, evaluate, type PolicyContext } from "./policy.js";
import { defaultRules, parseRules } from "./rules.js";
import { grantsFor } from "./grants.js";
import { buildActionRequest } from "./request.js";
import {
  ACTION_CATEGORIES,
  ORIGIN_KINDS,
  type ActionCategory,
  type ActionRequest,
  type OriginKind,
  type RuntimeSurface,
  type Verdict,
} from "./types.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");

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

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return { rules: defaultRules(), grants: [], now: NOW, ...over };
}

function verdict(r: Partial<ActionRequest>, c: Partial<PolicyContext> = {}): Verdict {
  return evaluate(req(r), ctx(c)).verdict;
}

const SIDE_EFFECTING: ActionCategory[] = ["write", "exec", "network", "send", "publish", "delete"];

test("read, self and draft are allowed for every origin, surface and taint state", () => {
  for (const category of ["read", "self", "draft"] as const) {
    for (const kind of ORIGIN_KINDS) {
      for (const surface of ["cli", "local-web", "cloud"] as RuntimeSurface[]) {
        for (const tainted of [false, true]) {
          assert.equal(
            verdict({ category, origin: { kind }, surface, tainted, tool: "read" }),
            "allow",
            `${category}/${kind}/${surface}/${tainted}`,
          );
        }
      }
    }
  }
});

test("default matrix: interactive chat", () => {
  const chat = { origin: { kind: "chat" as const } };
  assert.equal(verdict({ ...chat, category: "write", sandboxed: true, withinWorkspace: true }), "allow");
  assert.equal(verdict({ ...chat, category: "write", sandboxed: false, withinWorkspace: false }), "ask");
  assert.equal(verdict({ ...chat, category: "exec", sandboxed: true }), "allow");
  assert.equal(verdict({ ...chat, category: "exec", sandboxed: false }), "allow", "local owner, danger-full-access");
  assert.equal(verdict({ ...chat, category: "write", sandboxed: false, withinWorkspace: true }), "allow");
  assert.equal(verdict({ ...chat, category: "network" }), "allow");
  for (const category of ["send", "publish", "delete"] as const) {
    assert.equal(verdict({ ...chat, category }), "ask", category);
  }
  for (const category of ["purchase", "credential"] as const) {
    assert.equal(verdict({ ...chat, category }), "handoff", category);
  }
});

test("taint flips write, exec and network to ask in chat", () => {
  const tainted = { origin: { kind: "chat" as const }, tainted: true };
  assert.equal(verdict({ ...tainted, category: "write", sandboxed: true, withinWorkspace: true }), "ask");
  assert.equal(verdict({ ...tainted, category: "write", sandboxed: false, withinWorkspace: true }), "ask");
  assert.equal(verdict({ ...tainted, category: "exec", sandboxed: true }), "ask");
  assert.equal(verdict({ ...tainted, category: "exec", sandboxed: false }), "ask");
  assert.equal(verdict({ ...tainted, category: "network" }), "ask");
  assert.equal(verdict({ ...tainted, category: "send" }), "ask");
  assert.equal(evaluate(req({ ...tainted, category: "exec" }), ctx()).ruleId, "system:tainted-run");
});

test("default matrix: task / routine / watcher need the envelope", () => {
  for (const kind of ["task", "routine", "watcher"] as const) {
    const o = { origin: { kind }, taskId: "t1" };
    assert.equal(verdict({ ...o, category: "write", sandboxed: true, withinWorkspace: true }), "ask", kind);
    assert.equal(verdict({ ...o, category: "exec", sandboxed: true }), "ask");
    assert.equal(verdict({ ...o, category: "exec", sandboxed: false }), "ask");
    assert.equal(verdict({ ...o, category: "write", sandboxed: false, withinWorkspace: true }), "ask");
    assert.equal(verdict({ ...o, category: "network" }), "ask");
    assert.equal(verdict({ ...o, category: "send" }), "ask");

    const envelope = { categories: ["write", "exec", "network", "send"] as ActionCategory[] };
    assert.equal(verdict({ ...o, category: "write", sandboxed: true, withinWorkspace: true }, { envelope }), "allow");
    assert.equal(verdict({ ...o, category: "exec", sandboxed: true }, { envelope }), "allow");
    assert.equal(verdict({ ...o, category: "network" }, { envelope }), "allow");
    assert.equal(verdict({ ...o, category: "send" }, { envelope }), "allow");
    // The envelope satisfies "preapproved" only — never an "ask" default.
    assert.equal(verdict({ ...o, category: "exec", sandboxed: false }, { envelope }), "ask");
    assert.equal(verdict({ ...o, category: "write", sandboxed: false, withinWorkspace: false }, { envelope }), "ask");
    assert.equal(verdict({ ...o, category: "purchase" }, { envelope: { categories: ["purchase"] } }), "handoff");
  }
});

test("a tainted task may only reach off-host targets its envelope named", () => {
  const o = { origin: { kind: "task" as const }, taskId: "t1", tainted: true };
  const loose = { categories: ["network", "write"] as ActionCategory[] };
  assert.equal(verdict({ ...o, category: "network", targets: ["evil.test"] }, { envelope: loose }), "ask");
  assert.equal(verdict({ ...o, category: "write", sandboxed: true, withinWorkspace: true }, { envelope: loose }), "allow");
  const named = { categories: ["network"] as ActionCategory[], targets: ["api.good.test"] };
  assert.equal(verdict({ ...o, category: "network", targets: ["api.good.test"] }, { envelope: named }), "allow");
  assert.equal(verdict({ ...o, category: "network", targets: ["evil.test"] }, { envelope: named }), "ask");
  assert.equal(verdict({ ...o, category: "network", targets: [] }, { envelope: named }), "ask");
  assert.equal(envelopeCovers(req({ category: "exec" }), undefined), false);
  assert.equal(envelopeCovers(req({ category: "exec" }), {}), false);
});

test("default matrix: channel and mcp origins ask for every side effect", () => {
  for (const kind of ["channel", "mcp"] as const) {
    for (const category of SIDE_EFFECTING) {
      for (const sandboxed of [true, false]) {
        assert.equal(
          verdict({ origin: { kind }, category, sandboxed, withinWorkspace: true }),
          "ask",
          `${kind}/${category}/${sandboxed}`,
        );
      }
    }
  }
});

test("invariant: autonomy is read-only — everything but read/self/draft is denied", () => {
  for (const category of ACTION_CATEGORIES) {
    const v = verdict({ origin: { kind: "autonomy" }, category, sandboxed: true, withinWorkspace: true });
    if (category === "read" || category === "self" || category === "draft") assert.equal(v, "allow");
    else assert.equal(v, "deny", category);
  }
});

test("invariant: autonomy cannot be unlocked by grants, rules or envelopes, and never asks", () => {
  const r = req({ origin: { kind: "autonomy" }, category: "exec", sandboxed: true });
  const grants = grantsFor({ ...r, origin: { kind: "autonomy" } }, "always", NOW);
  const rules = parseRules({ categories: { exec: "auto" }, tools: { bash: "auto" } });
  const result = evaluate(r, ctx({ grants, rules, envelope: { categories: ["exec"] } }));
  assert.equal(result.verdict, "deny");
  assert.equal(result.ruleId, "system:autonomy-read-only");
  // A read that would otherwise ASK (secret in an outbound URL) is denied, not queued.
  const leak = req({
    origin: { kind: "autonomy" },
    tool: "web_fetch",
    category: "read",
    egress: true,
    targets: ["evil.test"],
    dataClasses: ["secret"],
  });
  assert.equal(evaluate(leak, ctx()).verdict, "deny");
});

test("invariant: purchase and credential hand off everywhere, whatever rules and grants say", () => {
  for (const category of ["purchase", "credential"] as const) {
    for (const kind of ORIGIN_KINDS.filter((k) => k !== "autonomy")) {
      for (const surface of ["cli", "local-web", "cloud"] as RuntimeSurface[]) {
        const r = req({ category, origin: { kind }, surface, tool: "mcp__shop__checkout" });
        const grants = grantsFor(r, "always", NOW);
        const result = evaluate(r, ctx({ grants, envelope: { categories: [category] } }));
        assert.equal(result.verdict, "handoff", `${category}/${kind}/${surface}`);
        assert.equal(result.ruleId, `system:handoff-${category}`);
      }
    }
  }
  assert.throws(() => parseRules({ categories: { purchase: "auto" } }), /fixed/);
  assert.throws(() => parseRules({ categories: { credential: "ask" } }), /fixed/);
  assert.doesNotThrow(() => parseRules({ categories: { purchase: "handoff" } }));
});

test("invariant: cloud never allows exec or host writes", () => {
  for (const kind of ["chat", "task", "channel"] as OriginKind[]) {
    for (const category of ["exec", "write"] as const) {
      const r = req({ surface: "cloud", uid: "u1", category, origin: { kind }, sandboxed: true, withinWorkspace: true });
      const grants = grantsFor(r, "always", NOW);
      const rules = parseRules({ categories: { exec: "auto", write: "auto" } });
      const result = evaluate(r, ctx({ grants, rules, envelope: { categories: [category] } }));
      assert.equal(result.verdict, "deny", `${category}/${kind}`);
      assert.match(result.ruleId ?? "", /^system:cloud-no-/);
    }
  }
  // A connector write is not a host write: it goes through the normal ask path.
  assert.equal(
    verdict({ surface: "cloud", uid: "u1", category: "write", connector: "notion", tool: "mcp__notion__update" }),
    "ask",
  );
});

test("invariant: Warden's own state files cannot be written by a tool call", () => {
  const protectedPaths = ["/home/lisa/warden"];
  const r = req({
    tool: "write",
    category: "write",
    targets: ["/home/lisa/warden/grants.json"],
    sandboxed: true,
    withinWorkspace: true,
  });
  const result = evaluate(r, ctx({ protectedPaths, grants: grantsFor(r, "always", NOW) }));
  assert.equal(result.verdict, "deny");
  assert.equal(result.ruleId, "system:warden-state-protected");
  assert.equal(
    verdict({ ...r, targets: ["/home/lisa/warden-notes/a.md"] }, { protectedPaths }),
    "allow",
    "sibling directory is not protected",
  );
});

test("new-recipient rule: sensitive data to an unapproved recipient always asks", () => {
  const send = req({
    tool: "mcp__gmail__send_email",
    category: "send",
    targets: ["new@stranger.test"],
    dataClasses: ["pii"],
    egress: true,
  });
  // A blanket grant, a 24h grant, an "auto" rule and an envelope do NOT cover it.
  const blanket = [...grantsFor(send, "always", NOW), ...grantsFor(send, "24h", NOW)];
  const rules = parseRules({ categories: { send: "auto" } });
  const result = evaluate(send, ctx({ grants: blanket, rules, envelope: { categories: ["send"] } }));
  assert.equal(result.verdict, "ask");
  assert.equal(result.ruleId, "system:new-recipient-sensitive-data");

  // A grant bound to that recipient does.
  const bound = grantsFor(send, "target", NOW);
  assert.equal(evaluate(send, ctx({ grants: bound })).verdict, "allow");
  // …but not for an additional, unseen recipient.
  const two = { ...send, targets: ["new@stranger.test", "other@stranger.test"] };
  assert.equal(evaluate(two, ctx({ grants: bound })).verdict, "ask");
  // No recipient at all is never "seen".
  assert.equal(evaluate({ ...send, targets: [] }, ctx({ grants: blanket })).verdict, "ask");
  // The exact payload the user approved once is fine.
  assert.equal(evaluate(send, ctx({ grants: grantsFor(send, "once", NOW) })).verdict, "allow");

  for (const dataClass of ["pii", "secret", "private-message"] as const) {
    for (const category of ["send", "publish", "network"] as const) {
      assert.equal(
        verdict({ category, dataClasses: [dataClass], targets: ["x.test"], tool: "t" }, { rules: parseRules({ categories: { [category]: "auto" } }) }),
        "ask",
        `${dataClass}/${category}`,
      );
    }
  }
  // Without sensitive data the same blanket grant is honoured.
  assert.equal(evaluate({ ...send, dataClasses: [] }, ctx({ grants: blanket })).verdict, "allow");
});

test("a credential in an outbound read (exfiltration shape) asks; plain PII lookups do not", () => {
  const fetch = { tool: "web_fetch", category: "read" as const, egress: true, targets: ["evil.test"] };
  assert.equal(verdict({ ...fetch, dataClasses: ["secret"] }), "ask");
  assert.equal(verdict({ ...fetch, dataClasses: ["pii"] }), "allow");
  assert.equal(verdict({ tool: "memory", category: "self", dataClasses: ["secret"] }), "allow", "not off-host");
});

test("user rules: tighten freely, loosen only within the floors", () => {
  const strict = parseRules({ categories: { exec: "ask", read: "ask" }, tools: { web_fetch: "handoff" } });
  assert.equal(verdict({ category: "exec", sandboxed: true }, { rules: strict }), "ask");
  assert.equal(verdict({ category: "read", tool: "read" }, { rules: strict }), "ask");
  assert.equal(verdict({ category: "read", tool: "web_fetch" }, { rules: strict }), "handoff");

  const loose = parseRules({ categories: { exec: "auto", send: "auto", write: "auto" } });
  assert.equal(verdict({ category: "send" }, { rules: loose }), "allow");
  assert.equal(verdict({ category: "write", withinWorkspace: false }, { rules: loose }), "allow");
  // …but never past taint, a remote origin, or the system invariants.
  assert.equal(verdict({ category: "send", tainted: true }, { rules: loose }), "ask");
  assert.equal(verdict({ category: "exec", tainted: true }, { rules: loose }), "ask");
  assert.equal(verdict({ category: "exec", origin: { kind: "channel" } }, { rules: loose }), "ask");
  assert.equal(verdict({ category: "exec", origin: { kind: "autonomy" } }, { rules: loose }), "deny");
  assert.equal(verdict({ category: "exec", surface: "cloud" }, { rules: loose }), "deny");
  // A tainted task with an "auto" rule still needs its envelope.
  const task = { category: "exec" as const, origin: { kind: "task" as const }, tainted: true, sandboxed: true };
  assert.equal(verdict(task, { rules: loose }), "ask");
  assert.equal(verdict(task, { rules: loose, envelope: { categories: ["exec"] } }), "allow");

  // target override beats tool override beats category; strictest target wins.
  const layered = parseRules({
    categories: { publish: "auto" },
    tools: { github: "ask" },
    targets: { "o/prod": "handoff", "o/play": "auto" },
  });
  assert.equal(verdict({ tool: "github", category: "publish", targets: ["o/other"] }, { rules: layered }), "ask");
  assert.equal(verdict({ tool: "github", category: "publish", targets: ["o/play"] }, { rules: layered }), "allow");
  assert.equal(verdict({ tool: "github", category: "publish", targets: ["o/play", "o/prod"] }, { rules: layered }), "handoff");
  assert.equal(verdict({ tool: "other", category: "publish" }, { rules: layered }), "allow");
});

test("a corrupt rules file floors every side effect at ask", () => {
  for (const category of SIDE_EFFECTING) {
    const result = evaluate(
      req({ category, sandboxed: true, withinWorkspace: true }),
      ctx({ rulesCorrupt: true }),
    );
    assert.equal(result.verdict, "ask", category);
  }
  assert.equal(verdict({ category: "read", tool: "read" }, { rulesCorrupt: true }), "allow");
  assert.equal(verdict({ category: "purchase" }, { rulesCorrupt: true }), "handoff");
});

test("grants: exact match on tool, category, method, column and scope binding", () => {
  const r = req({ tool: "github", category: "publish", method: "pr_comment", targets: ["o/r"], taskId: "t1" });
  const always = grantsFor(r, "always", NOW);
  const allowed = evaluate(r, ctx({ grants: always }));
  assert.equal(allowed.verdict, "allow");
  assert.equal(allowed.grantId, always[0]!.id);
  assert.deepEqual(allowed.grantIds, [always[0]!.id]);
  // Different method, tool or category: no match.
  assert.equal(evaluate({ ...r, method: "pr_merge" }, ctx({ grants: always })).verdict, "ask");
  assert.equal(evaluate({ ...r, tool: "gitlab" }, ctx({ grants: always })).verdict, "ask");
  assert.equal(evaluate({ ...r, category: "delete" }, ctx({ grants: always })).verdict, "ask");
  // A grant approved in chat is not standing permission for a remote channel or a task.
  assert.equal(evaluate({ ...r, origin: { kind: "channel" } }, ctx({ grants: always })).verdict, "ask");
  assert.equal(evaluate({ ...r, origin: { kind: "task" } }, ctx({ grants: always })).verdict, "ask");

  // once: bound to the digest.
  const once = grantsFor(r, "once", NOW);
  assert.equal(evaluate(r, ctx({ grants: once })).verdict, "allow");
  assert.equal(evaluate({ ...r, digest: "e".repeat(64) }, ctx({ grants: once })).verdict, "ask");
  // task: bound to the task id.
  const taskReq = { ...r, origin: { kind: "task" as const } };
  const task = grantsFor(taskReq, "task", NOW);
  assert.equal(evaluate(taskReq, ctx({ grants: task })).verdict, "allow");
  assert.equal(evaluate({ ...taskReq, taskId: "t2" }, ctx({ grants: task })).verdict, "ask");
  assert.equal(evaluate({ ...taskReq, taskId: undefined }, ctx({ grants: task })).verdict, "ask");
  // target: bound to the target.
  const target = grantsFor(r, "target", NOW);
  assert.equal(evaluate(r, ctx({ grants: target })).verdict, "allow");
  assert.equal(evaluate({ ...r, targets: ["o/other"] }, ctx({ grants: target })).verdict, "ask");
  // 24h: expires.
  const day = grantsFor(r, "24h", NOW);
  assert.equal(evaluate(r, ctx({ grants: day })).verdict, "allow");
  assert.equal(evaluate(r, ctx({ grants: day, now: NOW + 24 * 3600_000 })).verdict, "ask");
  assert.equal(evaluate(r, ctx({ grants: day, now: NOW + 24 * 3600_000 - 1 })).verdict, "allow");
});

test("no unlisted tool is ever auto-allowed, whatever it is called", () => {
  const names = [
    "deploy_widget",
    "run_shell",
    "exec_command",
    "bash2",
    "write_file",
    "read_secrets",
    "totally_harmless",
    "mcp__srv__exec",
    "mcp__srv__anything",
    "send_it",
    "",
  ];
  for (const sandboxMode of ["danger-full-access", "workspace-write", "read-only"] as const) {
    for (const name of names) {
      const { req: built } = buildActionRequest(name, { path: "a.ts", command: "ls" }, undefined, {
        uid: null,
        surface: "local-web",
        origin: { kind: "chat" },
        workspaceRoot: "/work/project",
        sandboxMode,
        tainted: false,
      });
      assert.notEqual(evaluate(built, ctx()).verdict, "allow", `${name} under ${sandboxMode}`);
    }
  }
});

test("defaultBehavior never returns auto for an unrecognised category", () => {
  const odd = req({ category: "teleport" as unknown as ActionCategory });
  assert.equal(defaultBehavior(odd), "ask");
  assert.equal(evaluate(odd, ctx()).verdict, "ask");
});
