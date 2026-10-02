/**
 * The Keychain backend is tested ONLY through an injected runner — a small
 * in-memory stand-in for `/usr/bin/security`. Nothing here, or anywhere else in
 * the suite, runs the real binary; the last test pins that guarantee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretStoreError } from "./secrets.js";
import {
  KEYCHAIN_SERVICE,
  KEYCHAIN_VALUE_MAX_BYTES,
  KeychainSecretStore,
  defaultSecurityRunner,
  type SecurityCommandResult,
  type SecurityRunner,
} from "./secrets-keychain.js";

/** Built at runtime so no literal in this file looks like a real credential. */
const VALUE_A = ["keychain", "value", "alpha", "0001"].join("-");
const VALUE_B = ["keychain", "value", "bravo", "0002"].join("-");

function codeIs(code: string) {
  return (e: unknown) => e instanceof SecretStoreError && e.code === code;
}

interface Call {
  args: string[];
  stdin: string | undefined;
}

interface FakeKeychain {
  runner: SecurityRunner;
  calls: Call[];
  /** account → stored password, exactly as `security` would hold it. */
  items: Map<string, string>;
  /** Make the next matching subcommand misbehave. */
  fail: Map<string, SecurityCommandResult>;
  /** When true, `add-generic-password` reports success but stores nothing. */
  dropWrites: boolean;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function fakeKeychain(): FakeKeychain {
  const fake: FakeKeychain = {
    calls: [],
    items: new Map(),
    fail: new Map(),
    dropWrites: false,
    runner: (args, stdin) => {
      fake.calls.push({ args: [...args], stdin });
      // Interactive mode: one command per stdin line, whitespace-separated.
      const argv = args[0] === "-i" ? (stdin ?? "").trim().split(/\s+/) : [...args];
      const sub = argv[0]!;
      const forced = fake.fail.get(sub);
      if (forced) return Promise.resolve(forced);
      assert.equal(flag(argv, "-s"), KEYCHAIN_SERVICE);
      const account = flag(argv, "-a")!;
      if (sub === "add-generic-password") {
        assert.ok(argv.includes("-U"), "writes must be upserts");
        if (!fake.dropWrites) fake.items.set(account, flag(argv, "-w")!);
        return Promise.resolve({ code: 0, stdout: "" });
      }
      if (sub === "find-generic-password") {
        const item = fake.items.get(account);
        if (item === undefined) return Promise.resolve({ code: 44, stdout: "" });
        return Promise.resolve({
          code: 0,
          stdout: argv.includes("-w") ? item + "\n" : `    "acct"<blob>="${account}"\n`,
        });
      }
      if (sub === "delete-generic-password") {
        return Promise.resolve({ code: fake.items.delete(account) ? 0 : 44, stdout: "" });
      }
      return Promise.resolve({ code: 2, stdout: "" });
    },
  };
  return fake;
}

function setup(now: () => number = Date.now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-keychain-"));
  const indexFile = path.join(dir, "warden", "secrets.index.json");
  const fake = fakeKeychain();
  const store = new KeychainSecretStore({ indexFile, runner: fake.runner, now });
  return { store, fake, indexFile };
}

test("keychain store: round-trip, overwrite, has, remove", async () => {
  let clock = 100;
  const { store, fake } = setup(() => clock);
  assert.equal(store.backend, "keychain");
  assert.equal(await store.get("gmail/work"), null);
  assert.equal(await store.has("gmail/work"), false);
  await store.set("gmail/work", VALUE_A);
  await store.set("smtp", VALUE_A);
  clock = 200;
  await store.set("smtp", VALUE_B);
  assert.equal(await store.get("gmail/work"), VALUE_A);
  assert.equal(await store.get("smtp"), VALUE_B);
  assert.equal(await store.has("smtp"), true);
  assert.deepEqual(await store.list(), [
    { name: "gmail/work", createdAt: 100, updatedAt: 100 },
    { name: "smtp", createdAt: 100, updatedAt: 200 },
  ]);
  assert.equal(await store.remove("smtp"), true);
  assert.equal(await store.remove("smtp"), false);
  assert.equal(await store.get("smtp"), null);
  assert.deepEqual([...fake.items.keys()], ["gmail/work"]);
  assert.deepEqual(
    (await store.list()).map((m) => m.name),
    ["gmail/work"],
  );
});

test("keychain store: unicode, quotes and newlines survive the encoding", async () => {
  const { store, fake } = setup();
  const value = `multi\nline "quoted" 'single' \\back\tslash 钥匙 🔑 -w -U; rm`;
  await store.set("odd", value);
  assert.equal(await store.get("odd"), value);
  assert.match(fake.items.get("odd")!, /^v1\.[A-Za-z0-9_-]+$/);
});

test("keychain store: the value never appears in an argument list", async () => {
  const { store, fake } = setup();
  await store.set("smtp", VALUE_A);
  await store.get("smtp");
  await store.has("smtp");
  await store.remove("smtp");
  const spellings = [VALUE_A, Buffer.from(VALUE_A).toString("base64url")];
  let writes = 0;
  for (const call of fake.calls) {
    for (const arg of call.args) {
      for (const s of spellings)
        assert.equal(arg.includes(s), false, `argv leaked: ${call.args[0]}`);
    }
    if (call.stdin !== undefined) {
      writes++;
      assert.deepEqual(call.args, ["-i"], "a value may only travel on stdin of `security -i`");
      assert.equal(call.stdin.endsWith("\n"), true);
      assert.equal(call.stdin.trimEnd().includes("\n"), false, "exactly one command line");
      assert.ok(Buffer.byteLength(call.stdin) < 4096, "must fit security's line buffer");
      assert.match(call.stdin, /^[A-Za-z0-9 ._/-]+\n$/, "nothing the parser could quote or split");
    }
  }
  assert.equal(writes, 1);
});

test("keychain store: the largest accepted value still fits one line", async () => {
  const { store, fake } = setup();
  const name = "a".repeat(64) + "/" + "b".repeat(64);
  const value = "é".repeat(KEYCHAIN_VALUE_MAX_BYTES / 2);
  await store.set(name, value);
  assert.equal(await store.get(name), value);
  const line = fake.calls.find((c) => c.stdin !== undefined)!.stdin!;
  assert.ok(Buffer.byteLength(line) < 4096);

  const calls = fake.calls.length;
  await assert.rejects(
    store.set("big", "x".repeat(KEYCHAIN_VALUE_MAX_BYTES + 1)),
    codeIs("invalid_value"),
  );
  assert.equal(fake.calls.length, calls, "an oversized value must never reach security");
});

test("keychain store: the index holds names and timestamps only", async () => {
  const { store, indexFile } = setup(() => 5);
  await store.set("smtp", VALUE_A);
  const raw = fs.readFileSync(indexFile, "utf8");
  assert.deepEqual(JSON.parse(raw), {
    version: 1,
    names: { smtp: { createdAt: 5, updatedAt: 5 } },
  });
  for (const s of [VALUE_A, Buffer.from(VALUE_A).toString("base64url")]) {
    assert.equal(raw.includes(s), false);
  }
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(indexFile).mode & 0o777, 0o600);
  }
  assert.equal(JSON.stringify(await store.list()).includes(VALUE_A), false);
});

test("keychain store: a write the Keychain did not keep is an error, not a success", async () => {
  const { store, fake, indexFile } = setup();
  fake.dropWrites = true;
  await assert.rejects(store.set("smtp", VALUE_A), codeIs("backend_failed"));
  assert.equal(fs.existsSync(indexFile), false, "the index must not record a failed write");
  assert.deepEqual(await store.list(), []);

  fake.dropWrites = false;
  fake.fail.set("add-generic-password", { code: null, stdout: "" });
  await assert.rejects(store.set("smtp", VALUE_A), codeIs("backend_failed"));
});

test("keychain store: backend failures surface a status, never process output", async () => {
  const { store, fake } = setup();
  await store.set("smtp", VALUE_A);
  // A failing `security` could print anything; the store must not repeat it.
  fake.fail.set("find-generic-password", { code: 51, stdout: `leak ${VALUE_A}` });
  for (const op of [() => store.get("smtp"), () => store.has("smtp")]) {
    await assert.rejects(op(), (e: unknown) => {
      assert.ok(e instanceof SecretStoreError);
      assert.equal(e.code, "backend_failed");
      assert.match(e.message, /status 51/);
      assert.equal(`${e.message}\n${String(e.stack)}`.includes(VALUE_A), false);
      return true;
    });
  }
  fake.fail.clear();
  fake.fail.set("delete-generic-password", { code: 36, stdout: "" });
  await assert.rejects(store.remove("smtp"), codeIs("backend_failed"));
  assert.deepEqual(
    (await store.list()).map((m) => m.name),
    ["smtp"],
    "a failed delete must leave the index alone",
  );
});

test("keychain store: an item in an unexpected encoding fails closed", async () => {
  const { store, fake } = setup();
  for (const stored of ["plain-text-someone-typed", "v1.", "v1.not base64!", "v1.QQ=", "v2.QUJD"]) {
    fake.items.set("smtp", stored);
    await assert.rejects(store.get("smtp"), codeIs("corrupt"), stored);
  }
});

test("keychain store: a corrupt index stops a write before the Keychain changes", async () => {
  const { store, fake, indexFile } = setup();
  await store.set("smtp", VALUE_A);
  for (const bytes of [
    "{",
    "[]",
    JSON.stringify({ version: 9, names: {} }),
    '{"version":1,"names":{"Bad Name":{}}}',
  ]) {
    fs.writeFileSync(indexFile, bytes);
    const before = fake.calls.length;
    await assert.rejects(store.list(), codeIs("corrupt"));
    await assert.rejects(store.set("other", VALUE_B), codeIs("corrupt"));
    await assert.rejects(store.remove("smtp"), codeIs("corrupt"));
    assert.equal(fake.calls.length, before, "no Keychain call after a corrupt index");
    assert.equal(fs.readFileSync(indexFile, "utf8"), bytes);
    // Values do not depend on the index.
    assert.equal(await store.get("smtp"), VALUE_A);
  }
});

test("keychain store: names are validated before anything runs", async () => {
  const { store, fake } = setup();
  for (const bad of ["Bad", "a b", "-w", "a/b/c", "x; rm -rf", "a\nadd-generic-password"]) {
    await assert.rejects(store.set(bad, VALUE_A), codeIs("invalid_name"));
    await assert.rejects(store.get(bad), codeIs("invalid_name"));
    await assert.rejects(store.has(bad), codeIs("invalid_name"));
    await assert.rejects(store.remove(bad), codeIs("invalid_name"));
  }
  assert.equal(fake.calls.length, 0);
  assert.throws(
    () =>
      new KeychainSecretStore({
        indexFile: "/nonexistent/x",
        runner: fake.runner,
        service: "bad service",
      }),
    codeIs("unavailable"),
  );
});

test("the real security runner refuses to run under node --test", async () => {
  // Without an injected runner the store would reach /usr/bin/security. Under
  // the test runner that path is closed, so no test can touch a real Keychain.
  assert.ok(process.env.NODE_TEST_CONTEXT, "this suite must run under `node --test`");
  await assert.rejects(defaultSecurityRunner(["help"]), codeIs("unavailable"));
  const store = new KeychainSecretStore({
    indexFile: path.join(os.tmpdir(), "never-written.json"),
  });
  await assert.rejects(store.get("smtp"), codeIs("unavailable"));
  await assert.rejects(store.has("smtp"), codeIs("unavailable"));
});
