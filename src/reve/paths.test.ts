import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isValidDreamId, dreamFile } from "./paths.js";
import { newDreamId } from "./ids.js";

describe("reve paths", () => {
  test("minted dream ids validate and sort by time", () => {
    const a = newDreamId(new Date("2026-10-09T01:02:03Z"));
    const b = newDreamId(new Date("2026-10-09T01:02:04Z"));
    assert.ok(isValidDreamId(a));
    assert.ok(a.startsWith("d-20261009T010203-"));
    assert.ok(a < b);
  });

  test("path-traversal and malformed ids are rejected", () => {
    for (const bad of ["../x", "d-20261009T010203-zzzzzzzz", "", "d-1-2", "d-20261009T010203-0123456/"]) {
      assert.equal(isValidDreamId(bad), false, bad);
      assert.throws(() => dreamFile(bad));
    }
  });
});
