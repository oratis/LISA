import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED_OTP, REDACTED_RESET_LINK, REDACTED_SIGN_IN_LINK } from "./hygiene.js";
import {
  hygieneLogLine,
  sanitizeDigest,
  sanitizeMailBatch,
  sanitizeMailFields,
} from "./hygiene-mail.js";
import type { DailyDigest, MailItem, RawMail } from "../mail/types.js";

const NONE = { otp: 0, signInLinks: 0, resetLinks: 0 };
const RESET_URL = "https://example.com/reset-password?token=3f2a9c1b7d4e5a6b7c8d";

function raw(o: Partial<RawMail> = {}): RawMail {
  return {
    uid: "1",
    accountId: "acc",
    from: "Acme <no-reply@acme.com>",
    fromAddress: "no-reply@acme.com",
    subject: "hello",
    date: 1_700_000_000_000,
    snippet: "hi",
    flags: [],
    mailbox: "INBOX",
    ...o,
  };
}

function item(o: Partial<MailItem> = {}): MailItem {
  return {
    uid: "1",
    accountId: "acc",
    from: "Acme <no-reply@acme.com>",
    fromAddress: "no-reply@acme.com",
    subject: "hello",
    date: 100,
    snippet: "hi",
    category: "security",
    importance: 2,
    reason: "security-code",
    signals: [],
    classifiedAt: 1,
    ...o,
  };
}

test("sanitizeMailFields: cleans subject, snippet, from and reason; copies the rest", () => {
  const input = item({
    from: "482913 is your verification code <x@acme.com>",
    subject: "Your verification code is 482913",
    snippet: `Or reset here: ${RESET_URL} thanks`,
    reason: "login code 482913 inside",
  });
  const before = JSON.stringify(input);
  const { mail, removed } = sanitizeMailFields(input);
  assert.equal(JSON.stringify(input), before, "input must not be mutated");
  assert.equal(mail.subject, `Your verification code is ${REDACTED_OTP}`);
  assert.equal(mail.snippet, `Or reset here: ${REDACTED_RESET_LINK} thanks`);
  assert.equal(mail.from, `${REDACTED_OTP} is your verification code <x@acme.com>`);
  assert.equal(mail.reason, `login code ${REDACTED_OTP} inside`);
  assert.deepEqual(removed, { otp: 3, signInLinks: 0, resetLinks: 1 });
  assert.equal(mail.uid, input.uid);
  assert.equal(mail.fromAddress, input.fromAddress);
  assert.equal(mail.importance, input.importance);
  assert.equal(JSON.stringify(mail).includes("482913"), false);
});

test("sanitizeMailFields: a code announced in the subject and printed in the snippet", () => {
  const { mail, removed } = sanitizeMailFields(
    raw({ subject: "Your Acme verification code", snippet: "482913 Enter it within 10 minutes." }),
  );
  assert.equal(mail.subject, "Your Acme verification code");
  assert.equal(mail.snippet, `${REDACTED_OTP} Enter it within 10 minutes.`);
  assert.deepEqual(removed, { ...NONE, otp: 1 });

  const zh = sanitizeMailFields(
    raw({ subject: "【天猫】登录验证码", snippet: "482913，5分钟内有效，请勿泄露。" }),
  );
  assert.equal(zh.mail.snippet, `${REDACTED_OTP}，5分钟内有效，请勿泄露。`);
});

test("sanitizeMailFields: a code in the subject does not drag snippet numbers with it", () => {
  const { mail, removed } = sanitizeMailFields(
    raw({
      subject: "482913 is your Acme verification code",
      snippet: "Hi Jane, invoice 20261002 for 5 seats is attached. Total 4821 points.",
    }),
  );
  assert.equal(mail.subject, `${REDACTED_OTP} is your Acme verification code`);
  assert.equal(
    mail.snippet,
    "Hi Jane, invoice 20261002 for 5 seats is attached. Total 4821 points.",
  );
  assert.deepEqual(removed, { ...NONE, otp: 1 });
});

test("sanitizeMailFields: a link cut off at the end of the snippet is still removed", () => {
  const { mail, removed } = sanitizeMailFields(
    raw({
      subject: "Confirm your email",
      snippet: "Welcome! Please verify your email: https://example.com/verify-email?tok",
    }),
  );
  assert.equal(mail.snippet, `Welcome! Please verify your email: ${REDACTED_SIGN_IN_LINK}`);
  assert.deepEqual(removed, { ...NONE, signInLinks: 1 });
});

test("sanitizeMailFields: ordinary mail passes through byte-for-byte", () => {
  const input = raw({
    subject: "Invoice 88213 due October 12, 2026",
    snippet: "Total $1,284.00. Pay at https://billing.example.com/invoices/88213 by Friday.",
  });
  const { mail, removed } = sanitizeMailFields(input);
  assert.deepEqual(mail, input);
  assert.deepEqual(removed, NONE);
});

test("sanitizeMailFields: idempotent, and the join marker cannot be smuggled in", () => {
  const mark = String.fromCharCode(0xe002);
  const once = sanitizeMailFields(
    raw({
      subject: `Your verification code${mark}`,
      snippet: `${mark}482913 and ${RESET_URL}`,
    }),
  );
  assert.equal(once.mail.subject.includes(mark) || once.mail.snippet.includes(mark), false);
  assert.equal(once.mail.subject, "Your verification code");
  assert.equal(once.mail.snippet, `${REDACTED_OTP} and ${REDACTED_RESET_LINK}`);
  const twice = sanitizeMailFields(once.mail);
  assert.deepEqual(twice.mail, once.mail);
  assert.deepEqual(twice.removed, NONE);
});

test("sanitizeMailFields: tolerates missing text fields", () => {
  const { mail, removed } = sanitizeMailFields({
    subject: undefined as unknown as string,
    snippet: undefined as unknown as string,
  });
  assert.equal(mail.subject, "");
  assert.equal(mail.snippet, "");
  assert.deepEqual(removed, NONE);
});

test("sanitizeMailBatch: totals and touched count", () => {
  const batch = sanitizeMailBatch([
    raw({ uid: "1", subject: "Your verification code is 482913" }),
    raw({ uid: "2", subject: "Lunch on Friday?" }),
    raw({
      uid: "3",
      snippet: `Reset: ${RESET_URL} or sign in https://example.com/magic?token=abcdef123456`,
    }),
  ]);
  assert.equal(batch.mails.length, 3);
  assert.deepEqual(
    batch.mails.map((m) => m.uid),
    ["1", "2", "3"],
  );
  assert.equal(batch.touched, 2);
  assert.deepEqual(batch.removed, { otp: 1, signInLinks: 1, resetLinks: 1 });
  assert.deepEqual(sanitizeMailBatch([]), { mails: [], removed: NONE, touched: 0 });
});

test("sanitizeDigest: cleans a digest written before hygiene existed", () => {
  const legacy: DailyDigest = {
    date: "2026-09-30",
    generatedAt: 1,
    accountIds: ["acc"],
    total: 2,
    unread: 2,
    summary: "2 new emails. 1 needs you: “Your verification code is 482913” (Acme).",
    needsYou: [item({ subject: "Your verification code is 482913" })],
    buckets: [
      {
        category: "security",
        count: 2,
        items: [
          item({ subject: "Your verification code is 482913" }),
          item({ uid: "2", subject: "Password reset", snippet: `Reset: ${RESET_URL}` }),
        ],
      },
    ],
  };
  const clean = sanitizeDigest(legacy);
  const dump = JSON.stringify(clean);
  assert.equal(dump.includes("482913"), false);
  assert.equal(dump.includes("3f2a9c1b7d4e5a6b7c8d"), false);
  assert.equal(clean.total, 2);
  assert.equal(clean.buckets[0]!.count, 2);
  assert.equal(clean.needsYou[0]!.subject, `Your verification code is ${REDACTED_OTP}`);
  assert.deepEqual(sanitizeDigest(clean), clean, "a clean digest passes through unchanged");
});

test("hygieneLogLine: counts only, and silent when nothing was removed", () => {
  const batch = sanitizeMailBatch([
    raw({ subject: "Your verification code is 482913", snippet: `Reset: ${RESET_URL}` }),
    raw({ uid: "2" }),
  ]);
  const line = hygieneLogLine("account=qq-3…9a1c", batch, 2);
  assert.equal(
    line,
    "[mail] hygiene account=qq-3…9a1c: cleaned 1/2 message(s) — otp=1 signInLinks=0 resetLinks=1",
  );
  assert.equal(hygieneLogLine("x", sanitizeMailBatch([raw()]), 1), null);
});
