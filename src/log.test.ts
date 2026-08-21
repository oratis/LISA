import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStructured, redactEmail, redactId } from "./log.js";

test("formatStructured emits one-line JSON with the severity Cloud Logging lifts", () => {
  const line = formatStructured("INFO", "[web] resuming session abc");
  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line) as { severity: string; message: string };
  assert.equal(parsed.severity, "INFO");
  assert.equal(parsed.message, "[web] resuming session abc");
});

test("redactId keeps a prefix+suffix for correlation, never the middle", () => {
  assert.equal(redactId("550e8400-e29b-41d4-a716-446655440000"), "550e…0000");
  assert.equal(redactId("short"), "sh…");
  assert.equal(redactId(""), "");
});

test("redactEmail drops the identifying local part, keeps the domain", () => {
  assert.equal(redactEmail("alice.smith@example.com"), "al***@example.com");
  assert.equal(redactEmail("a@b.co"), "a***@b.co");
  // Anything that isn't an address must not fall through as-is.
  assert.equal(redactEmail("not-an-address"), "***");
  assert.equal(redactEmail("@nouser.com"), "***");
  assert.equal(redactEmail("trailing@"), "***");
});
