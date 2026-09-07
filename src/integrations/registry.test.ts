import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerIntegration,
  makeIntegration,
  listAvailableIntegrations,
  registerBuiltinIntegrations,
  _resetIntegrationsForTest,
} from "./registry.js";
import type { AgentObserver, AgentSession } from "./types.js";

function fakeObserver(agent: string): AgentObserver {
  const sessions: AgentSession[] = [];
  return {
    agent,
    async start() {},
    list() {
      return sessions;
    },
    async stop() {},
  };
}

afterEach(() => _resetIntegrationsForTest());

describe("integration registry", () => {
  test("registered factory is retrievable + invoked with config", async () => {
    let seenCfg: unknown;
    registerIntegration("fake", (cfg) => {
      seenCfg = cfg;
      return fakeObserver("fake");
    });
    const obs = await makeIntegration("fake", { enabled: true, home: "/tmp/x" });
    assert.equal(obs.agent, "fake");
    assert.deepEqual(seenCfg, { enabled: true, home: "/tmp/x" });
  });

  test("unknown integration throws with a helpful list", async () => {
    registerIntegration("alpha", () => fakeObserver("alpha"));
    await assert.rejects(() => makeIntegration("nope", {}), /unknown integration "nope".*alpha/s);
  });

  test("listAvailableIntegrations is sorted", () => {
    registerIntegration("zebra", () => fakeObserver("zebra"));
    registerIntegration("apple", () => fakeObserver("apple"));
    assert.deepEqual(listAvailableIntegrations(), ["apple", "zebra"]);
  });

  test("async factories are awaited", async () => {
    registerIntegration("slow", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return fakeObserver("slow");
    });
    const obs = await makeIntegration("slow", {});
    assert.equal(obs.agent, "slow");
  });
});

describe("_resetIntegrationsForTest is undoable", () => {
  // The built-ins register as a side effect of importing their observer
  // modules, and ESM caches modules — so the second registerBuiltinIntegrations()
  // used to import ten already-evaluated modules and register nothing. The
  // reset was a one-way door: any test running after one that called it got
  // `unknown integration "claude-code"`, and the hub suite passed only because
  // its reset happened to be the last thing in the file.
  test("built-ins come back after a reset", async () => {
    await registerBuiltinIntegrations();
    const first = listAvailableIntegrations();
    assert.ok(first.includes("claude-code"), "built-ins register on the first call");
    assert.equal(first.length, 10);

    _resetIntegrationsForTest();
    assert.deepEqual(listAvailableIntegrations(), [], "reset empties the registry");

    await registerBuiltinIntegrations();
    assert.deepEqual(
      listAvailableIntegrations(),
      first,
      "a second call must re-register, not rely on module side effects",
    );
    await assert.doesNotReject(() => makeIntegration("claude-code", { enabled: true }));
  });
});
