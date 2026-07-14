import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildIdleSystemPrompt } from "./runner.js";
import { buildToolRegistry, autonomousSubset } from "../tools/registry.js";

describe("idle ⇄ KB tending (autonomous distillation)", () => {
  test("the idle prompt offers tending the knowledge base, grounded in memory + journal", () => {
    const p = buildIdleSystemPrompt();
    assert.match(p, /knowledge base/i);
    assert.match(p, /kb_write/, "names the wiki-write tool");
    assert.match(p, /memory and journal/i, "distillation synthesizes memory + journal");
    assert.match(p, /kb_list|kb_search|kb_read/, "can read the KB to find new sources");
  });

  test("KB tools are available to autonomous (idle / heartbeat) runs", () => {
    const auto = new Set(autonomousSubset(buildToolRegistry()).map((t) => t.name));
    assert.ok(auto.has("kb_write") && auto.has("kb_add"), "idle can write the wiki");
    assert.ok(auto.has("kb_list") && auto.has("kb_read"), "idle can read the KB");
  });
});
