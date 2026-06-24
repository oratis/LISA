import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
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
  await withHome(() => {
    const a = addAccount({ provider: "imap", email: "me@qq.com", host: "imap.qq.com" }, { password: "app-pw" });
    assert.equal(a.provider, "imap");
    assert.equal(a.port, 993);
    assert.equal(loadAccounts().length, 1);
    assert.equal(getAccount(a.id)?.email, "me@qq.com");
    assert.equal(getSecret(a.id)?.password, "app-pw");
  });
});

test("secrets file is written 0600", async () => {
  await withHome(() => {
    const a = addAccount({ provider: "imap", email: "me@x.com", host: "imap.x.com" }, { password: "s" });
    const mode = statSync(join(process.env.LISA_HOME!, "mail", "secrets.json")).mode & 0o777;
    assert.equal(mode, 0o600);
    setSecret(a.id, { password: "s2" });
    assert.equal(getSecret(a.id)?.password, "s2");
  });
});

test("removeAccount drops the account and its secret", async () => {
  await withHome(() => {
    const a = addAccount({ provider: "imap", email: "me@x.com", host: "imap.x.com" }, { password: "s" });
    assert.equal(removeAccount(a.id), true);
    assert.equal(loadAccounts().length, 0);
    assert.equal(getSecret(a.id), undefined);
    assert.equal(removeAccount("nope"), false);
  });
});

test("enable/disable + markSwept mutate the account", async () => {
  await withHome(() => {
    const a = addAccount({ provider: "imap", email: "me@x.com", host: "imap.x.com" }, { password: "s" });
    assert.equal(setAccountEnabled(a.id, false), true);
    assert.equal(getAccount(a.id)?.enabled, false);
    markSwept(a.id, 12345);
    assert.equal(getAccount(a.id)?.lastSweepAt, 12345);
  });
});
