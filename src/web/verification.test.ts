import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-verify-"));
process.env.LISA_HOME = TMP;
const FILE = path.join(TMP, "accounts.json");

const { createEmailAccount, beginEmailVerification, confirmEmailVerification, upsertAppleAccount, getAccount } =
  await import("./accounts.js");
const { verificationEmail, mailerConfig, sendVerificationEmail } = await import("./mailer.js");

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
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

describe("mailer", () => {
  test("compose includes the link; config defaults are sane", () => {
    const mail = verificationEmail("https://x/verify?token=t");
    assert.match(mail.text, /https:\/\/x\/verify\?token=t/);
    const cfg = mailerConfig({});
    assert.equal(cfg.apiKey, null);
    assert.match(cfg.from, /meetlisa\.ai/);
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
