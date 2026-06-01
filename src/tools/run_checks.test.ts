import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectChecks } from "./run_checks.js";

describe("run_checks detectChecks", () => {
  test("maps script aliases onto canonical checks, in priority order", () => {
    const got = detectChecks({ build: "tsc", test: "node --test", lint: "eslint .", typecheck: "tsc --noEmit" });
    assert.deepEqual(got.map((c) => c.name), ["typecheck", "lint", "test", "build"]);
  });

  test("recognises aliases (tsc → typecheck, tests → test)", () => {
    const got = detectChecks({ tsc: "tsc --noEmit", tests: "vitest" });
    assert.deepEqual(got.map((c) => c.name).sort(), ["test", "typecheck"]);
  });

  test("only:[...] filters to the requested checks", () => {
    const got = detectChecks({ test: "x", lint: "y", build: "z" }, ["test"]);
    assert.deepEqual(got.map((c) => c.name), ["test"]);
  });

  test("ignores unrelated scripts and returns [] when none match", () => {
    assert.deepEqual(detectChecks({ start: "node .", deploy: "x" }), []);
  });

  test("first script wins per canonical check", () => {
    const got = detectChecks({ test: "a", tests: "b" });
    assert.deepEqual(got, [{ name: "test", script: "test" }]);
  });
});
