import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAccount,
  loadAccounts,
  getAccount,
  getSecret,
  setSecret,
  removeAccount,
  setAccountEnabled,
  markSwept,
} from "./accounts.js";

async function withHome(fn: () => void | Promise<void>): Promise<void> {
  const prev = process.env.LISA_HOME;
  const home = mkdtempSync(join(tmpdir(), "lisa-mail-"));
  process.env.LISA_HOME = home;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.LISA_HOME;
    else process.env.LISA_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("addAccount persists the account + secret; getSecret round-trips", async () => {
  await withHome(async () => {
    const a = await addAccount(
      { provider: "imap", email: "me@qq.com", host: "imap.qq.com" },
      { password: "app-pw" },
    );
    assert.equal(a.provider, "imap");
    assert.equal(a.port, 993);
    assert.equal(loadAccounts().length, 1);
    assert.equal(getAccount(a.id)?.email, "me@qq.com");
    assert.equal((await getSecret(a.id))?.password, "app-pw");
  });
});

test("secrets file is written 0600", async () => {
  await withHome(async () => {
    const a = await addAccount(
      { provider: "imap", email: "me@x.com", host: "imap.x.com" },
      { password: "s" },
    );
    const mode = statSync(join(process.env.LISA_HOME!, "mail", "secrets.json")).mode & 0o777;
    assert.equal(mode, 0o600);
    await setSecret(a.id, { password: "s2" });
    assert.equal((await getSecret(a.id))?.password, "s2");
  });
});

test("removeAccount drops the account and its secret", async () => {
  await withHome(async () => {
    const a = await addAccount(
      { provider: "imap", email: "me@x.com", host: "imap.x.com" },
      { password: "s" },
    );
    assert.equal(await removeAccount(a.id), true);
    assert.equal(loadAccounts().length, 0);
    assert.equal(await getSecret(a.id), undefined);
    assert.equal(await removeAccount("nope"), false);
  });
});

test("enable/disable + markSwept mutate the account", async () => {
  await withHome(async () => {
    const a = await addAccount(
      { provider: "imap", email: "me@x.com", host: "imap.x.com" },
      { password: "s" },
    );
    assert.equal(setAccountEnabled(a.id, false), true);
    assert.equal(getAccount(a.id)?.enabled, false);
    markSwept(a.id, 12345);
    assert.equal(getAccount(a.id)?.lastSweepAt, 12345);
  });
});

test("legacy Gmail credentials migrate to references only after verified secret storage", async () => {
  await withHome(async () => {
    const directory = join(process.env.LISA_HOME!, "mail");
    mkdirSync(directory);
    const file = join(directory, "secrets.json");
    writeFileSync(
      file,
      JSON.stringify({ old: { refreshToken: "old-refresh-token", clientId: "old-client" } }),
      { mode: 0o600 },
    );
    assert.equal((await getSecret("old"))?.refreshToken, "old-refresh-token");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { old: { secretRef: "mail/old" } });
    assert.equal((await getSecret("old"))?.refreshToken, "old-refresh-token");
    await setSecret("old", { accessToken: "new-access" });
    assert.equal((await getSecret("old"))?.refreshToken, "old-refresh-token");
  });
});

test("corrupt mail secret migration fails closed without overwriting the source", async () => {
  await withHome(async () => {
    const directory = join(process.env.LISA_HOME!, "mail");
    mkdirSync(directory);
    const file = join(directory, "secrets.json");
    for (const text of [
      "{bad",
      "[]",
      '{"old":42}',
      '{"old":"bad"}',
      '{"__proto__":{"password":"bad"}}',
      '{"old":{"secretRef":"mail/another"}}',
    ]) {
      writeFileSync(file, text, { mode: 0o600 });
      await assert.rejects(getSecret("old"), /mail_store_corrupt/);
      await assert.rejects(setSecret("new", { password: "no-overwrite" }), /mail_store_corrupt/);
      assert.equal(readFileSync(file, "utf8"), text);
    }
  });
});

test("mail secret references stay in the active home and never migrate another home", async () => {
  const { homeScope } = await import("../paths.js");
  await withHome(async () => {
    await setSecret("same", { password: "global" });
    await homeScope.run(join(process.env.LISA_HOME!, "isolated"), async () => {
      assert.equal(await getSecret("same"), undefined);
      await setSecret("same", { password: "scoped" });
      assert.equal((await getSecret("same"))?.password, "scoped");
    });
    assert.equal((await getSecret("same"))?.password, "global");
  });
});

test("failed SecretStore migration retains the legacy credential file", async () => {
  await withHome(async () => {
    const directory = join(process.env.LISA_HOME!, "mail");
    mkdirSync(directory);
    const file = join(directory, "secrets.json"),
      legacy = JSON.stringify({ old: { password: "legacy-value" } });
    writeFileSync(file, legacy, { mode: 0o600 });
    const previous = process.env.LISA_SECRETS_BACKEND;
    process.env.LISA_SECRETS_BACKEND = "unavailable-fixture";
    try {
      await assert.rejects(getSecret("old"));
      assert.equal(readFileSync(file, "utf8"), legacy);
    } finally {
      if (previous === undefined) delete process.env.LISA_SECRETS_BACKEND;
      else process.env.LISA_SECRETS_BACKEND = previous;
    }
  });
});
