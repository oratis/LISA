import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assembleReview } from "./review_diff.js";

describe("review_diff assembleReview", () => {
  test("no changes → just the header", () => {
    assert.equal(assembleReview("", "", 600), "(no changes)");
  });

  test("includes stat header and diff body", () => {
    const out = assembleReview(" foo.ts | 2 +-", "diff --git a/foo.ts\n+added\n-removed", 600);
    assert.match(out, /foo\.ts \| 2/);
    assert.match(out, /\+added/);
  });

  test("truncates long diffs and notes it", () => {
    const big = Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join("\n");
    const out = assembleReview("stat", big, 600);
    assert.match(out, /diff truncated — 600 of 1000 lines/);
    assert.ok(out.split("\n").length < 1000, "should be capped");
  });
});
