import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { taskStateToSessionState, extractTaskState } from "./a2a.js";

describe("taskStateToSessionState", () => {
  test("maps the full A2A lifecycle onto normalized states", () => {
    assert.equal(taskStateToSessionState("submitted").state, "working");
    assert.equal(taskStateToSessionState("working").state, "working");
    assert.equal(taskStateToSessionState("input-required").state, "waiting");
    assert.equal(taskStateToSessionState("auth-required").state, "waiting");
    assert.equal(taskStateToSessionState("completed").state, "done");
    assert.equal(taskStateToSessionState("failed").state, "error");
    assert.equal(taskStateToSessionState("rejected").state, "error");
    assert.deepEqual(taskStateToSessionState("canceled"), { state: "done", reason: "canceled" });
    assert.deepEqual(taskStateToSessionState("cancelled"), { state: "done", reason: "canceled" });
  });

  test("is case-insensitive and falls back to unknown", () => {
    assert.equal(taskStateToSessionState("WORKING").state, "working");
    assert.equal(taskStateToSessionState("Input-Required").state, "waiting");
    assert.equal(taskStateToSessionState("weird").state, "unknown");
    assert.equal(taskStateToSessionState("").state, "unknown");
  });
});

describe("extractTaskState", () => {
  test("reads A2A status.state under JSON-RPC result, with id", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", result: { id: "t1", status: { state: "working" } } });
    assert.deepEqual(extractTaskState(body), { state: "working", taskId: "t1" });
  });

  test("reads a flat state and a bare/nested task", () => {
    assert.deepEqual(extractTaskState(JSON.stringify({ state: "completed" })), { state: "completed" });
    assert.deepEqual(
      extractTaskState(JSON.stringify({ task: { taskId: "x", state: "failed" } })),
      { state: "failed", taskId: "x" },
    );
  });

  test("returns null for a plain reply / non-JSON / no state", () => {
    assert.equal(extractTaskState("just some text"), null);
    assert.equal(extractTaskState(JSON.stringify({ choices: [{ message: { content: "hi" } }] })), null);
    assert.equal(extractTaskState("{ broken"), null);
    assert.equal(extractTaskState(JSON.stringify({ result: { id: "t" } })), null); // id but no state
    assert.equal(extractTaskState("null"), null);
  });
});
