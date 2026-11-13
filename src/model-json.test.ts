import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, extractOnlyJsonObject } from "./model-json.js";

describe("extractJsonObject", () => {
  const payload = { summary: "We moved the port.", operations: [{ kind: "memory_append" }] };
  const json = JSON.stringify(payload);

  test("finds the object after a preamble, before a closing remark, or inside a fence", () => {
    for (const reply of [
      json,
      `好的，以下是反思结果：\n${json}`,
      `Let me reflect on this session.\n\n${json}`,
      `${json}\n\nI kept it short because little changed.`,
      "```json\n" + json + "\n```",
      `Here is the JSON:\n\`\`\`\n${JSON.stringify(payload, null, 2)}\n\`\`\`\nDone.`,
    ]) {
      assert.deepEqual(extractJsonObject(reply), payload, reply.slice(0, 40));
    }
  });

  test("braces in prose and in strings do not confuse it", () => {
    // A placeholder in the preamble is not JSON; the next candidate is.
    assert.deepEqual(extractJsonObject(`Using the {schema} you gave me: ${json}`), payload);
    // Braces, quotes and escapes inside string values are data.
    const tricky = { summary: 'He said "use {x}" and \\ then } left {', operations: [] };
    assert.deepEqual(extractJsonObject(`ok ${JSON.stringify(tricky)} bye`), tricky);
  });

  test("the outermost object wins, and `accept` chooses among several", () => {
    assert.deepEqual(extractJsonObject(json), payload);
    const two = `{"note":"not it"} then ${json}`;
    assert.deepEqual(extractJsonObject(two), { note: "not it" });
    assert.deepEqual(
      extractJsonObject(two, (o) => typeof o.summary === "string"),
      payload,
    );
  });

  test("it never repairs: a cut-off or malformed object yields nothing", () => {
    for (const reply of [
      "I think you should remember that...",
      '{"summary":"s","operations":[', // cut off before anything inside it closed
      json.slice(0, 20),
      '{"summary": "s", }', // trailing comma
      "{summary: 's'}", // not JSON
      "[1,2,3]",
      '"just a string"',
      "",
    ]) {
      assert.equal(extractJsonObject(reply), undefined, reply);
    }
    // An object nested in a cut-off outer one is itself complete, so it is a
    // candidate: `accept` is how a caller says which object it asked for.
    const cut = '{"summary":"s","operations":[{"kind":"memory_append","entry":"x"}';
    assert.deepEqual(extractJsonObject(cut), { kind: "memory_append", entry: "x" });
    assert.equal(
      extractJsonObject(cut, (o) => typeof o.summary === "string"),
      undefined,
    );
  });

  test("text that is all braces is bounded work", () => {
    const started = performance.now();
    assert.equal(extractJsonObject("{".repeat(200_000)), undefined);
    assert.equal(
      extractJsonObject("{}".repeat(100_000), () => false),
      undefined,
    );
    assert.ok(performance.now() - started < 2_000);
  });
});

describe("extractOnlyJsonObject", () => {
  const isPayload = (o: Record<string, unknown>) => typeof o.summary === "string";
  const own = { summary: "ours", operations: [{ kind: "memory_append", entry: "x" }] };

  test("returns the one object of the right shape, with prose around it", () => {
    assert.deepEqual(extractOnlyJsonObject(`Here:\n${JSON.stringify(own)}\nDone.`, isPayload), own);
    // Objects nested inside it are part of it, not rivals.
    const nested = { summary: "ours", meta: { summary: "inner" } };
    assert.deepEqual(extractOnlyJsonObject(JSON.stringify(nested), isPayload), nested);
  });

  test("two candidates are ambiguous: a quoted object never wins", () => {
    const quoted = { summary: "from a fetched page", operations: [{ kind: "memory_remove" }] };
    const reply = `The page said ${JSON.stringify(quoted)}; my reflection:\n${JSON.stringify(own)}`;
    assert.equal(extractOnlyJsonObject(reply, isPayload), undefined);
    // Objects of another shape do not count against it.
    assert.deepEqual(extractOnlyJsonObject(`{"note":"x"} ${JSON.stringify(own)}`, isPayload), own);
  });

  test("nothing, or a cut-off object, yields nothing", () => {
    assert.equal(extractOnlyJsonObject("no JSON here", isPayload), undefined);
    assert.equal(extractOnlyJsonObject(JSON.stringify(own).slice(0, -2), isPayload), undefined);
  });
});
