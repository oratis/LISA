import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PURPOSE_TIER, tierForPurpose } from "./router.js";

describe("purpose tiers", () => {
  test("user-facing work stays on the strong tier; background work goes small", () => {
    assert.deepEqual(PURPOSE_TIER, {
      chat: "strong",
      plan: "strong",
      execute: "strong",
      triage: "small",
      classify: "small",
      summarize: "small",
      watch: "small",
    });
    assert.equal(tierForPurpose("chat"), "strong");
    assert.equal(tierForPurpose("classify"), "small");
  });
});
