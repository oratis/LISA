import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseReflectionPayload,
  detectUnderReflection,
  UNDERREFLECT_MIN_HISTORY,
} from "./reflect.js";

describe("parseReflectionPayload", () => {
  test("parses a well-formed object", () => {
    const r = parseReflectionPayload(
      JSON.stringify({ summary: "s", journal: "j", operations: [] }),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.payload.summary, "s");
  });

  test("strips a ```json fence", () => {
    const r = parseReflectionPayload('```json\n{"summary":"s","operations":[]}\n```');
    assert.equal(r.ok, true);
  });

  test("reports a reason for non-JSON (so the caller can retry, not silently no-op)", () => {
    const r = parseReflectionPayload("I think you should remember that...");
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.length > 0);
  });

  test("rejects a non-object", () => {
    const r = parseReflectionPayload("[1,2,3]");
    assert.equal(r.ok, false);
  });

  test("rejects a missing summary", () => {
    const r = parseReflectionPayload(JSON.stringify({ operations: [] }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /summary/);
  });

  test("rejects operations that aren't an array", () => {
    const r = parseReflectionPayload(JSON.stringify({ summary: "s", operations: "nope" }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /operations/);
  });

  test("operations omitted is allowed (journal-only reflection)", () => {
    const r = parseReflectionPayload(JSON.stringify({ summary: "s", journal: "j" }));
    assert.equal(r.ok, true);
  });
});

describe("detectUnderReflection", () => {
  test("substantial session with 0 operations → true", () => {
    assert.equal(
      detectUnderReflection({ historyLength: UNDERREFLECT_MIN_HISTORY, operationCount: 0 }),
      true,
    );
  });

  test("substantial session with operations → false", () => {
    assert.equal(
      detectUnderReflection({ historyLength: 20, operationCount: 2 }),
      false,
    );
  });

  test("short session with 0 operations → false (expected, not under-reflection)", () => {
    assert.equal(
      detectUnderReflection({ historyLength: UNDERREFLECT_MIN_HISTORY - 1, operationCount: 0 }),
      false,
    );
  });
});
