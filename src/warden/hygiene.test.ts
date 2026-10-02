/**
 * Corpus tests for inbound hygiene. Every sample is shaped like real mail (the
 * codes, tokens and hosts are made up). Three things are pinned:
 *
 *  1. what must be removed is removed, and the value is gone from the output;
 *  2. what must survive survives byte-for-byte (false-positive guards);
 *  3. the known limits — both directions — so a change to them is a decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REDACTED_OTP,
  REDACTED_RESET_LINK,
  REDACTED_SIGN_IN_LINK,
  addHygieneCounts,
  hygieneTotal,
  stripSensitiveTokens,
} from "./hygiene.js";

const NONE = { otp: 0, signInLinks: 0, resetLinks: 0 };

/** Assert `text` loses exactly `gone` (each replaced by the OTP placeholder) and keeps `kept`. */
function otp(text: string, gone: string[], kept: string[] = []): void {
  const out = stripSensitiveTokens(text);
  for (const g of gone)
    assert.equal(out.text.includes(g), false, `still present: ${g}\n→ ${out.text}`);
  for (const k of kept) assert.equal(out.text.includes(k), true, `lost: ${k}\n→ ${out.text}`);
  assert.deepEqual(out.removed, { ...NONE, otp: gone.length }, `${text}\n→ ${out.text}`);
  assert.equal(out.text.split(REDACTED_OTP).length - 1, gone.length);
}

function untouched(text: string): void {
  const out = stripSensitiveTokens(text);
  assert.equal(out.text, text);
  assert.deepEqual(out.removed, NONE);
}

function link(text: string, url: string, kind: "signin" | "reset"): void {
  const out = stripSensitiveTokens(text);
  const placeholder = kind === "reset" ? REDACTED_RESET_LINK : REDACTED_SIGN_IN_LINK;
  assert.equal(out.text, text.replace(url, placeholder), text);
  assert.deepEqual(
    out.removed,
    kind === "reset" ? { ...NONE, resetLinks: 1 } : { ...NONE, signInLinks: 1 },
    text,
  );
}

// ── one-time codes: English ──

test("otp/en: code after the keyword", () => {
  otp("Your verification code is 482913. It expires in 10 minutes.", ["482913"], ["10 minutes"]);
  otp("Microsoft account security code: 7203914", ["7203914"]);
  otp("Your one-time passcode: 5521", ["5521"]);
  otp("Your login code for Acme is XK7Q92.", ["XK7Q92"], ["Acme"]);
  otp("Use verification code 482913 for Acme authentication.", ["482913"]);
  otp("Your OTP is 482913", ["482913"]);
  otp("2FA code 123-456 — do not share it with anyone.", ["123-456"]);
  otp("Your Acme verification code is: 482 913", ["482 913"]);
  otp(
    "Your sign-in code\n\n482913\n\nThis code expires in 15 minutes.",
    ["482913"],
    ["15 minutes"],
  );
});

test("otp/en: code before the keyword", () => {
  otp("123456 is your Facebook confirmation code", ["123456"], ["Facebook"]);
  otp("G-482913 is your Google verification code.", ["G-482913"], ["Google"]);
  otp("Use 739204 as your login code for Slack.", ["739204"], ["Slack"]);
  otp("482913 — your Acme security code", ["482913"]);
});

test("otp/en: the bare word 'code' or 'PIN', glued to digits", () => {
  otp("Your Uber code is 4821. Never share this code.", ["4821"]);
  otp("Amazon: Your code is 829104. Don't share it.", ["829104"]);
  otp("Apple ID Code: 123456. Don't share it.", ["123456"]);
  otp("123456 is your Uber code", ["123456"]);
  otp("Your PIN: 4821", ["4821"]);
});

test("otp/en: 'enter the following code' layouts", () => {
  otp(
    "Enter the following code to finish signing in:\n\n  904 113\n\nIt is valid for 15 minutes.",
    ["904 113"],
    ["15 minutes"],
  );
  otp("Please use the code below to verify your device. 739204", ["739204"]);
});

test("otp/en: bank-style message keeps the amount and the card tail", () => {
  otp(
    "Your OTP for the transaction of INR 5,000.00 on card ending 1234 is 482913. Valid for 10 mins.",
    ["482913"],
    ["5,000.00", "ending 1234", "10 mins"],
  );
  otp(
    "Verification code: 482913. If you did not request it, call 800-555-0100 or reply to order #88213441.",
    ["482913"],
    ["800-555-0100", "#88213441"],
  );
});

test("otp/other Latin-script languages", () => {
  otp("Tu código de verificación es 482913.", ["482913"]);
  otp("Votre code de vérification est 482913", ["482913"]);
  otp("Ihr Bestätigungscode lautet 482913.", ["482913"]);
  otp("Seu código de verificação é 482913", ["482913"]);
});

// ── one-time codes: Chinese / Japanese / Korean ──

test("otp/en: shapes seen in the wild", () => {
  otp("Hi, your Steam Guard code is R7K2M. Enter it to log in.", ["R7K2M"]);
  otp("<#> Your ExampleApp code is: 482913 FA+9qCX9VSu", ["482913"], ["FA+9qCX9VSu"]);
  otp("Use 482 913 to verify your Instagram account.", ["482 913"], ["Instagram"]);
  otp("Your Lyft code 482913 expires soon", ["482913"]);
  otp("PayPal: Your security code is 482913. Your code expires in 10 minutes.", ["482913"]);
  otp(
    "Dear customer, 482913 is the OTP for your transaction at SHOP. OTPs are SECRET. DO NOT disclose it.",
    ["482913"],
  );
  otp(
    "[GitHub] Please verify your device. Verification code: 482913. If this was not you, visit https://github.com/settings/security now.",
    ["482913"],
    ["https://github.com/settings/security"],
  );
  otp("【美团】482913（登录验证码，请完成验证），如非本人操作，请忽略本短信。", ["482913"]);
});

test("otp/zh: common SMS-style and mail layouts", () => {
  otp("【天猫】验证码482913，您正在登录，5分钟内有效，请勿泄露。", ["482913"], ["5分钟"]);
  otp("您的验证码是：482913，请在10分钟内完成验证。", ["482913"], ["10分钟"]);
  otp("482913（验证码），请勿告知他人。", ["482913"]);
  otp("您的登录验证码为 482913 ，如非本人操作请忽略。", ["482913"]);
  otp("【微信】验证码 482913 用于登录，泄露有风险。", ["482913"]);
  otp("校验码１２３４５６，用于身份验证。", ["１２３４５６"]);
  otp("您的驗證碼為 482913，請於 5 分鐘內輸入。", ["482913"], ["5 分鐘"]);
  otp("验证码：482913。客服电话 400-820-8820。", ["482913"], ["400-820-8820"]);
});

test("otp/zh: bank message keeps the amount and the card tail", () => {
  otp(
    "动态密码 739204，尾号1234的储蓄卡正在进行支付，金额5000.00元。",
    ["739204"],
    ["尾号1234", "5000.00元"],
  );
});

test("otp/ja+ko", () => {
  otp("確認コード: 482913 このコードは10分間有効です。", ["482913"], ["10分間"]);
  otp("認証番号は 482913 です。", ["482913"]);
  otp("인증번호 [482913] 를 입력해주세요.", ["482913"]);
});

// ── one-time codes: false-positive guards ──

test("otp: plain numbers are left alone when nothing announces a code", () => {
  for (const text of [
    "Your order #20261002 has shipped. Total: $1,284.00. Tracking 9400111899223344.",
    "Meeting moved to 2026-10-05 at 14:30, room 4021.",
    "Invoice 88213 for ¥5000 is due on October 12, 2026.",
    "Call us at 400-820-8820 or 13800138000.",
    "您的订单 20261002 已发货，金额 5000 元，预计 10月5日 送达。",
    "Flight CA1234 departs 08:45 from gate 3012. Seat 34A.",
    "Q3 revenue was 482913 units, up from 391204.",
    "Verification complete. Your account number 12345678 is active.",
    "",
  ]) {
    untouched(text);
  }
});

test("otp: other kinds of 'code' are not credentials", () => {
  for (const text of [
    "Promo code: SAVE2026 — 20% off until Friday.",
    "Discount code: 123456",
    "优惠码：123456，全场八折。",
    "Error code: 5001. Status code 404.",
    "Zip code: 94103",
    "The source code is in repo 12345678.",
    "Country code: 0086",
    "Dial the area code 0755 first.",
    "The code review for PR 482913 is ready.",
    "Enter 5000 as the amount, then press Pay.",
    "Hi John, thanks for your payment of $4829.00 on 10/02/2026. Your confirmation number is 88213441.",
    "【招商银行】您尾号8820的信用卡于10月02日消费人民币1234.50元，可用额度56789.00元。",
    // A parcel pickup code is something the user wants read back, not a login credential.
    "您的包裹已到达，取件码 4821，请于今日 18:00 前取件。",
  ]) {
    untouched(text);
  }
});

test("otp: dates, amounts and phone numbers near a keyword survive", () => {
  untouched("Two-factor authentication was enabled on 2026-10-02.");
  untouched(
    "Your security code was changed on October 2, 2026. If this wasn't you, call 8005551234.",
  );
  untouched("We will never ask for your verification code. Call 800-555-0100.");
  untouched("验证码登录功能已于2026年10月2日开启，如有疑问请致电 400-820-8820。");
  otp(
    "Your verification code is 482913. © 2026 Acme Inc. Invoice 20261002.",
    ["482913"],
    ["2026 Acme", "20261002"],
  );
});

test("otp: a booking 'confirmation code' with letters is left for the model", () => {
  untouched("Your flight confirmation code is K7XQ2M. Check in opens 24 hours before departure.");
  untouched("Product activation code: AB12-CD34");
  // …but an all-digit one is still treated as a one-time code.
  otp("Your Facebook confirmation code is 482913", ["482913"]);
});

// ── links ──

test("links: password reset", () => {
  link(
    "Reset your password: https://example.com/reset-password?token=3f2a9c1b7d4e5a6b7c8d",
    "https://example.com/reset-password?token=3f2a9c1b7d4e5a6b7c8d",
    "reset",
  );
  link(
    "https://github.com/password_reset/AbCdEf0123456789abcdef0123456789 (expires in 3 hours)",
    "https://github.com/password_reset/AbCdEf0123456789abcdef0123456789",
    "reset",
  );
  link(
    "https://myapp.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=AbCdEf123456GhIjKl&lang=en",
    "https://myapp.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=AbCdEf123456GhIjKl&lang=en",
    "reset",
  );
  link(
    "https://xyz.supabase.co/auth/v1/verify?token=abcdef0123456789&type=recovery&redirect_to=https://app.example.com",
    "https://xyz.supabase.co/auth/v1/verify?token=abcdef0123456789&type=recovery&redirect_to=https://app.example.com",
    "reset",
  );
  link(
    "Choose a new password here: https://accounts.example.com/u/reset-verify?ticket=Qq7Zr2Lm9Xc4Vb8N#",
    "https://accounts.example.com/u/reset-verify?ticket=Qq7Zr2Lm9Xc4Vb8N#",
    "reset",
  );
});

test("links: sign-in, magic and e-mail verification", () => {
  link(
    "Sign in to Slack: https://app.slack.com/magic-login/T0123ABCD-U0456EFGH-8f3a9c2e7b1d4f60",
    "https://app.slack.com/magic-login/T0123ABCD-U0456EFGH-8f3a9c2e7b1d4f60",
    "signin",
  );
  link(
    "https://www.notion.so/loginwithemail?token=v02%3Alogin_with_email%3AAbCdEf123456&email=me%40example.com",
    "https://www.notion.so/loginwithemail?token=v02%3Alogin_with_email%3AAbCdEf123456&email=me%40example.com",
    "signin",
  );
  link(
    "Your magic link: https://example.com/magic?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
    "https://example.com/magic?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
    "signin",
  );
  link(
    "Confirm your address: https://example.com/verify-email/8f14e45fceea167a5a36dedd4bea2543.",
    "https://example.com/verify-email/8f14e45fceea167a5a36dedd4bea2543",
    "signin",
  );
  link(
    "https://example.com/users/confirmation?confirmation_token=AbC123xyZ789",
    "https://example.com/users/confirmation?confirmation_token=AbC123xyZ789",
    "signin",
  );
  link(
    "https://example.com/callback#access_token=abcdef123456&token_type=bearer",
    "https://example.com/callback#access_token=abcdef123456&token_type=bearer",
    "signin",
  );
  link(
    "https://example.com/#/login?token=abcdef123456",
    "https://example.com/#/login?token=abcdef123456",
    "signin",
  );
  link(
    "Open in the app: myapp://auth/callback?code=abcdef123456",
    "myapp://auth/callback?code=abcdef123456",
    "signin",
  );
  link(
    '<a href="https://example.com/auth/verify?t=9f8e7d6c5b4a">Verify</a>',
    "https://example.com/auth/verify?t=9f8e7d6c5b4a",
    "signin",
  );
});

test("links: redirect wrappers and click trackers are judged by what they lead to", () => {
  link(
    "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Freset%3Ftoken%3Dabcdef123456&sa=D",
    "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Freset%3Ftoken%3Dabcdef123456&sa=D",
    "reset",
  );
  link(
    "To reset your password, click here: https://click.mail.example.com/ls/click?upn=u001.AbCdEfGh1234567890IjKlMnOpQrStUvWxYz",
    "https://click.mail.example.com/ls/click?upn=u001.AbCdEfGh1234567890IjKlMnOpQrStUvWxYz",
    "reset",
  );
  link(
    "Click to verify your email https://t.example.com/c/AbCdEf0123456789GhIjKl",
    "https://t.example.com/c/AbCdEf0123456789GhIjKl",
    "signin",
  );
});

test("links/zh: prose runs straight on after the link", () => {
  link(
    "请点击以下链接重置密码：https://t.example.cn/r/AbCdEf1234567890XyZ。如非本人操作请忽略。",
    "https://t.example.cn/r/AbCdEf1234567890XyZ",
    "reset",
  );
  link(
    "点击登录：https://example.cn/login?ticket=ST-12345-abcdefABCDEF，30分钟内有效",
    "https://example.cn/login?ticket=ST-12345-abcdefABCDEF",
    "signin",
  );
  link(
    "请验证您的邮箱 https://example.cn/verify?code=8f14e45fceea167a 谢谢",
    "https://example.cn/verify?code=8f14e45fceea167a",
    "signin",
  );
});

test("links: ordinary links are kept intact", () => {
  for (const text of [
    "Read more: https://example.com/blog/how-to-reset-your-password-safely-3f2a9c1b7d4e",
    "Log in at https://github.com/login to see it.",
    "https://example.com/login?lang=en",
    "https://accounts.google.com/",
    "Doc: https://docs.google.com/document/d/1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvWxYz/edit",
    "Your order: https://shop.example.com/orders/8f14e45fceea167a5a36dedd4bea2543",
    "https://example.com/authors/jane-doe-0123456789abcdef",
    "Join: https://zoom.us/j/1234567890?pwd=AbCdEf123456GhIjKl",
    "https://calendar.google.com/calendar/event?eid=NWZhYjEyMzQ1Njc4OTBhYmNkZWYgbWVAZXhhbXBsZS5jb20",
    "Receipt: https://example.com/invoice/INV-2026-0042.pdf",
    "https://www.dropbox.com/s/abc123xyz456def/report.pdf?dl=0",
    "https://github.com/oratis/LISA/pull/405#issuecomment-1234567890",
    "https://news.example.com/unsubscribe?token=abcdef123456",
    "https://github.com/notifications/unsubscribe-auth/ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "Docs: https://auth.example.com/docs/getting-started-with-oauth2-flows",
    "查看详情：https://example.cn/news/2026/10/02/12345.html。",
    "The handle secret://gmail/work is not a link.",
    "Track it: https://example.com/track?id=12345",
  ]) {
    untouched(text);
  }
});

test("links: a link cut off by snippet truncation is judged by its path", () => {
  const text = "Please verify your email: https://example.com/verify-email?tok";
  assert.deepEqual(stripSensitiveTokens(text).removed, NONE, "untruncated text: nothing to go on");
  const cut = stripSensitiveTokens(text, { truncated: true });
  assert.equal(cut.text, `Please verify your email: ${REDACTED_SIGN_IN_LINK}`);
  // Only the link that actually touches the end gets the benefit of the doubt.
  const mid = stripSensitiveTokens("See https://example.com/login for details", {
    truncated: true,
  });
  assert.deepEqual(mid.removed, NONE);
});

// ── both at once, counts, idempotence ──

test("a message with a code and two links", () => {
  const text =
    "Your verification code is 482913. Or sign in directly: " +
    "https://example.com/auth/magic?token=abcdef123456 — forgot it? " +
    "https://example.com/password/reset/9f8e7d6c5b4a3f2e1d0c";
  const out = stripSensitiveTokens(text);
  assert.equal(
    out.text,
    `Your verification code is ${REDACTED_OTP}. Or sign in directly: ` +
      `${REDACTED_SIGN_IN_LINK} — forgot it? ${REDACTED_RESET_LINK}`,
  );
  assert.deepEqual(out.removed, { otp: 1, signInLinks: 1, resetLinks: 1 });
  assert.equal(hygieneTotal(out.removed), 3);
  assert.deepEqual(addHygieneCounts(out.removed, out.removed), {
    otp: 2,
    signInLinks: 2,
    resetLinks: 2,
  });
});

test("a code inside a link is removed with the link, once", () => {
  const out = stripSensitiveTokens(
    "Your verification code is in this link: https://example.com/verify?otp=482913",
  );
  assert.equal(out.text, `Your verification code is in this link: ${REDACTED_SIGN_IN_LINK}`);
  assert.deepEqual(out.removed, { ...NONE, signInLinks: 1 });
});

const CORPUS = [
  "Your verification code is 482913. It expires in 10 minutes.",
  "123456 is your Facebook confirmation code",
  "【天猫】验证码482913，您正在登录，5分钟内有效，请勿泄露。",
  "动态密码 739204，尾号1234的储蓄卡正在进行支付，金额5000.00元。",
  "Enter the following code to finish signing in:\n\n  904 113\n\nIt is valid for 15 minutes.",
  "Your verification code is 482913. Or sign in: https://example.com/auth/magic?token=abcdef123456 thanks. Ref 55667788.",
  "Reset your password: https://example.com/reset-password?token=3f2a9c1b7d4e5a6b7c8d or https://example.com/help",
  "To reset your password, click here: https://click.mail.example.com/ls/click?upn=u001.AbCdEfGh1234567890IjKlMnOpQrStUvWxYz and then https://t.example.com/c/Zz0123456789AbCdEfGhIj",
  "Your OTP is 482913 482914 482915 and then some more prose that goes on for a while 99887766.",
  "验证码：482913。客服电话 400-820-8820。请点击 https://example.cn/login?ticket=ST-12345-abcdefABCDEF 登录",
  "Your order #20261002 has shipped. Total: $1,284.00.",
];

test("idempotent: a second pass changes nothing and counts nothing", () => {
  for (const text of CORPUS) {
    const once = stripSensitiveTokens(text);
    const twice = stripSensitiveTokens(once.text);
    assert.equal(twice.text, once.text, text);
    assert.deepEqual(twice.removed, NONE, text);
  }
});

test("existing placeholders are never matched as keywords or codes", () => {
  // "[redacted: one-time code]" contains the words "one-time code": the number
  // after it must not be taken for a second code on a later pass.
  const text = `${REDACTED_OTP} Then pay invoice 20261002.`;
  untouched(text);
  untouched(`${REDACTED_SIGN_IN_LINK} and ${REDACTED_RESET_LINK} and [redacted: secret] 482913`);
});

// ── known limits, pinned so that changing them is a decision ──

test("known over-redaction: a number in the sentence after an OTP keyword", () => {
  // No code is present at all; the membership number is the first code-shaped
  // token within reach of the keyword. Losing it is the accepted cost.
  otp("Enter the verification code we sent you. Your membership 20481234 renews soon.", [
    "20481234",
  ]);
  // Every code-shaped token in the code's own sentence goes with it.
  otp("Your verification code for iPhone15 is 482913", ["iPhone15", "482913"]);
});

test("known misses", () => {
  // No keyword and no "code is" glue: a bare number is indistinguishable from data.
  untouched("482913\nThanks for signing up!");
  // A keyword fused to its code by a hyphen is one token, and is not split.
  untouched("otp-482913");
  // All-letter codes are not recognised.
  untouched("Or paste this temporary login code: abcd-efgh-ijkl-mnop");
  untouched("Your verification code is QWERTY.");
  // A temporary PASSWORD is not a one-time code and is out of scope here.
  untouched("Your temporary password is Xy7$kLp9!q");
  // A scheme-less link is not parsed as a URL.
  untouched("Reset here: example.com/reset?token=3f2a9c1b7d4e5a6b7c8d");
  // A tracker-wrapped link with no auth wording around it looks like any other link.
  untouched(
    "Click https://click.mail.example.com/ls/click?upn=u001.AbCdEfGh1234567890IjKlMnOpQrStUvWxYz",
  );
});

// ── robustness ──

test("non-string and empty input", () => {
  assert.deepEqual(stripSensitiveTokens(""), { text: "", removed: NONE });
  assert.deepEqual(stripSensitiveTokens(undefined as unknown as string), {
    text: "",
    removed: NONE,
  });
  assert.deepEqual(stripSensitiveTokens(null as unknown as string), { text: "", removed: NONE });
});

test("hostile input stays linear", () => {
  const big = [
    "a".repeat(60_000),
    "a.".repeat(30_000),
    "1 ".repeat(30_000),
    "verification code ".repeat(3_000),
    "https://example.com/login?token=abcdef123456 ".repeat(1_500),
    "x@".repeat(20_000),
    "验证码".repeat(10_000),
    "(((((".repeat(8_000) + "https://example.com/a" + ")".repeat(40_000),
  ];
  for (const text of big) {
    const started = process.hrtime.bigint();
    const out = stripSensitiveTokens(text);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 2_000, `took ${ms.toFixed(0)} ms for ${text.slice(0, 24)}…`);
    assert.equal(typeof out.text, "string");
  }
});
