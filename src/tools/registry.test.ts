import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildToolRegistry } from "./registry.js";

describe("buildToolRegistry", () => {
  test("registers the orchestration tools (regression: they were imported but unwired)", () => {
    // advise_now + dispatch_agent + signal_agent were once imported into the
    // registry but never pushed into the array, so the model couldn't call
    // them. tsconfig has no noUnusedLocals to catch that, so guard it here.
    const names = new Set(buildToolRegistry().map((t) => t.name));
    for (const required of ["advise_now", "dispatch_agent", "signal_agent"]) {
      assert.ok(names.has(required), `${required} must be registered`);
    }
  });

  test("includeVoice gates the voice tools", () => {
    const without = new Set(buildToolRegistry().map((t) => t.name));
    assert.equal(without.has("speak"), false);
    const withVoice = new Set(
      buildToolRegistry({ includeVoice: true }).map((t) => t.name),
    );
    assert.ok(withVoice.has("speak"));
    assert.ok(withVoice.has("transcribe"));
  });

  test("tools are returned sorted by name", () => {
    const names = buildToolRegistry().map((t) => t.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted);
  });
});
