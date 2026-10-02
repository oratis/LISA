import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SecretStoreError,
  assertSecretName,
  assertSecretValue,
  formatSecretRef,
  isValidSecretName,
  parseSecretRef,
  SECRET_VALUE_MAX_BYTES,
} from "./secrets.js";

test("secret names: grammar", () => {
  for (const ok of [
    "a",
    "gmail",
    "gmail/work",
    "0x",
    "a.b-c_d",
    "a".repeat(64),
    "ns/" + "b".repeat(64),
  ]) {
    assert.equal(isValidSecretName(ok), true, ok);
  }
  for (const bad of [
    "",
    "Gmail",
    "-lead",
    ".lead",
    "_lead",
    "a/b/c",
    "a/",
    "/a",
    "a//b",
    "a b",
    "a\nb",
    "../etc",
    "a".repeat(65),
    "ns/" + "b".repeat(65),
    "名字",
    42,
    null,
    undefined,
  ]) {
    assert.equal(isValidSecretName(bad), false, String(bad));
  }
  assert.throws(
    () => assertSecretName("Bad Name"),
    (e) => e instanceof SecretStoreError && e.code === "invalid_name",
  );
});

test("secret values: non-empty, bounded", () => {
  assertSecretValue("x");
  assertSecretValue("x".repeat(SECRET_VALUE_MAX_BYTES));
  for (const bad of ["", "x".repeat(SECRET_VALUE_MAX_BYTES + 1), 7, null, undefined]) {
    assert.throws(
      () => assertSecretValue(bad),
      (e) => e instanceof SecretStoreError && e.code === "invalid_value",
    );
  }
});

test("secret refs: format and parse round-trip", () => {
  assert.equal(formatSecretRef("gmail/work"), "secret://gmail/work");
  assert.equal(parseSecretRef("secret://gmail/work"), "gmail/work");
  assert.equal(parseSecretRef("secret://Gmail"), null);
  assert.equal(parseSecretRef("secret://a/b/c"), null);
  assert.equal(parseSecretRef("https://example.com"), null);
  assert.equal(parseSecretRef(" secret://a"), null);
  assert.equal(parseSecretRef(12), null);
  assert.throws(() => formatSecretRef("NOPE"), SecretStoreError);
});
