import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-accounts-"));
process.env.LISA_HOME = TMP;
const FILE = path.join(TMP, "accounts.json");

const {
  createEmailAccount,
  verifyEmailLogin,
  upsertAppleAccount,
  deleteAccount,
  getAccount,
  getAccountByEmail,
  sessionAccountValid,
  resetLoginThrottles,
  appleUid,
  AccountError,
} = await import("./accounts.js");

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
  resetLoginThrottles();
});

describe("email accounts", () => {
  test("register → login round-trip; email is normalized", () => {
    const rec = createEmailAccount("  Reviewer@MeetLisa.AI ", "correct-horse-1");
    assert.match(rec.uid, /^em-[0-9a-f]{18}$/);
    assert.equal(rec.email, "reviewer@meetlisa.ai");
    assert.equal(rec.verified, false);
    const back = verifyEmailLogin("reviewer@meetlisa.ai", "correct-horse-1");
    assert.equal(back?.uid, rec.uid);
  });

  test("wrong password / unknown email → null (no throw, no enumeration)", () => {
    createEmailAccount("a@b.co", "password-123");
    assert.equal(verifyEmailLogin("a@b.co", "wrong-password"), null);
    assert.equal(verifyEmailLogin("nobody@b.co", "password-123"), null);
  });

  test("invalid email / weak password / duplicate → typed AccountError", () => {
    assert.throws(() => createEmailAccount("not-an-email", "password-123"), (e: unknown) => (e as InstanceType<typeof AccountError>).code === "invalid_email");
    assert.throws(() => createEmailAccount("a@b.co", "short"), (e: unknown) => (e as InstanceType<typeof AccountError>).code === "weak_password");
    createEmailAccount("a@b.co", "password-123");
    assert.throws(() => createEmailAccount("A@B.CO", "password-456"), (e: unknown) => (e as InstanceType<typeof AccountError>).code === "email_taken");
  });

  test("raw password never persisted; store is 0600", { skip: process.platform === "win32" }, () => {
    createEmailAccount("a@b.co", "super-secret-pw");
    const raw = fs.readFileSync(FILE, "utf8");
    assert.equal(raw.includes("super-secret-pw"), false);
    assert.match(raw, /scrypt/);
    assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  });

  test("5 failures lock the email for 15 min; correct password clears the count", () => {
    createEmailAccount("a@b.co", "password-123");
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) assert.equal(verifyEmailLogin("a@b.co", "wrong", t0), null);
    assert.throws(() => verifyEmailLogin("a@b.co", "password-123", t0 + 1), (e: unknown) => (e as InstanceType<typeof AccountError>).code === "throttled");
    // lock expires
    const after = verifyEmailLogin("a@b.co", "password-123", t0 + 16 * 60 * 1000);
    assert.equal(after?.email, "a@b.co");
  });
});

describe("apple accounts", () => {
  test("upsert creates once, then updates lastLoginAt; uid is fs-safe", () => {
    const a = upsertAppleAccount("001234.abcdef.5678", "user@example.com", 1000);
    assert.equal(a.uid, "apple-001234.abcdef.5678");
    assert.equal(a.verified, true);
    const b = upsertAppleAccount("001234.abcdef.5678", undefined, 2000);
    assert.equal(b.uid, a.uid);
    assert.equal(b.lastLoginAt, 2000);
    assert.equal(b.email, "user@example.com"); // kept from first sign-in
  });

  test("appleUid sanitizes hostile subs", () => {
    assert.equal(appleUid("../../etc"), "apple-.._.._etc".replace("__", "__"));
    assert.ok(!appleUid("a/b").includes("/"));
  });
});

describe("deletion + session validity", () => {
  test("delete kills the record and its sessions via sv-check", () => {
    const rec = createEmailAccount("a@b.co", "password-123");
    assert.equal(sessionAccountValid(rec.uid, rec.sessionVersion), true);
    assert.equal(sessionAccountValid(rec.uid, rec.sessionVersion + 1), false);
    assert.equal(deleteAccount(rec.uid), true);
    assert.equal(sessionAccountValid(rec.uid, rec.sessionVersion), false);
    assert.equal(getAccount(rec.uid), null);
    assert.equal(getAccountByEmail("a@b.co"), null);
    assert.equal(deleteAccount(rec.uid), false);
  });
});
