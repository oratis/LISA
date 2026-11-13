import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseReflectionPayload,
  detectUnderReflection,
  addProviderUsage,
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

  test("takes the object out of a reply that wraps it in prose", () => {
    // The shapes the memory eval recorded as unparseable: "Unexpected token
    // '好'", "Unexpected token 'L'", "non-whitespace character after JSON".
    const json = JSON.stringify({ summary: "s", operations: [] });
    for (const reply of [
      `好的，以下是这次对话的反思：\n${json}`,
      `Let me reflect on this session.\n\n${json}`,
      `${json}\n\nNothing else changed.`,
      `Here it is:\n\`\`\`json\n${json}\n\`\`\`\nThat is all.`,
    ]) {
      const r = parseReflectionPayload(reply);
      assert.equal(r.ok, true, reply.slice(0, 30));
      if (r.ok) assert.equal(r.payload.summary, "s");
    }
  });

  test("a reply with two payload-shaped objects is unparseable, so it is retried", () => {
    // Reflection reads conversation text that can include fetched pages: an
    // object quoted from one must not be applied in place of the real reply.
    const quoted = JSON.stringify({ summary: "page", operations: [{ kind: "memory_remove" }] });
    const own = JSON.stringify({ summary: "s", operations: [] });
    const r = parseReflectionPayload(`The page contained ${quoted}\nMy reflection:\n${own}`);
    assert.equal(r.ok, false);
  });

  test("a cut-off reply is still unparseable: an operation is not mistaken for the payload", () => {
    const cut = '{"summary":"s","operations":[{"kind":"memory_append","entry":"x"}';
    const r = parseReflectionPayload(`Sure.\n${cut}`);
    assert.equal(r.ok, false);
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
    assert.equal(detectUnderReflection({ historyLength: 20, operationCount: 2 }), false);
  });

  test("short session with 0 operations → false (expected, not under-reflection)", () => {
    assert.equal(
      detectUnderReflection({ historyLength: UNDERREFLECT_MIN_HISTORY - 1, operationCount: 0 }),
      false,
    );
  });
});

test("addProviderUsage preserves every billable token class", () => {
  assert.deepEqual(
    addProviderUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
    ),
    { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 },
  );
});
