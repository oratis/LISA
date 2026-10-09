/**
 * The cost cap's residual bound, as documented, names every gap the code
 * leaves (review of #422, L7): SDK-internal retries never reach
 * `onAttemptFailed`, and a crash before the next checkpoint loses one call's
 * charge. Nothing claims the hook sees every failed attempt "exactly once".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("docs/PROVIDERS.md states the whole residual bound of the cost cap", () => {
  const providers = read("../../docs/PROVIDERS.md");
  const bound = providers.slice(providers.indexOf("**Residual bound:**"));
  assert.ok(bound.length > 0);
  const paragraph = bound.slice(0, bound.indexOf("\n"));
  assert.match(paragraph, /retries made inside a provider SDK/);
  assert.match(paragraph, /never reach `onAttemptFailed`/);
  assert.match(paragraph, /crash between a successful call and the run's next checkpoint/);
  assert.match(paragraph, /capSpentMicros/);
});

test("the onAttemptFailed contract does not promise to see every failed attempt", () => {
  const types = read("../providers/types.ts");
  const doc = types.slice(types.indexOf("Called by a layer that makes more than one attempt"));
  const comment = doc.slice(0, doc.indexOf("onAttemptFailed?:"));
  assert.doesNotMatch(comment, /exactly once/);
  assert.match(comment, /at most once/);
  assert.match(comment, /INSIDE a provider SDK/);
});
