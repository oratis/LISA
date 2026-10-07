import { test } from "node:test";
import assert from "node:assert/strict";
import { homeForUid, homeScope } from "../paths.js";
import { createTaskHost } from "./tasks-host.js";

test("the hosted runner cache refuses new tenants when every slot is busy", async () => {
  const host = createTaskHost({
    cloud: true,
    cloudEnabled: true,
    profile: "cloud-chat",
    tools: [],
    model: () => "gemini-2.5-flash",
    cwd: "/tmp",
    broadcast: () => {},
    withConversation: async (fn) => fn({ history: [], append: async () => {} }),
    reachOut: async () => {
      throw new Error("must not deliver");
    },
    modelGateFor: () => ({ admit: async () => ({ ok: false, reason: "test" }) }),
  });
  const get = (uid: string) => homeScope.run(homeForUid(uid), () => host.runnerFor(uid));
  try {
    for (let i = 0; i < 256; i++) {
      const runner = get(`capacity-${i}`);
      assert.ok(runner);
      Object.defineProperty(runner, "activeCount", { configurable: true, get: () => 1 });
    }
    assert.equal(get("capacity-overflow"), null);
    const existing = get("capacity-0");
    assert.ok(existing, "an existing tenant remains accessible at capacity");
    Object.defineProperty(existing, "activeCount", { get: () => 0 });
    assert.ok(get("capacity-overflow"), "an idle slot can be replaced");
  } finally {
    await host.stop();
  }
});
