import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-verify-"));
process.env.LISA_HOME = TMP;
const FILE = path.join(TMP, "accounts.json");

const {
  createEmailAccount,
  beginEmailVerification,
  confirmEmailVerification,
  upsertAppleAccount,
  getAccount,
  beginAccountOtp,
  consumeAccountOtp,
  resetPasswordWithOtp,
  resetOtpCooldowns,
  resetLoginThrottles,
  verifyEmailLogin,
  AccountError,
} = await import("./accounts.js");
const { verificationEmail, otpEmail, mailerConfig, sendVerificationEmail } = await import("./mailer.js");

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
  resetOtpCooldowns();
  resetLoginThrottles();
});

describe("email verification", () => {
  test("begin → confirm levels the account to verified and clears the token", async () => {
    const rec = await createEmailAccount("a@b.co", "password-123");
    assert.equal(rec.verified, false);
    const raw = await beginEmailVerification(rec.uid, 1000);
    assert.ok(raw && raw.length >= 32);
    // raw token never persisted, only its hash
    assert.equal(fs.readFileSync(FILE, "utf8").includes(raw!), false);
    const confirmed = await confirmEmailVerification(raw!, 2000);
    assert.equal(confirmed?.uid, rec.uid);
    const after = await getAccount(rec.uid);
    assert.equal(after?.verified, true);
    assert.equal(after?.verifyTokenHash, undefined);
    // replay of the used token fails
    assert.equal(await confirmEmailVerification(raw!, 3000), null);
  });

  test("expired / wrong tokens fail; re-begin rotates the token", async () => {
    const rec = await createEmailAccount("c@d.co", "password-123");
    const raw1 = (await beginEmailVerification(rec.uid, 1000))!;
    // expired (25h later)
    assert.equal(await confirmEmailVerification(raw1, 1000 + 25 * 60 * 60 * 1000), null);
    // fresh token supersedes the old one
    const raw2 = (await beginEmailVerification(rec.uid, 2000))!;
    assert.notEqual(raw1, raw2);
    assert.equal(await confirmEmailVerification(raw1, 3000), null);
    assert.ok(await confirmEmailVerification(raw2, 3000));
  });

  test("apple accounts and already-verified accounts can't begin verification", async () => {
    const apple = await upsertAppleAccount("001.xyz", undefined);
    assert.equal(await beginEmailVerification(apple.uid), null);
    const rec = await createEmailAccount("e@f.co", "password-123");
    const raw = (await beginEmailVerification(rec.uid))!;
    await confirmEmailVerification(raw);
    assert.equal(await beginEmailVerification(rec.uid), null);
  });
});

describe("one-time codes (S2)", () => {
  test("begin → consume round-trip for login; purpose is enforced", async () => {
    const rec = await createEmailAccount("otp@a.co", "password-123", 1000);
    const begin = await beginAccountOtp("OTP@A.co", "login", 1000);
    assert.equal(begin.status, "ok");
    if (begin.status !== "ok") return;
    assert.match(begin.code, /^\d{6}$/);
    // raw code never persisted, only its hash
    assert.equal(fs.readFileSync(FILE, "utf8").includes(begin.code), false);
    // a login code must not reset a password or verify the email
    assert.equal(await consumeAccountOtp("otp@a.co", begin.code, "reset", 2000), null);
    // ...and the wrong-purpose try didn't burn the code for its real purpose:
    const ok = await consumeAccountOtp("otp@a.co", begin.code, "login", 3000);
    assert.equal(ok?.uid, rec.uid);
    assert.equal(ok?.lastLoginAt, 3000);
    // consumed — replay fails
    assert.equal(await consumeAccountOtp("otp@a.co", begin.code, "login", 4000), null);
  });

  test("verify purpose levels the account", async () => {
    const rec = await createEmailAccount("v@a.co", "password-123");
    const begin = await beginAccountOtp("v@a.co", "verify", 1000);
    assert.equal(begin.status, "ok");
    if (begin.status !== "ok") return;
    const ok = await consumeAccountOtp("v@a.co", begin.code, "verify", 2000);
    assert.equal(ok?.verified, true);
    assert.equal((await getAccount(rec.uid))?.verified, true);
    // an already-verified account can't begin another verify code
    resetOtpCooldowns();
    assert.equal((await beginAccountOtp("v@a.co", "verify", 3000)).status, "none");
  });

  test("send-cooldown is uniform — known and unknown emails throttle alike", async () => {
    await createEmailAccount("cool@a.co", "password-123");
    assert.equal((await beginAccountOtp("cool@a.co", "login", 1000)).status, "ok");
    assert.equal((await beginAccountOtp("cool@a.co", "login", 2000)).status, "cooldown");
    // unknown email: first call answers "none" but STILL arms the cooldown
    assert.equal((await beginAccountOtp("ghost@a.co", "login", 1000)).status, "none");
    assert.equal((await beginAccountOtp("ghost@a.co", "login", 2000)).status, "cooldown");
    // cooldown expires
    assert.equal((await beginAccountOtp("cool@a.co", "login", 1000 + 61_000)).status, "ok");
  });

  test("five wrong guesses burn the code", async () => {
    await createEmailAccount("burn@a.co", "password-123");
    const begin = await beginAccountOtp("burn@a.co", "login", 1000);
    if (begin.status !== "ok") { assert.fail("expected ok"); }
    const wrong = begin.code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      assert.equal(await consumeAccountOtp("burn@a.co", wrong, "login", 2000), null);
    }
    // even the CORRECT code now fails — burned
    assert.equal(await consumeAccountOtp("burn@a.co", begin.code, "login", 3000), null);
  });

  test("codes expire after 10 minutes", async () => {
    await createEmailAccount("exp@a.co", "password-123");
    const begin = await beginAccountOtp("exp@a.co", "login", 1000);
    if (begin.status !== "ok") { assert.fail("expected ok"); }
    assert.equal(await consumeAccountOtp("exp@a.co", begin.code, "login", 1000 + 11 * 60_000), null);
  });

  test("password reset: new password lands, sessions die, account verifies", async () => {
    const rec = await createEmailAccount("r@a.co", "old-password-1", 1000);
    const begin = await beginAccountOtp("r@a.co", "reset", 2000);
    if (begin.status !== "ok") { assert.fail("expected ok"); }
    await assert.rejects(
      resetPasswordWithOtp("r@a.co", begin.code, "short", 3000),
      (e: InstanceType<typeof AccountError>) => e.code === "weak_password",
    );
    const after = await resetPasswordWithOtp("r@a.co", begin.code, "new-password-1", 3000);
    assert.equal(after?.uid, rec.uid);
    assert.equal(after?.sessionVersion, rec.sessionVersion + 1); // old sessions dead
    assert.equal(after?.verified, true); // code proved ownership
    assert.equal(await verifyEmailLogin("r@a.co", "old-password-1"), null);
    assert.equal((await verifyEmailLogin("r@a.co", "new-password-1"))?.uid, rec.uid);
  });

  test("consume for an unknown email or malformed code is a clean null", async () => {
    assert.equal(await consumeAccountOtp("nobody@a.co", "123456", "login"), null);
    await createEmailAccount("m@a.co", "password-123");
    const begin = await beginAccountOtp("m@a.co", "login", 1000);
    if (begin.status !== "ok") { assert.fail("expected ok"); }
    assert.equal(await consumeAccountOtp("m@a.co", "12345", "login", 2000), null); // 5 digits
    assert.equal(await consumeAccountOtp("m@a.co", "", "login", 2000), null);
  });
});

describe("mailer", () => {
  test("compose includes the link; config defaults are sane", () => {
    const mail = verificationEmail("https://x/verify?token=t");
    assert.match(mail.text, /https:\/\/x\/verify\?token=t/);
    const cfg = mailerConfig({});
    assert.equal(cfg.apiKey, null);
    assert.match(cfg.from, /meetlisa\.ai/);
  });

  test("verification mail with a code leads with it and keeps the link fallback (S2)", () => {
    const mail = verificationEmail("https://x/verify?token=t", "123456");
    assert.match(mail.subject, /123456/);
    assert.match(mail.text, /123456/);
    assert.match(mail.text, /https:\/\/x\/verify\?token=t/);
  });

  test("otp mails name their purpose (S2)", () => {
    assert.match(otpEmail("654321", "login").subject, /654321.*sign-in/);
    assert.match(otpEmail("654321", "reset").text, /password reset code is: 654321/);
  });

  test("no api key → degrades to logged link, sent:false", async () => {
    const r = await sendVerificationEmail("a@b.co", "https://x/verify?token=t", mailerConfig({}));
    assert.deepEqual(r, { sent: false, detail: "no_api_key" });
  });

  test("sends through the injected fetch and reports the provider id", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
    }) as typeof fetch;
    const r = await sendVerificationEmail(
      "a@b.co",
      "https://x/verify?token=t",
      { apiKey: "re_key", from: "LISA <no-reply@meetlisa.ai>" },
      fakeFetch,
    );
    assert.deepEqual(r, { sent: true, detail: "email_123" });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /api\.resend\.com/);
    assert.match(String(calls[0]!.init.body), /a@b\.co/);
  });
});
