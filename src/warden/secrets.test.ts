import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemorySecretStore,
  SECRET_REDACTION,
  SECRET_VALUE_MAX_BYTES,
  SecretStoreError,
  assertSecretName,
  assertSecretValue,
  containsSecretRef,
  formatSecretRef,
  isValidSecretName,
  parseSecretRef,
  redactKnownSecrets,
  resolveSecretRefs,
} from "./secrets.js";

/** Test values are built at runtime so no literal ever looks like a real credential. */
const VALUE_A = ["alpha", "value", "0001"].join("-");
const VALUE_B = ["bravo", "value", "0002"].join("-");

function codeIs(code: string) {
  return (e: unknown) => e instanceof SecretStoreError && e.code === code;
}

async function seeded(): Promise<MemorySecretStore> {
  const store = new MemorySecretStore(() => 1_000);
  await store.set("github/token", VALUE_A);
  await store.set("smtp", VALUE_B);
  return store;
}

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
  assert.throws(() => assertSecretName("Bad Name"), codeIs("invalid_name"));
});

test("secret values: non-empty, bounded", () => {
  assertSecretValue("x");
  assertSecretValue("x".repeat(SECRET_VALUE_MAX_BYTES));
  for (const bad of ["", "x".repeat(SECRET_VALUE_MAX_BYTES + 1), 7, null, undefined]) {
    assert.throws(() => assertSecretValue(bad), codeIs("invalid_value"));
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

test("memory store: round-trip, timestamps, list never carries values", async () => {
  let clock = 10;
  const store = new MemorySecretStore(() => clock);
  assert.equal(await store.get("smtp"), null);
  assert.equal(await store.has("smtp"), false);
  await store.set("smtp", VALUE_A);
  clock = 20;
  await store.set("smtp", VALUE_B);
  await store.set("a/first", VALUE_A);
  assert.equal(await store.get("smtp"), VALUE_B);
  assert.equal(await store.has("smtp"), true);
  const listed = await store.list();
  assert.deepEqual(listed, [
    { name: "a/first", createdAt: 20, updatedAt: 20 },
    { name: "smtp", createdAt: 10, updatedAt: 20 },
  ]);
  const dump = JSON.stringify(listed);
  assert.equal(dump.includes(VALUE_A) || dump.includes(VALUE_B), false);
  assert.equal(await store.remove("smtp"), true);
  assert.equal(await store.remove("smtp"), false);
  await assert.rejects(store.set("Bad", VALUE_A), codeIs("invalid_name"));
  await assert.rejects(store.set("ok", ""), codeIs("invalid_value"));
});

test("resolveSecretRefs: deep-replaces handles without mutating the input", async () => {
  const store = await seeded();
  const input = {
    headers: { authorization: "Bearer secret://github/token", "x-plain": "secret://smtp" },
    list: ["secret://smtp", 7, null, { nested: "see secret://github/token." }],
    untouched: "https://example.com/a?b=c",
    "secret://smtp": "keys are not resolved",
  };
  const snapshot = JSON.stringify(input);
  const out = await resolveSecretRefs(input, store);
  assert.equal(JSON.stringify(input), snapshot, "input must not be mutated");
  assert.equal(out.value.headers.authorization, `Bearer ${VALUE_A}`);
  assert.equal(out.value.headers["x-plain"], VALUE_B);
  assert.deepEqual(out.value.list, [VALUE_B, 7, null, { nested: `see ${VALUE_A}.` }]);
  assert.equal(out.value.untouched, "https://example.com/a?b=c");
  assert.equal(out.value["secret://smtp"], "keys are not resolved");
  assert.deepEqual(out.names, ["github/token", "smtp"]);
  // Everything except `.value` is safe to log.
  const { value: _value, ...loggable } = out;
  const logged = JSON.stringify(loggable);
  assert.equal(logged.includes(VALUE_A) || logged.includes(VALUE_B), false);
  assert.equal(
    out.redact(`echo ${VALUE_A} and ${VALUE_B}`),
    `echo ${SECRET_REDACTION} and ${SECRET_REDACTION}`,
  );
});

test("resolveSecretRefs: leaves non-plain objects and primitives alone", async () => {
  const store = await seeded();
  const when = new Date(0);
  const buf = Buffer.from("secret://smtp");
  const out = await resolveSecretRefs({ when, buf, n: 1, t: true, u: undefined }, store);
  assert.equal(out.value.when, when);
  assert.equal(out.value.buf, buf);
  assert.deepEqual(out.names, []);
  assert.equal((await resolveSecretRefs("secret://smtp", store)).value, VALUE_B);
  assert.equal((await resolveSecretRefs(42, store)).value, 42);
});

test("resolveSecretRefs: survives cycles", async () => {
  const store = await seeded();
  const node: Record<string, unknown> = { token: "secret://smtp" };
  node.self = node;
  const out = await resolveSecretRefs(node, store);
  assert.equal(out.value.token, VALUE_B);
  assert.equal(out.value.self, out.value);
});

test("resolveSecretRefs: fails closed on unknown, malformed and over-long handles", async () => {
  const store = await seeded();
  await assert.rejects(resolveSecretRefs({ a: "secret://missing" }, store), codeIs("not_found"));
  for (const bad of [
    "secret://",
    "secret://UPPER",
    "secret://smtpX",
    "secret://github/token/extra",
    "ok secret://smtp then secret://",
  ]) {
    await assert.rejects(resolveSecretRefs(bad, store), codeIs("invalid_name"), bad);
  }
  let deep: unknown = "secret://smtp";
  for (let i = 0; i < 80; i++) deep = [deep];
  await assert.rejects(resolveSecretRefs(deep, store), codeIs("invalid_value"));
});

test("resolveSecretRefs: errors never contain a value", async () => {
  const store = await seeded();
  for (const bad of ["secret://smtp secret://missing", "secret://smtp secret://smtpX"]) {
    await assert.rejects(resolveSecretRefs(bad, store), (e: unknown) => {
      assert.ok(e instanceof SecretStoreError);
      assert.equal(e.message.includes(VALUE_B), false);
      assert.equal(String(e.stack).includes(VALUE_B), false);
      return true;
    });
  }
});

test("resolveSecretRefs: the allow gate is consulted before the store is read", async () => {
  const store = await seeded();
  const reads: string[] = [];
  const spy = {
    backend: "memory" as const,
    set: store.set.bind(store),
    has: store.has.bind(store),
    list: store.list.bind(store),
    remove: store.remove.bind(store),
    get: (name: string) => {
      reads.push(name);
      return store.get(name);
    },
  };
  const allow = (name: string) => name === "smtp";
  const ok = await resolveSecretRefs(["secret://smtp", "secret://smtp"], spy, { allow });
  assert.deepEqual(ok.value, [VALUE_B, VALUE_B]);
  assert.deepEqual(reads, ["smtp"], "one read per handle, cached");
  reads.length = 0;
  await assert.rejects(
    resolveSecretRefs("secret://github/token", spy, { allow }),
    codeIs("not_allowed"),
  );
  assert.deepEqual(reads, []);
});

test("containsSecretRef", () => {
  assert.equal(containsSecretRef("x secret://a y"), true);
  assert.equal(containsSecretRef({ a: [1, { b: "secret://a" }] }), true);
  assert.equal(containsSecretRef({ a: [1, { b: "https://a" }] }), false);
  assert.equal(containsSecretRef(null), false);
});

test("redactKnownSecrets: raw and encoded spellings", () => {
  const value = ["p@ss", 'w"rd', "/+ 9"].join("");
  const text = [
    `raw=${value}`,
    `uri=${encodeURIComponent(value)}`,
    `json=${JSON.stringify(value)}`,
    `b64=${Buffer.from(value).toString("base64")}`,
    `b64url=${Buffer.from(value).toString("base64url")}`,
    `hex=${Buffer.from(value).toString("hex")}`,
  ].join("\n");
  const out = redactKnownSecrets(text, [value]);
  assert.equal(out.includes(value), false);
  assert.equal(out.includes(encodeURIComponent(value)), false);
  assert.equal(out.includes(Buffer.from(value).toString("base64url")), false);
  assert.equal(out.includes(Buffer.from(value).toString("hex")), false);
  assert.equal(out.split(SECRET_REDACTION).length - 1, 6);
});

test("redactKnownSecrets: longest first, short values skipped, idempotent", () => {
  const long = `${VALUE_A}-suffix`;
  const out = redactKnownSecrets(`x ${long} y ${VALUE_A} z`, [VALUE_A, long]);
  assert.equal(out, `x ${SECRET_REDACTION} y ${SECRET_REDACTION} z`);
  assert.equal(redactKnownSecrets(out, [VALUE_A, long]), out);
  assert.equal(redactKnownSecrets("abc abc", ["abc"]), "abc abc", "3 chars is below the floor");
  assert.equal(redactKnownSecrets("", [VALUE_A]), "");
  assert.equal(redactKnownSecrets("nothing here", []), "nothing here");
});
