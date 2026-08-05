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
  upsertGoogleAccount,
  googleUid,
  AccountError,
  AccountStoreError,
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

  test("a corrupt account store fails closed and is never overwritten", async () => {
    const corrupt = "{\"uid\":\"not-an-array\"}";
    fs.writeFileSync(FILE, corrupt);
    await assert.rejects(getAccount("em-any"), AccountStoreError);
    await assert.rejects(createEmailAccount("a@b.co", "password-123"), AccountStoreError);
    assert.equal(fs.readFileSync(FILE, "utf8"), corrupt);
  });

  test("one malformed record fails the whole store instead of being dropped", async () => {
    const mixed = JSON.stringify([
      {
        uid: "em-valid",
        kind: "email",
        createdAt: 1,
        lastLoginAt: 1,
        verified: true,
        sessionVersion: 0,
      },
      { kind: "email", sessionVersion: 0 },
    ]);
    fs.writeFileSync(FILE, mixed);
    await assert.rejects(getAccount("em-valid"), AccountStoreError);
    assert.equal(fs.readFileSync(FILE, "utf8"), mixed);
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

  test("a code verifies an existing unverified password account (levels the free window)", async () => {
    const made = await createEmailAccount("a@b.co", "password-123");
    assert.equal(made.verified, false);
    const { acct, created } = await ensureOtpAccount("a@b.co", 3000);
    assert.equal(created, false);
    assert.equal(acct.uid, made.uid);
    assert.equal(acct.verified, true);
  });

  test("SECURITY: a code sign-in drops a password set before ownership was proven", async () => {
    // The pre-hijacking scenario. /api/auth/register is open, so an attacker
    // pre-creates the victim's address with a password they know...
    const victimUid = (await createEmailAccount("victim@x.co", "attacker-set-pw")).uid;
    const beforeSv = (await getAccount(victimUid))!.sessionVersion;
    // ...then the real owner signs in by code (proving they read the inbox).
    const { acct } = await ensureOtpAccount("victim@x.co", 3000);
    assert.equal(acct.uid, victimUid, "same account — balance isn't forked");
    // The attacker's password must no longer authenticate, and any session it
    // minted must be invalidated (sessionVersion rotated).
    assert.equal(await verifyEmailLogin("victim@x.co", "attacker-set-pw", 4000), null,
      "the pre-set password must stop working");
    assert.equal((await getAccount(victimUid))!.scrypt, undefined, "the password is dropped");
    assert.equal((await getAccount(victimUid))!.sessionVersion, beforeSv + 1, "sessions are invalidated");
  });

  test("SECURITY: only the FIRST verification rotates — a re-verify is a no-op", async () => {
    // The drop+rotate is the untrusted unverified→verified transition ONLY. Once
    // an account is verified it belongs to the owner, so a later code sign-in
    // must not keep rotating sessionVersion (which would log the owner out on
    // every sign-in) or otherwise disturb it.
    const made = await createEmailAccount("a@b.co", "password-123"); // unverified
    await ensureOtpAccount("a@b.co", 2000); // first verification: drop pw, rotate
    const afterFirst = (await getAccount(made.uid))!;
    assert.equal(afterFirst.verified, true);
    assert.equal(afterFirst.scrypt, undefined);
    assert.equal(afterFirst.sessionVersion, made.sessionVersion + 1);
    await ensureOtpAccount("a@b.co", 3000); // second code sign-in: no-op on creds
    const afterSecond = (await getAccount(made.uid))!;
    assert.equal(afterSecond.sessionVersion, afterFirst.sessionVersion, "no further rotation");
  });

  test("a malformed address is refused", async () => {
    await assert.rejects(ensureOtpAccount("not-an-email", 1000), isCode("invalid_email"));
  });
});

describe("google accounts", () => {
  test("first sign-in creates a verified google account", async () => {
    const a = await upsertGoogleAccount("108123", "User@Example.com", 1000);
    assert.equal(a.uid, googleUid("108123"));
    assert.equal(a.kind, "google");
    assert.equal(a.email, "user@example.com");
    assert.equal(a.verified, true);
    assert.equal(a.googleSub, "108123");
  });

  test("the sub is the anchor: a changed address keeps the same account", async () => {
    const first = await upsertGoogleAccount("108123", "old@example.com", 1000);
    const second = await upsertGoogleAccount("108123", "new@example.com", 2000);
    assert.equal(second.uid, first.uid);
    assert.equal(second.email, "new@example.com");
    assert.equal(second.lastLoginAt, 2000);
  });

  test("binds to an existing email account instead of splitting the balance", async () => {
    const made = await createEmailAccount("a@b.co", "password-123");
    assert.equal(made.verified, false);
    const g = await upsertGoogleAccount("108123", "a@b.co", 2000);
    assert.equal(g.uid, made.uid, "same account — same uid, same balance");
    assert.equal(g.kind, "email", "the original kind is kept; Google is now also an entrance");
    assert.equal(g.googleSub, "108123");
    assert.equal(g.verified, true, "Google vouched for the inbox");
    // The code path still opens the same account.
    assert.equal((await ensureOtpAccount("a@b.co", 3000)).acct.uid, made.uid);
  });

  test("SECURITY: a Google bind drops a password set before ownership was proven", async () => {
    // Same pre-hijacking guard as the OTP path: an attacker's pre-set password
    // must not survive the victim proving inbox ownership via Google.
    const victimUid = (await createEmailAccount("victim@x.co", "attacker-set-pw")).uid;
    const beforeSv = (await getAccount(victimUid))!.sessionVersion;
    const g = await upsertGoogleAccount("108123", "victim@x.co", 2000);
    assert.equal(g.uid, victimUid, "same account — balance isn't forked");
    assert.equal(await verifyEmailLogin("victim@x.co", "attacker-set-pw", 3000), null,
      "the pre-set password must stop working");
    assert.equal((await getAccount(victimUid))!.scrypt, undefined, "the password is dropped");
    assert.equal((await getAccount(victimUid))!.sessionVersion, beforeSv + 1, "sessions are invalidated");
  });

  test("a mailed code signs into a google-owned address rather than forking", async () => {
    const g = await upsertGoogleAccount("108123", "a@b.co", 1000);
    const viaCode = await ensureOtpAccount("a@b.co", 2000);
    assert.equal(viaCode.created, false);
    assert.equal(viaCode.acct.uid, g.uid);
  });

  test("registering a password over a google-owned address is refused", async () => {
    await upsertGoogleAccount("108123", "a@b.co", 1000);
    await assert.rejects(createEmailAccount("a@b.co", "password-123"), isCode("email_taken"));
  });

  test("a google account cannot be password-authenticated", async () => {
    await upsertGoogleAccount("108123", "a@b.co", 1000);
    assert.equal(await verifyEmailLogin("a@b.co", "password-123", 2000), null);
  });

  test("apple accounts do not bind by address (private relay aliases)", async () => {
    const apple = await upsertAppleAccount("001.abc", "a@b.co", 1000);
    const g = await upsertGoogleAccount("108123", "a@b.co", 2000);
    assert.notEqual(g.uid, apple.uid);
    assert.equal(g.kind, "google");
  });

  test("googleUid sanitizes hostile subs", () => {
    assert.ok(!googleUid("a/b").includes("/"));
    assert.ok(!googleUid("../../etc").includes("/"));
  });

  test("a malformed address is refused", async () => {
    await assert.rejects(upsertGoogleAccount("108123", "not-an-email", 1000), isCode("invalid_email"));
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
