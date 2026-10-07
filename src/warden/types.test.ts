import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_CATEGORIES,
  GRANT_SCOPES,
  RULE_BEHAVIORS,
  isActionCategory,
  isGrantScope,
  isRuleBehavior,
} from "./types.js";

test("warden vocabularies are closed sets with strict guards", () => {
  assert.equal(ACTION_CATEGORIES.length, 11);
  assert.deepEqual([...RULE_BEHAVIORS], ["auto", "preapproved", "ask", "handoff"]);
  assert.deepEqual([...GRANT_SCOPES], ["once", "task", "target", "24h", "always"]);
  assert.equal(isActionCategory("exec"), true);
  assert.equal(isActionCategory("allow-all"), false);
  assert.equal(isRuleBehavior("auto"), true);
  assert.equal(isRuleBehavior("allow"), false);
  assert.equal(isRuleBehavior(undefined), false);
  assert.equal(isGrantScope("always"), true);
  assert.equal(isGrantScope("forever"), false);
});
