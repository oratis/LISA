import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolvePlanId, planRunPreCheck } from "./run_on_plan.js";
import type { PlanStatus } from "../model/plans.js";

describe("resolvePlanId", () => {
  test("explicit id wins", () => {
    assert.equal(resolvePlanId("claude", {}), "claude");
    assert.equal(resolvePlanId("CODEX", {}), "codex");
  });
  test("accepts plan:// form", () => {
    assert.equal(resolvePlanId("plan://codex", {}), "codex");
  });
  test("falls back to the selected plan when no arg", () => {
    assert.equal(resolvePlanId(undefined, { LISA_CODING_PLAN: "claude" }), "claude");
    assert.equal(resolvePlanId("", { LISA_CODING_PLAN: "codex" }), "codex");
  });
  test("no arg + nothing selected → null", () => {
    assert.equal(resolvePlanId(undefined, {}), null);
  });
  test("unknown id → null", () => {
    assert.equal(resolvePlanId("gemini", {}), null);
  });
});

function status(over: Partial<PlanStatus>): PlanStatus {
  return {
    id: "claude",
    label: "Claude Pro/Max",
    cli: "claude",
    binary: "claude",
    available: true,
    loggedIn: true,
    detail: "ready",
    ...over,
  };
}

describe("planRunPreCheck", () => {
  test("ready claude → ok with dispatch kind", () => {
    const r = planRunPreCheck("claude", status({}));
    assert.deepEqual(r, { ok: true, kind: "claude" });
  });
  test("ready codex → ok with codex kind", () => {
    const r = planRunPreCheck("codex", status({ id: "codex", cli: "codex" }));
    assert.deepEqual(r, { ok: true, kind: "codex" });
  });
  test("copilot is not wired yet → refusal", () => {
    const r = planRunPreCheck("copilot", status({ id: "copilot", cli: "copilot" }));
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /isn't wired yet/);
  });
  test("not installed → refusal mentions the plan", () => {
    const r = planRunPreCheck("claude", status({ available: false, binary: null, detail: "install it" }));
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /Can't run on your claude plan/);
  });
  test("logged out → refusal", () => {
    const r = planRunPreCheck("codex", status({ id: "codex", cli: "codex", loggedIn: false }));
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /not logged in/);
  });
});
