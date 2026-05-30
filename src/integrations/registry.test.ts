import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerIntegration,
  makeIntegration,
  listAvailableIntegrations,
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
