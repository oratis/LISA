import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthUrl, tokenExpired, exchangeCode, refreshAccessToken, GMAIL_SCOPE, type FetchLike } from "./google-oauth.js";

function jsonFetch(payload: object, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, text: async () => JSON.stringify(payload) });
}

test("buildAuthUrl carries scope, offline access, redirect + state", () => {
  const url = buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:9/cb", state: "xyz" });
  assert.match(url, /accounts\.google\.com/);
  assert.ok(url.includes("client_id=cid"));
  assert.ok(url.includes("access_type=offline"));
  assert.ok(url.includes("state=xyz"));
  assert.ok(url.includes(encodeURIComponent(GMAIL_SCOPE)));
  assert.ok(url.includes(encodeURIComponent("http://127.0.0.1:9/cb")));
});

test("tokenExpired honors a 60s skew", () => {
  // effective expiry = expiry - 60s
  assert.equal(tokenExpired(100_000, 10_000), false); // 10s ≪ 40s effective expiry
  assert.equal(tokenExpired(100_000, 39_000), false); // just before the skew window
  assert.equal(tokenExpired(100_000, 50_000), true); // inside the 60s skew ⇒ refresh
  assert.equal(tokenExpired(100_000, 100_000), true); // at/after expiry
});

test("exchangeCode parses tokens + computes absolute expiry", async () => {
  const t = await exchangeCode(
    { code: "c", clientId: "id", clientSecret: "s", redirectUri: "r" },
    jsonFetch({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
    1_000,
  );
  assert.equal(t.accessToken, "at");
  assert.equal(t.refreshToken, "rt");
  assert.equal(t.expiry, 1_000 + 3600_000);
});

test("refreshAccessToken reuses the existing refresh token when none returned", async () => {
  const t = await refreshAccessToken(
    { refreshToken: "old-rt", clientId: "id", clientSecret: "s" },
    jsonFetch({ access_token: "at2", expires_in: 1800 }),
    2_000,
  );
  assert.equal(t.accessToken, "at2");
  assert.equal(t.refreshToken, "old-rt");
  assert.equal(t.expiry, 2_000 + 1800_000);
});

test("token endpoint error throws", async () => {
  await assert.rejects(
    () => exchangeCode({ code: "c", clientId: "i", clientSecret: "s", redirectUri: "r" }, jsonFetch({ error: "bad" }, false, 400)),
    /google token endpoint 400/,
  );
});
