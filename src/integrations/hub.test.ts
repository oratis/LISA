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

describe("built-in observer roster (the number the READMEs claim)", () => {
  // The READMEs said "all five observers" while ten shipped, and the directory
  // tree 490 lines below listed seven plus an ellipsis — so the README
  // contradicted itself as well as the code. Pin the count here: prose can't
  // be tested, but the fact it describes can be.
  const EXPECTED = [
    "aider",
    "claude-code",
    "codex",
    "git",
    "github-pr",
    "managed",
    "opencode",
    "pty",
    "shell",
    "takoapi",
  ];

  test("ten integrations ship, and they are exactly these", () => {
    const keys = Object.keys(DEFAULT_ORCHESTRATOR_CONFIG.integrations).sort();
    assert.equal(keys.length, 10, "README says ten observers — update both if this changes");
    assert.deepEqual(keys, EXPECTED);
  });

  test("registerBuiltinIntegrations registers one observer per configured key", async () => {
    const { registerBuiltinIntegrations, listAvailableIntegrations } = await import("./registry.js");
    await registerBuiltinIntegrations();
    assert.deepEqual(listAvailableIntegrations().sort(), EXPECTED);
  });

  test("exactly three are enabled by default — the rest are opt-in", () => {
    const on = Object.entries(DEFAULT_ORCHESTRATOR_CONFIG.integrations)
      .filter(([, cfg]) => cfg.enabled)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(on, ["claude-code", "managed", "pty"]);
  });
});

describe("agents.json merges per key", () => {
  // The READMEs point you at ~/.lisa/agents.json to switch on one of the seven
  // opt-in observers, and the obvious hand-edit is to write just that one.
  // A whole-map replace made that edit silently drop the three defaults, so
  // "enable codex" also turned Claude Code, managed and pty observation OFF —
  // with no error and nothing in the UI to say so.
  const mkTmp = async (body: unknown) => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-agents-"));
    const file = path.join(dir, "agents.json");
    await fs.writeFile(file, JSON.stringify(body), "utf8");
    return file;
  };

  test("a partial integrations map keeps the defaults it does not mention", async () => {
    const file = await mkTmp({ integrations: { codex: { enabled: true } } });
    const cfg = await loadOrchestratorConfig(file);
    assert.equal(cfg.integrations.codex.enabled, true, "the edit takes effect");
    for (const name of Object.keys(DEFAULT_ORCHESTRATOR_CONFIG.integrations)) {
      assert.ok(cfg.integrations[name], `${name} must survive a partial edit`);
    }
    assert.equal(cfg.integrations["claude-code"].enabled, true, "a default stays on");
    assert.equal(cfg.integrations.managed.enabled, true);
    assert.equal(cfg.integrations.pty.enabled, true);
  });

  test("an explicit disable still wins over the default", async () => {
    const file = await mkTmp({ integrations: { "claude-code": { enabled: false } } });
    const cfg = await loadOrchestratorConfig(file);
    assert.equal(cfg.integrations["claude-code"].enabled, false, "merge must not resurrect a default");
  });
});
