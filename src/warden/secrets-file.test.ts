import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretStoreError } from "./secrets.js";
import { EncryptedFileSecretStore, localKeyFile, tenantKey } from "./secrets-file.js";

/** Built at runtime so no literal in this file looks like a real credential. */
const VALUE_A = ["file", "value", "alpha", "0001"].join("-");
const VALUE_B = ["file", "value", "bravo", "0002"].join("-");
const SESSION_SECRET = "s".repeat(96);

function codeIs(code: string) {
  return (e: unknown) => e instanceof SecretStoreError && e.code === code;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lisa-secrets-"));
}

function localStore(dir: string, now: () => number = Date.now): EncryptedFileSecretStore {
  return new EncryptedFileSecretStore({
    backend: "file",
    file: path.join(dir, "warden", "secrets.enc.json"),
    keys: localKeyFile(path.join(dir, "warden", "secret.key")),
    scope: "local",
    now,
  });
}

function cloudStore(home: string, uid: string, secret = SESSION_SECRET): EncryptedFileSecretStore {
  return new EncryptedFileSecretStore({
    backend: "cloud",
    file: path.join(home, "users", uid, "warden", "secrets.enc.json"),
    keys: tenantKey(() => secret, uid),
    scope: `uid:${uid}`,
  });
}

function readDoc(file: string): {
  version: number;
  secrets: Record<string, Record<string, unknown>>;
} {
  return JSON.parse(fs.readFileSync(file, "utf8")) as {
    version: number;
    secrets: Record<string, Record<string, unknown>>;
  };
}

test("file store: round-trip, overwrite, remove, survives reopen", async () => {
  const dir = tmpDir();
  let clock = 100;
  const store = localStore(dir, () => clock);
  assert.equal(store.backend, "file");
  assert.equal(await store.get("smtp"), null);
  assert.deepEqual(await store.list(), []);
  await store.set("smtp", VALUE_A);
  await store.set("gmail/work", VALUE_B);
  clock = 200;
  await store.set("smtp", VALUE_B);

  const reopened = localStore(dir);
  assert.equal(await reopened.get("smtp"), VALUE_B);
  assert.equal(await reopened.get("gmail/work"), VALUE_B);
  assert.equal(await reopened.has("smtp"), true);
  assert.equal(await reopened.has("nope"), false);
  assert.deepEqual(await reopened.list(), [
    { name: "gmail/work", createdAt: 100, updatedAt: 100 },
    { name: "smtp", createdAt: 100, updatedAt: 200 },
  ]);
  assert.equal(await reopened.remove("smtp"), true);
  assert.equal(await reopened.remove("smtp"), false);
  assert.equal(await reopened.get("smtp"), null);
  assert.equal(await reopened.get("gmail/work"), VALUE_B);
});

test("file store: unicode and multi-line values round-trip exactly", async () => {
  const store = localStore(tmpDir());
  const value = "第一行\nline two\twith tab\n🔑 trailing space ";
  await store.set("multi", value);
  assert.equal(await store.get("multi"), value);
});

test("file store: nothing on disk or in list() contains a value", async () => {
  const dir = tmpDir();
  const store = localStore(dir);
  await store.set("smtp", VALUE_A);
  const onDisk =
    fs.readFileSync(path.join(dir, "warden", "secrets.enc.json"), "utf8") +
    fs.readFileSync(path.join(dir, "warden", "secret.key"), "utf8");
  for (const spelling of [
    VALUE_A,
    Buffer.from(VALUE_A).toString("base64"),
    Buffer.from(VALUE_A).toString("base64url"),
    Buffer.from(VALUE_A).toString("hex"),
  ]) {
    assert.equal(onDisk.includes(spelling), false);
  }
  assert.equal(JSON.stringify(await store.list()).includes(VALUE_A), false);
});

test("file store: files are owner-only", { skip: process.platform === "win32" }, async () => {
  const dir = tmpDir();
  await localStore(dir).set("smtp", VALUE_A);
  for (const f of ["secrets.enc.json", "secret.key"]) {
    assert.equal(fs.statSync(path.join(dir, "warden", f)).mode & 0o777, 0o600, f);
  }
  assert.equal(fs.statSync(path.join(dir, "warden")).mode & 0o777, 0o700);
});

test("file store: a fresh IV per write", async () => {
  const dir = tmpDir();
  const store = localStore(dir);
  const file = path.join(dir, "warden", "secrets.enc.json");
  await store.set("smtp", VALUE_A);
  const first = readDoc(file).secrets.smtp!;
  await store.set("smtp", VALUE_A);
  const second = readDoc(file).secrets.smtp!;
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
});

test("file store: tampering with any field fails closed", async () => {
  for (const field of ["iv", "tag", "data"] as const) {
    const dir = tmpDir();
    const store = localStore(dir);
    const file = path.join(dir, "warden", "secrets.enc.json");
    await store.set("smtp", VALUE_A);
    const doc = readDoc(file);
    const bytes = Buffer.from(String(doc.secrets.smtp![field]), "base64url");
    bytes[0] = bytes[0]! ^ 0x01;
    doc.secrets.smtp![field] = bytes.toString("base64url");
    fs.writeFileSync(file, JSON.stringify(doc));
    await assert.rejects(store.get("smtp"), codeIs("corrupt"), field);
  }
});

test("file store: a ciphertext moved to another name does not decrypt", async () => {
  const dir = tmpDir();
  const store = localStore(dir);
  const file = path.join(dir, "warden", "secrets.enc.json");
  await store.set("low", VALUE_A);
  await store.set("high", VALUE_B);
  const doc = readDoc(file);
  doc.secrets.low = doc.secrets.high!;
  fs.writeFileSync(file, JSON.stringify(doc));
  await assert.rejects(store.get("low"), codeIs("corrupt"));
  assert.equal(await store.get("high"), VALUE_B);
});

test("file store: an unreadable store file fails closed and is never overwritten", async () => {
  const cases: Array<[string, string]> = [
    ["truncated", '{"version":1,"secrets":{"smtp":{"iv":"AAAA'],
    ["not json", "hello"],
    ["wrong version", JSON.stringify({ version: 2, secrets: {} })],
    ["array", JSON.stringify([])],
    ["null", "null"],
    ["secrets array", JSON.stringify({ version: 1, secrets: [] })],
    ["bad name", JSON.stringify({ version: 1, secrets: { "Not Valid": {} } })],
    ["bad entry", JSON.stringify({ version: 1, secrets: { smtp: { iv: 1 } } })],
    ["proto key", '{"version":1,"secrets":{"__proto__":{"iv":"a","tag":"b","data":"c"}}}'],
  ];
  for (const [label, bytes] of cases) {
    const dir = tmpDir();
    const store = localStore(dir);
    const file = path.join(dir, "warden", "secrets.enc.json");
    await store.set("smtp", VALUE_A);
    fs.writeFileSync(file, bytes);
    await assert.rejects(store.get("smtp"), codeIs("corrupt"), label);
    await assert.rejects(store.has("smtp"), codeIs("corrupt"), label);
    await assert.rejects(store.list(), codeIs("corrupt"), label);
    await assert.rejects(store.remove("smtp"), codeIs("corrupt"), label);
    await assert.rejects(store.set("other", VALUE_B), codeIs("corrupt"), label);
    assert.equal(fs.readFileSync(file, "utf8"), bytes, `${label}: bytes must be left alone`);
  }
});

test("file store: a missing or damaged key fails closed without minting a new one", async () => {
  const dir = tmpDir();
  const store = localStore(dir);
  const keyFile = path.join(dir, "warden", "secret.key");
  await store.set("smtp", VALUE_A);

  fs.rmSync(keyFile);
  await assert.rejects(store.get("smtp"), codeIs("corrupt"));
  await assert.rejects(store.set("other", VALUE_B), codeIs("corrupt"));
  assert.equal(fs.existsSync(keyFile), false, "must not create a key over existing ciphertext");

  fs.writeFileSync(keyFile, "v1.c2hvcnQ\n");
  await assert.rejects(store.get("smtp"), codeIs("corrupt"));
  fs.writeFileSync(keyFile, "garbage\n");
  await assert.rejects(store.get("smtp"), codeIs("corrupt"));
});

test("file store: a different key cannot decrypt", async () => {
  const dir = tmpDir();
  const store = localStore(dir);
  await store.set("smtp", VALUE_A);
  const other = tmpDir();
  await localStore(other).set("x", VALUE_B);
  fs.copyFileSync(path.join(other, "warden", "secret.key"), path.join(dir, "warden", "secret.key"));
  await assert.rejects(store.get("smtp"), codeIs("corrupt"));
});

test("file store: errors never contain a value", async () => {
  const dir = tmpDir();
  const store = localStore(dir);
  const file = path.join(dir, "warden", "secrets.enc.json");
  await store.set("smtp", VALUE_A);
  const doc = readDoc(file);
  doc.secrets.smtp!.tag = Buffer.alloc(16).toString("base64url");
  fs.writeFileSync(file, JSON.stringify(doc));
  await assert.rejects(store.get("smtp"), (e: unknown) => {
    assert.ok(e instanceof SecretStoreError);
    assert.equal(`${e.message}\n${String(e.stack)}`.includes(VALUE_A), false);
    return true;
  });
});

test("cloud store: round-trip per tenant", async () => {
  const home = tmpDir();
  const a = cloudStore(home, "uidA");
  const b = cloudStore(home, "uidB");
  assert.equal(a.backend, "cloud");
  await a.set("gmail/work", VALUE_A);
  await b.set("gmail/work", VALUE_B);
  assert.equal(await a.get("gmail/work"), VALUE_A);
  assert.equal(await b.get("gmail/work"), VALUE_B);
  assert.deepEqual(
    (await a.list()).map((m) => m.name),
    ["gmail/work"],
  );
  // No key material is written anywhere for the cloud backend.
  assert.deepEqual(fs.readdirSync(path.join(home, "users", "uidA", "warden")), [
    "secrets.enc.json",
  ]);
});

test("cloud store: tenant B cannot decrypt tenant A's file", async () => {
  const home = tmpDir();
  const a = cloudStore(home, "uidA");
  await a.set("gmail/work", VALUE_A);
  const fileA = path.join(home, "users", "uidA", "warden", "secrets.enc.json");
  const fileB = path.join(home, "users", "uidB", "warden", "secrets.enc.json");
  fs.mkdirSync(path.dirname(fileB), { recursive: true });
  fs.copyFileSync(fileA, fileB);
  const b = cloudStore(home, "uidB");
  assert.equal(await b.has("gmail/work"), true, "the name is visible, the value is not");
  await assert.rejects(b.get("gmail/work"), codeIs("corrupt"));

  // Same key material, wrong scope: the AAD alone is enough to refuse.
  const wrongScope = new EncryptedFileSecretStore({
    backend: "cloud",
    file: fileA,
    keys: tenantKey(() => SESSION_SECRET, "uidA"),
    scope: "uid:uidB",
  });
  await assert.rejects(wrongScope.get("gmail/work"), codeIs("corrupt"));
});

test("cloud store: a rotated session secret fails closed", async () => {
  const home = tmpDir();
  await cloudStore(home, "uidA").set("gmail/work", VALUE_A);
  const rotated = cloudStore(home, "uidA", "r".repeat(96));
  await assert.rejects(rotated.get("gmail/work"), codeIs("corrupt"));
  const missing = cloudStore(home, "uidA", "");
  await assert.rejects(missing.get("gmail/work"), codeIs("unavailable"));
  await assert.rejects(missing.set("x", VALUE_B), codeIs("unavailable"));
});

test("tenantKey: deterministic per (secret, uid), distinct across uids", () => {
  const k1 = tenantKey(() => SESSION_SECRET, "uidA").load({ create: false });
  const k2 = tenantKey(() => SESSION_SECRET, "uidA").load({ create: false });
  const k3 = tenantKey(() => SESSION_SECRET, "uidB").load({ create: false });
  assert.equal(k1.length, 32);
  assert.equal(k1.equals(k2), true);
  assert.equal(k1.equals(k3), false);
});
