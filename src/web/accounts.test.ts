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

  test("a concurrent burst of wrong guesses can't outrun the lockout (in-flight guard)", async () => {
    await createEmailAccount("a@b.co", "password-123");
    // Fire 10 at once. scrypt is async, so without the per-email in-flight guard
    // all 10 would clear the throttle check and run before any failure recorded.
    // With it, only one password check proceeds; the rest reject as throttled —
    // so a burst is forced back into serial attempts that DO hit the 5-try lock.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => verifyEmailLogin("a@b.co", "wrong")),
    );
    const rejected = results.filter((r) => r.status === "rejected").length;
    const ran = results.filter((r) => r.status === "fulfilled" && r.value === null).length;
    assert.ok(rejected >= 1, "concurrent guesses beyond the first must reject as in-flight");
    assert.equal(rejected + ran, 10);
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
