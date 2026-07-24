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
  upsertGoogleAccount,
  deleteAccount,
  getAccount,
  getAccountByEmail,
  sessionAccountValid,
  resetLoginThrottles,
  appleUid,
  googleUid,
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

describe("google accounts (S1)", () => {
  test("first sign-in creates a verified google account; second reuses it", async () => {
    const a = await upsertGoogleAccount("110169484474386276334", "user@gmail.com", true, 1000);
    assert.equal(a.uid, "google-110169484474386276334");
    assert.equal(a.kind, "google");
    assert.equal(a.verified, true);
    assert.equal(a.googleSub, "110169484474386276334");
    const b = await upsertGoogleAccount("110169484474386276334", "user@gmail.com", true, 2000);
    assert.equal(b.uid, a.uid);
    assert.equal(b.lastLoginAt, 2000);
  });

  test("merges into an existing VERIFIED same-email account — one uid, one Lisa", async () => {
    const email = await createEmailAccount("user@gmail.com", "password-123");
    // level the account to verified (as the B8a mail flow would)
    const seeded = await upsertGoogleAccount("42", "other@gmail.com", true, 500); // unrelated
    assert.notEqual(seeded.uid, email.uid);
    // mark verified by simulating the verification outcome
    const { beginEmailVerification, confirmEmailVerification } = await import("./accounts.js");
    const raw = await beginEmailVerification(email.uid);
    assert.ok(raw);
    await confirmEmailVerification(raw!);
    const merged = await upsertGoogleAccount("110169484474386276334", "User@Gmail.com", true, 3000);
    assert.equal(merged.uid, email.uid); // linked, not a new account
    assert.equal(merged.googleSub, "110169484474386276334");
    // subsequent Google sign-ins land on the merged uid
    const again = await upsertGoogleAccount("110169484474386276334", "user@gmail.com", true, 4000);
    assert.equal(again.uid, email.uid);
  });

  test("never merges into an UNVERIFIED same-email account (squatter defense)", async () => {
    const squatter = await createEmailAccount("victim@gmail.com", "password-123");
    assert.equal(squatter.verified, false);
    const g = await upsertGoogleAccount("777", "victim@gmail.com", true, 1000);
    assert.notEqual(g.uid, squatter.uid);
    assert.equal(g.uid, googleUid("777"));
  });

  test("no merge without Google's email_verified assertion", async () => {
    const email = await createEmailAccount("user2@gmail.com", "password-123");
    const { beginEmailVerification, confirmEmailVerification } = await import("./accounts.js");
    const raw = await beginEmailVerification(email.uid);
    await confirmEmailVerification(raw!);
    const g = await upsertGoogleAccount("888", "user2@gmail.com", false, 1000);
    assert.notEqual(g.uid, email.uid);
    assert.equal(g.verified, false); // email_verified: false carries through
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
