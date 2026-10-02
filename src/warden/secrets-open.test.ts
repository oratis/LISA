import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-secrets-open-"));
const PRIOR_HOME = process.env.LISA_HOME;
process.env.LISA_HOME = TMP;
after(() => {
  if (PRIOR_HOME === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = PRIOR_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const { homeForUid, homeScope } = await import("../paths.js");
const { SecretStoreError } = await import("./secrets.js");
const { openSecretStore, selectSecretBackend } = await import("./secrets-open.js");
const { KEYCHAIN_SERVICE } = await import("./secrets-keychain.js");
type SecurityRunner = import("./secrets-keychain.js").SecurityRunner;

/** Built at runtime so no literal in this file looks like a real credential. */
const VALUE_A = ["open", "value", "alpha", "0001"].join("-");
const VALUE_B = ["open", "value", "bravo", "0002"].join("-");
const SESSION_SECRET = "s".repeat(96);
const DEFAULT_HOME = path.join(os.homedir(), ".lisa");

function codeIs(code: string) {
  return (e: unknown) => e instanceof SecretStoreError && e.code === code;
}

test("backend selection", () => {
  const pick = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string) =>
    selectSecretBackend({ env, platform, home });

  assert.equal(pick({}, "darwin", DEFAULT_HOME), "keychain");
  assert.equal(pick({}, "darwin", TMP), "file", "an overridden home never uses the Keychain");
  assert.equal(pick({}, "linux", DEFAULT_HOME), "file");
  assert.equal(pick({}, "win32", DEFAULT_HOME), "file");

  assert.equal(pick({ LISA_SECRETS_BACKEND: "file" }, "darwin", DEFAULT_HOME), "file");
  assert.equal(pick({ LISA_SECRETS_BACKEND: " Keychain " }, "darwin", TMP), "keychain");
  assert.throws(
    () => pick({ LISA_SECRETS_BACKEND: "keychain" }, "linux", TMP),
    codeIs("unavailable"),
  );
  assert.throws(
    () => pick({ LISA_SECRETS_BACKEND: "vault" }, "darwin", TMP),
    codeIs("unavailable"),
  );

  // Cloud wins over everything, including a forced local backend.
  assert.equal(pick({ LISA_EDITION: "cloud" }, "darwin", DEFAULT_HOME), "cloud");
  assert.equal(
    pick({ LISA_EDITION: "cloud", LISA_SECRETS_BACKEND: "keychain" }, "linux", TMP),
    "cloud",
  );
});

test("under the test home the default store is the encrypted file, even on macOS", async () => {
  const store = openSecretStore({ env: {}, platform: "darwin" });
  assert.equal(store.backend, "file");
  await store.set("smtp", VALUE_A);
  assert.equal(await store.get("smtp"), VALUE_A);
  assert.deepEqual(fs.readdirSync(path.join(TMP, "warden")).sort(), [
    "secret.key",
    "secrets.enc.json",
  ]);
});

test("keychain store is namespaced when forced onto a non-default home", async () => {
  const seen: string[][] = [];
  const runner: SecurityRunner = (args, stdin) => {
    seen.push(args[0] === "-i" ? (stdin ?? "").trim().split(/\s+/) : [...args]);
    return Promise.resolve({ code: 44, stdout: "" });
  };
  const serviceOf = async (home: string) => {
    seen.length = 0;
    const store = openSecretStore({
      env: { LISA_SECRETS_BACKEND: "keychain" },
      platform: "darwin",
      home,
      runner,
    });
    assert.equal(store.backend, "keychain");
    assert.equal(await store.has("smtp"), false);
    return seen[0]![seen[0]!.indexOf("-s") + 1]!;
  };
  assert.equal(await serviceOf(DEFAULT_HOME), KEYCHAIN_SERVICE);
  const scratch = await serviceOf(path.join(TMP, "scratch-home"));
  assert.match(scratch, /^ai\.lisa\.secrets\.[0-9a-f]{12}$/);
  assert.notEqual(scratch, await serviceOf(path.join(TMP, "another-home")));
});

test("cloud: no tenant scope, no store", () => {
  const env = { LISA_EDITION: "cloud" };
  const sessionSecret = () => SESSION_SECRET;
  assert.throws(() => openSecretStore({ env, sessionSecret }), codeIs("unavailable"));
  for (const uid of ["", "../em-1", "a/b", "em 1", ".hidden"]) {
    assert.throws(() => openSecretStore({ env, sessionSecret, uid }), codeIs("unavailable"), uid);
  }
});

test("cloud: the request scope picks the tenant, and tenants are isolated", async () => {
  const env = { LISA_EDITION: "cloud" };
  const sessionSecret = () => SESSION_SECRET;
  const inScope = <T>(uid: string, fn: () => Promise<T>) => homeScope.run(homeForUid(uid), fn);

  await inScope("em-aaaa", async () => {
    const store = openSecretStore({ env, sessionSecret });
    assert.equal(store.backend, "cloud");
    await store.set("gmail/work", VALUE_A);
  });
  await inScope("em-bbbb", async () => {
    const store = openSecretStore({ env, sessionSecret });
    assert.equal(await store.get("gmail/work"), null, "B sees nothing of A's");
    await store.set("gmail/work", VALUE_B);
    // A request scoped to B cannot open A's store by naming A's uid.
    assert.throws(
      () => openSecretStore({ env, sessionSecret, uid: "em-aaaa" }),
      codeIs("unavailable"),
    );
  });
  await inScope("em-aaaa", async () => {
    assert.equal(await openSecretStore({ env, sessionSecret }).get("gmail/work"), VALUE_A);
  });

  const fileA = path.join(homeForUid("em-aaaa"), "warden", "secrets.enc.json");
  const fileB = path.join(homeForUid("em-bbbb"), "warden", "secrets.enc.json");
  assert.equal(fs.existsSync(fileA) && fs.existsSync(fileB), true);
  // B's ciphertext replaced by A's: B's key and AAD must refuse it.
  fs.copyFileSync(fileA, fileB);
  await inScope("em-bbbb", async () => {
    await assert.rejects(
      openSecretStore({ env, sessionSecret }).get("gmail/work"),
      codeIs("corrupt"),
    );
  });
});
