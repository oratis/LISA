import { test } from "node:test";
import assert from "node:assert/strict";
import { stripSensitiveTokens } from "./hygiene.js";

test("hygiene: plain text passes through untouched", () => {
  const text = "Lunch on Friday? The invoice total was $1,284.00, order #20261002.";
  const out = stripSensitiveTokens(text);
  assert.equal(out.text, text);
  assert.deepEqual(out.removed, { otp: 0, signInLinks: 0, resetLinks: 0 });
});
