import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mailerConfig,
  redactEmail,
  escapeHtml,
  signInCodeEmail,
  verificationEmail,
  sendSignInCodeEmail,
  sendVerificationEmail,
  type Mail,
} from "./mailer.js";

const CFG = { apiKey: "re_key", from: "LISA <no-reply@mail.meetlisa.ai>" };

/** Capture what would go over the wire. */
function recordingFetch(response = { id: "email_123" }, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(response), { status });
  }) as typeof fetch;
  return { calls, fn };
}

/** Strip tags/entities so the HTML can be compared as prose. */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const ALL_MAILS: Array<[string, Mail]> = [
  ["signInCode", signInCodeEmail("123456", 10)],
  ["verification", verificationEmail("https://cloud.meetlisa.ai/verify?token=abc123")],
];

describe("mailer — sending identity", () => {
  test("defaults to the mail. subdomain Resend verifies, not the apex", () => {
    const cfg = mailerConfig({});
    assert.equal(cfg.apiKey, null);
    assert.match(cfg.from, /@mail\.meetlisa\.ai>$/);
  });

  test("LISA_MAIL_FROM overrides; blank falls back to the default", () => {
    assert.equal(mailerConfig({ LISA_MAIL_FROM: "L <hi@mail.meetlisa.ai>" }).from, "L <hi@mail.meetlisa.ai>");
    assert.match(mailerConfig({ LISA_MAIL_FROM: "   " }).from, /no-reply@mail\.meetlisa\.ai/);
  });
});

describe("mailer — log hygiene", () => {
  test("redaction drops the local part and keeps the whole domain", () => {
    // The domain stays because delivery problems cluster by provider.
    assert.equal(redactEmail("alice.smith@example.com"), "al***@example.com");
    assert.equal(redactEmail("a@b.co"), "a***@b.co");
  });

  test("malformed addresses redact to nothing rather than leaking", () => {
    assert.equal(redactEmail("no-at-sign"), "***");
    assert.equal(redactEmail("@example.com"), "***");
    assert.equal(redactEmail("trailing@"), "***");
  });

  test("a recipient never reaches the log intact", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      await sendSignInCodeEmail("alice.smith@example.com", "123456", 10, CFG, recordingFetch().fn);
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1, "exactly one line per send");
    assert.match(logged[0]!, /outcome=success/);
    assert.ok(!logged[0]!.includes("alice.smith"), "the local part must not be logged");
    assert.ok(logged[0]!.includes("example.com"), "the domain must be logged");
  });
});

describe("mailer — templates", () => {
  test("the code appears in the subject, the text and the HTML", () => {
    const mail = signInCodeEmail("123456", 10);
    assert.match(mail.subject, /123456/); // visible in the notification preview
    assert.match(mail.text, /123456/);
    assert.match(mail.html, /123456/);
    assert.match(mail.text, /10 minutes/);
  });

  test("every mail ships both parts, and they say the same thing", () => {
    // multipart/alternative is a deliverability signal — but a text part that
    // diverges from the HTML is itself a spam signal, so they must agree.
    for (const [name, mail] of ALL_MAILS) {
      assert.ok(mail.text.length > 0, `${name}: text part`);
      assert.ok(mail.html.length > 0, `${name}: html part`);
      assert.ok(!/<[a-z]/i.test(mail.text), `${name}: the text part must carry no markup`);

      // Every link in the HTML must also be reachable from the text part.
      const hrefs = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
      const appLinks = hrefs.filter((h) => h.includes("verify") || h.includes("token"));
      for (const link of appLinks) {
        assert.ok(mail.text.includes(link), `${name}: ${link} missing from the text part`);
      }
    }
  });

  test("the HTML is email-client-safe: tables and inline styles, no <style>/flex", () => {
    for (const [name, mail] of ALL_MAILS) {
      assert.match(mail.html, /<!DOCTYPE html>/, `${name}: doctype`);
      assert.match(mail.html, /<table/, `${name}: table layout`);
      assert.ok(!/<style[\s>]/.test(mail.html), `${name}: no <style> block (Gmail strips it)`);
      assert.ok(!/display:\s*flex/.test(mail.html), `${name}: no flexbox`);
    }
  });

  test("a preheader is present but hidden", () => {
    for (const [name, mail] of ALL_MAILS) {
      assert.match(mail.html, /display:none;max-height:0/, `${name}: hidden preheader`);
    }
  });
});

describe("mailer — escaping", () => {
  test("escapeHtml covers the five dangerous characters", () => {
    assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
    assert.equal(escapeHtml('a"b'), "a&quot;b");
    assert.equal(escapeHtml("a'b"), "a&#39;b");
    assert.equal(escapeHtml("a&b"), "a&amp;b");
    assert.equal(escapeHtml("plain"), "plain");
    // & first, or the other escapes get double-escaped.
    assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  });

  test("a hostile verification link can't break out of the attribute", () => {
    const mail = verificationEmail('https://x/verify?token="><script>alert(1)</script>');
    assert.ok(!mail.html.includes("<script>alert"), "the payload must not survive as markup");
    assert.match(mail.html, /&lt;script&gt;/);
  });
});

describe("mailer — transport", () => {
  test("sends both parts to Resend with the configured sender", async () => {
    const { calls, fn } = recordingFetch();
    const r = await sendSignInCodeEmail("a@b.co", "654321", 10, CFG, fn);
    assert.deepEqual(r, { sent: true, detail: "email_123" });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /api\.resend\.com/);
    const body = calls[0]!.body;
    assert.equal(body.from, CFG.from);
    assert.deepEqual(body.to, ["a@b.co"]);
    assert.match(String(body.text), /654321/);
    assert.match(String(body.html), /654321/);
  });

  test("no api key → logged no-op, and the credential reaches the log", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      const r = await sendSignInCodeEmail("a@b.co", "123456", 10, mailerConfig({}));
      assert.deepEqual(r, { sent: false, detail: "no_api_key" });
    } finally {
      console.error = original;
    }
    // Offline/dev: the operator is the transport, so the code has to be there.
    assert.match(logged[0]!, /outcome=skipped_no_key/);
    assert.match(logged[0]!, /123456/);
  });

  test("a 4xx is a failure even though the response is well-formed", async () => {
    // Resend answers rate limits and unverified senders with a normal HTTP
    // response — if that isn't treated as a failure it vanishes silently.
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    let r;
    try {
      r = await sendVerificationEmail("a@b.co", "https://x/verify?token=t", CFG,
        recordingFetch({ id: "" }, 422).fn);
    } finally {
      console.error = original;
    }
    assert.deepEqual(r, { sent: false, detail: "http_422" });
    assert.match(logged[0]!, /outcome=send_failed/);
    assert.match(logged[0]!, /status=422/);
  });

  test("a network error is reported, not thrown", async () => {
    const original = console.error;
    console.error = () => {};
    let r;
    try {
      const boom = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
      r = await sendVerificationEmail("a@b.co", "https://x/verify?token=t", CFG, boom);
    } finally {
      console.error = original;
    }
    assert.deepEqual(r, { sent: false, detail: "network_error" });
  });
});
