import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TASK_BUDGET, isSafeId, TERMINAL_TASK_STATES } from "./types.js";
import {
  getTaskApprovalFactory,
  getTaskDeliver,
  setTaskApprovalFactory,
  setTaskDeliver,
} from "./wiring.js";

test("isSafeId accepts generated ids", () => {
  assert.equal(isSafeId("t_ab12cd34ef"), true);
  assert.equal(isSafeId("r_0123456789abcdef"), true);
});

test("isSafeId rejects traversal, separators and empties", () => {
  for (const bad of ["", "..", "../x", "a/b", "A_UPPER1", "ab", "x".repeat(80), 42, null]) {
    assert.equal(isSafeId(bad), false, String(bad));
  }
  assert.equal(isSafeId("tk-0123456789ab"), true);
});

test("default budget is bounded on every axis", () => {
  assert.ok(DEFAULT_TASK_BUDGET.tokens > 0);
  assert.ok(DEFAULT_TASK_BUDGET.wallclockMs > 0);
  assert.ok(DEFAULT_TASK_BUDGET.maxToolCalls > 0);
});

test("terminal states exclude the live ones", () => {
  assert.equal(TERMINAL_TASK_STATES.has("running"), false);
  assert.equal(TERMINAL_TASK_STATES.has("cancelled"), true);
});

test("wiring starts unwired and round-trips", () => {
  assert.equal(getTaskApprovalFactory(), undefined);
  assert.equal(getTaskDeliver(), undefined);
  const f = () => undefined;
  setTaskApprovalFactory(f);
  assert.equal(getTaskApprovalFactory(), f);
  setTaskApprovalFactory(undefined);
  const d = async () => ({ delivered: true });
  setTaskDeliver(d);
  assert.equal(getTaskDeliver(), d);
  setTaskDeliver(undefined);
});
