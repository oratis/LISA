import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { turnstileConfig, verifyTurnstile } from "./turnstile.js";
import { isDisposableEmail } from "./email-domains.js";

const CFG = { siteKey: "sk", secret: "sec", enabled: true };

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("turnstile (S3)", () => {
  test("default-OFF: enabled only with BOTH halves", () => {
    assert.equal(turnstileConfig({}).enabled, false);
    assert.equal(turnstileConfig({ LISA_TURNSTILE_SITE_KEY: "a" }).enabled, false);
    assert.equal(turnstileConfig({ LISA_TURNSTILE_SECRET: "b" }).enabled, false);
    assert.equal(
      turnstileConfig({ LISA_TURNSTILE_SITE_KEY: "a", LISA_TURNSTILE_SECRET: "b" }).enabled,
      true,
    );
  });

  test("gate off ⇒ pass-through true (no network call)", async () => {
    const cfg = { siteKey: null, secret: null, enabled: false };
    assert.equal(await verifyTurnstile("anything", "1.2.3.4", cfg), true);
  });

  test("verifies through siteverify; success flag decides", async () => {
    assert.equal(await verifyTurnstile("tok", "1.2.3.4", CFG, fakeFetch(200, { success: true })), true);
    assert.equal(await verifyTurnstile("tok", "1.2.3.4", CFG, fakeFetch(200, { success: false })), false);
  });

  test("fails CLOSED: empty token, HTTP error, network error", async () => {
    assert.equal(await verifyTurnstile("", "1.2.3.4", CFG, fakeFetch(200, { success: true })), false);
    assert.equal(await verifyTurnstile("tok", "1.2.3.4", CFG, fakeFetch(500, {})), false);
    const boom = (async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    assert.equal(await verifyTurnstile("tok", "1.2.3.4", CFG, boom), false);
  });
});

describe("disposable email blocklist (S3)", () => {
  test("known disposable domains are caught, case-insensitively", () => {
    assert.equal(isDisposableEmail("bot@mailinator.com", {}), true);
    assert.equal(isDisposableEmail("bot@YOPMAIL.com", {}), true);
    assert.equal(isDisposableEmail("user@gmail.com", {}), false);
    assert.equal(isDisposableEmail("not-an-email", {}), false);
  });

  test("LISA_EMAIL_BLOCKLIST extends the list at deploy time", () => {
    const env = { LISA_EMAIL_BLOCKLIST: "evil.example, spam.example" };
    assert.equal(isDisposableEmail("a@evil.example", env), true);
    assert.equal(isDisposableEmail("a@spam.example", env), true);
    assert.equal(isDisposableEmail("a@fine.example", env), false);
  });
});
