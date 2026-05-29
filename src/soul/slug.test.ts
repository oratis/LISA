import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertSafeSlug, normalizeSlug, UnsafeSlugError, MAX_SLUG_LEN } from "./slug.js";

describe("assertSafeSlug — accepts legitimate slugs", () => {
  for (const ok of [
    "learn-rust",
    "rust",
    "memory-safety",
    "opinion_123",
    "2026-05-28", // journal date form
    "user-at-host",
    "a",
    "Uppercase-Allowed-For-Reads", // style is normalizeSlug's job, not the gate's
  ]) {
    test(`accepts ${JSON.stringify(ok)}`, () => {
      assert.equal(assertSafeSlug(ok), ok);
    });
  }
});

describe("assertSafeSlug — blocks path traversal & corruption", () => {
  const bad: Array<[string, string]> = [
    ["../etc/passwd", "parent traversal"],
    ["../../../tmp/x", "deep traversal"],
    ["foo/bar", "forward slash"],
    ["foo\\bar", "backslash"],
    [".hidden", "leading dot / dotfile"],
    [".", "current-dir token"],
    ["..", "parent-dir token"],
    ["", "empty"],
    ["a".repeat(MAX_SLUG_LEN + 1), "over length"],
    ["has\nnewline", "newline (control char)"],
    ["has\ttab", "tab (control char)"],
    ["has\0null", "null byte"],
  ];
  for (const [input, why] of bad) {
    test(`rejects ${why}`, () => {
      assert.throws(() => assertSafeSlug(input), UnsafeSlugError);
    });
  }

  test("the canonical exploit ../../../ is blocked", () => {
    assert.throws(
      () => assertSafeSlug("../../../../../../etc/cron.d/evil"),
      UnsafeSlugError,
    );
  });
});

describe("normalizeSlug — tidies free-form input", () => {
  test("lowercases + dashes", () => {
    assert.equal(normalizeSlug("Learn Rust Well"), "learn-rust-well");
  });
  test("collapses punctuation runs to single dash", () => {
    assert.equal(normalizeSlug("a!!!  b___c"), "a-b-c");
  });
  test("trims leading/trailing dashes", () => {
    assert.equal(normalizeSlug("  --hello--  "), "hello");
  });
  test("caps length and re-trims", () => {
    const out = normalizeSlug("x".repeat(200));
    assert.ok(out.length <= MAX_SLUG_LEN);
  });
  test("all-punctuation input yields empty (caller supplies fallback)", () => {
    assert.equal(normalizeSlug("!!!???"), "");
  });
  test("output of normalizeSlug always passes assertSafeSlug", () => {
    for (const raw of ["Learn Rust", "../../etc", "hello world!", "MiXeD-CaSe_99"]) {
      const norm = normalizeSlug(raw);
      if (norm) assert.equal(assertSafeSlug(norm), norm);
    }
  });
});
