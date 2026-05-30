import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OrchestratorHub, loadOrchestratorConfig, DEFAULT_ORCHESTRATOR_CONFIG } from "./hub.js";
import { registerIntegration, _resetIntegrationsForTest } from "./registry.js";
import type { AgentObserver, AgentSession } from "./types.js";

afterEach(() => _resetIntegrationsForTest());

/** A controllable fake observer for hub tests. */
function makeFake(agent: string, sessions: AgentSession[]) {
  let emitFn: ((s: AgentSession) => void) | null = null;
  const obs: AgentObserver = {
    agent,
    async start(emit) {
      emitFn = emit;
    },
    list: () => sessions,
    async stop() {},
  };
  return { obs, push: (s: AgentSession) => emitFn?.(s) };
}

function session(
  agent: string,
  id: string,
  mtime: number,
  state: AgentSession["state"] = "working",
): AgentSession {
  return { agent, sessionId: id, project: id, state, stateReason: "x", lastMtime: mtime };
}

// All hubs in these tests pass registerBuiltins:false so start() uses ONLY
// the fakes we register, not the real claude-code adapter (which would
// clobber a fake registered under the same name).
const NO_BUILTINS = { registerBuiltins: false };

describe("OrchestratorHub", () => {
  test("merges + sorts sessions from multiple observers, newest first", async () => {
    const a = makeFake("claude-code", [session("claude-code", "c1", 100), session("claude-code", "c2", 300)]);
    const b = makeFake("codex", [session("codex", "x1", 200)]);
    registerIntegration("claude-code", () => a.obs);
    registerIntegration("codex", () => b.obs);

    const hub = new OrchestratorHub(
      { integrations: { "claude-code": { enabled: true }, codex: { enabled: true } }, visibility: "activity" },
      NO_BUILTINS,
    );
    await hub.start();

    const ids = hub.list().map((s) => s.sessionId);
    assert.deepEqual(ids, ["c2", "x1", "c1"], "sorted by lastMtime desc across agents");
  });

  test("re-emits observer updates as hub 'update' events", async () => {
    const a = makeFake("claude-code", []);
    registerIntegration("claude-code", () => a.obs);
    const hub = new OrchestratorHub({ integrations: { "claude-code": {} }, visibility: "metadata" }, NO_BUILTINS);
    const seen: AgentSession[] = [];
    hub.on("update", (s) => seen.push(s));
    await hub.start();

    a.push(session("claude-code", "c9", 999, "waiting"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.sessionId, "c9");
    assert.equal(seen[0]!.state, "waiting");
  });

  test("disabled integrations are skipped", async () => {
    const a = makeFake("claude-code", [session("claude-code", "c1", 1)]);
    const b = makeFake("codex", [session("codex", "x1", 2)]);
    registerIntegration("claude-code", () => a.obs);
    registerIntegration("codex", () => b.obs);
    const hub = new OrchestratorHub(
      { integrations: { "claude-code": { enabled: true }, codex: { enabled: false } }, visibility: "metadata" },
      NO_BUILTINS,
    );
    await hub.start();
    assert.deepEqual(hub.list().map((s) => s.agent), ["claude-code"]);
  });

  test("a failing integration doesn't take down the others", async () => {
    const good = makeFake("claude-code", [session("claude-code", "c1", 5)]);
    registerIntegration("claude-code", () => good.obs);
    registerIntegration("broken", () => {
      throw new Error("boom");
    });
    const hub = new OrchestratorHub(
      { integrations: { "claude-code": {}, broken: {} }, visibility: "metadata" },
      NO_BUILTINS,
    );
    await hub.start(); // must not throw
    assert.deepEqual(hub.list().map((s) => s.sessionId), ["c1"]);
  });

  test("listByAgent filters", async () => {
    const a = makeFake("claude-code", [session("claude-code", "c1", 1)]);
    const b = makeFake("codex", [session("codex", "x1", 2)]);
    registerIntegration("claude-code", () => a.obs);
    registerIntegration("codex", () => b.obs);
    const hub = new OrchestratorHub(
      { integrations: { "claude-code": {}, codex: {} }, visibility: "metadata" },
      NO_BUILTINS,
    );
    await hub.start();
    assert.deepEqual(hub.listByAgent("codex").map((s) => s.sessionId), ["x1"]);
  });

  test("per-integration visibility overrides the global tier", async () => {
    let seenVisibility: unknown;
    registerIntegration("claude-code", (cfg) => {
      seenVisibility = cfg.visibility;
      return makeFake("claude-code", []).obs;
    });
    const hub = new OrchestratorHub(
      { integrations: { "claude-code": { visibility: "intent" } }, visibility: "metadata" },
      NO_BUILTINS,
    );
    await hub.start();
    assert.equal(seenVisibility, "intent", "per-entry visibility wins over global");
  });
});

describe("loadOrchestratorConfig", () => {
  test("missing file → default config", async () => {
    const cfg = await loadOrchestratorConfig("/nonexistent/agents.json");
    assert.deepEqual(cfg, DEFAULT_ORCHESTRATOR_CONFIG);
  });
});
