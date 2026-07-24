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
  ensureOtpAccount,
  AccountError,
} = await import("./accounts.js");

const isCode = (code: string) => (e: unknown) => (e as InstanceType<typeof AccountError>).code === code;

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
  resetLoginThrottles();
});

describe("email accounts", () => {
  test("register → login round-trip; email is normalized", async () => {
    const rec = await createEmailAccount("  Reviewer@MeetLisa.AI ", "correct-horse-1");
    assert.match(rec.uid, /^em-[0-9a-f]{18}$/);
    assert.equal(rec.email, "reviewer@meetlisa.ai");
    assert.equal(rec.verified, false);
    const back = await verifyEmailLogin("reviewer@meetlisa.ai", "correct-horse-1");
    assert.equal(back?.uid, rec.uid);
  });

  test("wrong password / unknown email → null (no throw, no enumeration)", async () => {
    await createEmailAccount("a@b.co", "password-123");
    assert.equal(await verifyEmailLogin("a@b.co", "wrong-password"), null);
    assert.equal(await verifyEmailLogin("nobody@b.co", "password-123"), null);
  });

  test("invalid email / weak password / duplicate → typed AccountError", async () => {
    await assert.rejects(createEmailAccount("not-an-email", "password-123"), isCode("invalid_email"));
    await assert.rejects(createEmailAccount("a@b.co", "short"), isCode("weak_password"));
    await createEmailAccount("a@b.co", "password-123");
    await assert.rejects(createEmailAccount("A@B.CO", "password-456"), isCode("email_taken"));
  });

  test("raw password never persisted; store is 0600", { skip: process.platform === "win32" }, async () => {
    await createEmailAccount("a@b.co", "super-secret-pw");
    const raw = fs.readFileSync(FILE, "utf8");
    assert.equal(raw.includes("super-secret-pw"), false);
    assert.match(raw, /scrypt/);
    assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  });

  test("5 failures lock the email for 15 min; correct password clears the count", async () => {
    await createEmailAccount("a@b.co", "password-123");
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) assert.equal(await verifyEmailLogin("a@b.co", "wrong", t0), null);
    await assert.rejects(verifyEmailLogin("a@b.co", "password-123", t0 + 1), isCode("throttled"));
    // lock expires
    const after = await verifyEmailLogin("a@b.co", "password-123", t0 + 16 * 60 * 1000);
    assert.equal(after?.email, "a@b.co");
  });
});

describe("code-only (OTP) accounts", () => {
  test("first code creates a verified, passwordless account", async () => {
    const { acct, created } = await ensureOtpAccount("New@Example.com", 1000);
    assert.equal(created, true);
    assert.equal(acct.kind, "email");
    assert.equal(acct.email, "new@example.com");
    assert.equal(acct.verified, true, "reading the mail proved ownership");
    assert.equal(acct.scrypt, undefined, "no password material");
  });

  test("a later code signs into the same account rather than making a second", async () => {
    const first = await ensureOtpAccount("a@b.co", 1000);
    const second = await ensureOtpAccount("a@b.co", 2000);
    assert.equal(second.created, false);
    assert.equal(second.acct.uid, first.acct.uid);
    assert.equal(second.acct.lastLoginAt, 2000);
  });

  test("a passwordless account cannot be logged into with any password", async () => {
    const { acct } = await ensureOtpAccount("a@b.co", 1000);
    assert.equal(await verifyEmailLogin("a@b.co", "password-123", 2000), null);
    assert.equal(await verifyEmailLogin("a@b.co", "", 2000), null);
    assert.equal((await getAccount(acct.uid))?.uid, acct.uid, "the account still exists");
  });

  test("a code verifies an existing unverified password account, dropping the pre-verification password", async () => {
    const made = await createEmailAccount("a@b.co", "password-123");
    assert.equal(made.verified, false);
    assert.equal(made.sessionVersion, 0);
    const { acct, created } = await ensureOtpAccount("a@b.co", 3000);
    assert.equal(created, false);
    assert.equal(acct.uid, made.uid);
    assert.equal(acct.verified, true);
    // /api/auth/register is open, so a password set before ownership was proven
    // can't be trusted. Signing in by code drops it and rotates sessionVersion, so
    // the pre-set password no longer authenticates (anti account-pre-hijacking).
    assert.equal(acct.scrypt, undefined, "pre-verification password dropped");
    assert.equal(acct.sessionVersion, 1, "sessionVersion rotated to kill prior sessions");
    assert.equal(await verifyEmailLogin("a@b.co", "password-123", 4000), null, "the pre-set password no longer works");
  });

  test("account pre-hijacking is closed: an attacker's pre-set password can't survive the victim's code sign-in", async () => {
    // Attacker pre-registers the victim's address with a password they know.
    const attacker = await createEmailAccount("victim@x.co", "attacker-knows-this");
    assert.equal(attacker.verified, false);
    // Victim signs in by mailed code (proving they, not the attacker, own the inbox).
    const { acct } = await ensureOtpAccount("victim@x.co", 5000);
    assert.equal(acct.uid, attacker.uid, "same record — the code adopts the existing account");
    // The attacker can no longer authenticate with the password they set.
    assert.equal(
      await verifyEmailLogin("victim@x.co", "attacker-knows-this", 6000),
      null,
      "attacker's pre-set password is invalidated on the victim's ownership proof",
    );
  });

  test("a malformed address is refused", async () => {
    await assert.rejects(ensureOtpAccount("not-an-email", 1000), isCode("invalid_email"));
  });
});

describe("apple accounts", () => {
  test("upsert creates once, then updates lastLoginAt; uid is fs-safe", async () => {
    const a = await upsertAppleAccount("001234.abcdef.5678", "user@example.com", 1000);
    assert.equal(a.uid, "apple-001234.abcdef.5678");
    assert.equal(a.verified, true);
    const b = await upsertAppleAccount("001234.abcdef.5678", undefined, 2000);
    assert.equal(b.uid, a.uid);
    assert.equal(b.lastLoginAt, 2000);
    assert.equal(b.email, "user@example.com"); // kept from first sign-in
  });

  test("appleUid sanitizes hostile subs", () => {
    assert.ok(!appleUid("a/b").includes("/"));
    assert.ok(!appleUid("../../etc").includes("/"));
  });
});

describe("deletion + session validity", () => {
  test("delete kills the record and its sessions via sv-check", async () => {
    const rec = await createEmailAccount("a@b.co", "password-123");
    assert.equal(await sessionAccountValid(rec.uid, rec.sessionVersion), true);
    assert.equal(await sessionAccountValid(rec.uid, rec.sessionVersion + 1), false);
    assert.equal(await deleteAccount(rec.uid), true);
    assert.equal(await sessionAccountValid(rec.uid, rec.sessionVersion), false);
    assert.equal(await getAccount(rec.uid), null);
    assert.equal(await getAccountByEmail("a@b.co"), null);
    assert.equal(await deleteAccount(rec.uid), false);
  });
});
