/**
 * Account-session lifecycle through the real cloud server: sliding renewal for
 * Bearer and cookie clients and the explicit refresh endpoint (#484).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-session-lifecycle-"));
process.env.LISA_HOME = dir;
process.env.CLAUDE_HOME = path.join(dir, "claude");
process.env.LISA_EDITION = "cloud";
process.env.LISA_PUBLIC_ORIGIN = "https://cloud.example.com";
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_SOUL_NO_GIT = "1";
process.env.LISA_MAIL_POLL_MINUTES = "0";
for (const name of [
  "LISA_WEB_TOKEN",
  "LISA_REVIEWER_SEED",
  "LISA_FIRESTORE",
  "LISA_FIRESTORE_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "LISA_MANAGED_SESSION",
  "LISA_CLOUD_SHARED_TOKEN_OK",
  "LISA_BILLING_KILL",
])
  delete process.env[name];

const { startWebServer } = await import("./server.js");
const { ensureOtpAccount } = await import("./accounts.js");
const { mintSession, verifySession, loadOrCreateSessionSecret, SESSION_TTL_MS } =
  await import("./sessions-auth.js");

const DAY = 24 * 60 * 60 * 1000;
const originalFetch = globalThis.fetch;
let server: Awaited<ReturnType<typeof startWebServer>>;
let base: string;
let secret: string;

before(async () => {
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("http://127.0.0.1:"))
      throw new Error("unexpected external request");
    return originalFetch(url, init);
  };
  server = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    tools: [],
    model: "claude-haiku-5-5",
    thinking: false,
    reflect: false,
    idleMinutes: 0,
    hooks: [],
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  secret = loadOrCreateSessionSecret();
});

after(async () => {
  globalThis.fetch = originalFetch;
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function account(email: string): Promise<{ uid: string; sv: number }> {
  const { acct } = await ensureOtpAccount(email);
  return { uid: acct.uid, sv: acct.sessionVersion };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function cookie(token: string): Record<string, string> {
  return { cookie: `lisa_token=${encodeURIComponent(token)}` };
}

async function me(headers: Record<string, string>): Promise<Response> {
  return fetch(base + "/api/auth/me", { headers });
}

async function refresh(headers: Record<string, string>): Promise<Response> {
  return fetch(base + "/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("sliding renewal (#484)", () => {
  test("a Bearer token past half-life gets a fresh one in x-lisa-session", async () => {
    const { uid, sv } = await account("renew-bearer@example.com");
    const old = mintSession(uid, secret, { sv, now: Date.now() - 20 * DAY });
    const res = await me(bearer(old));
    assert.equal(res.status, 200);
    const fresh = res.headers.get("x-lisa-session");
    assert.ok(fresh, "renewed token in the header");
    assert.notEqual(fresh, old);
    const claims = verifySession(fresh, secret);
    assert.equal(claims?.uid, uid);
    assert.ok(claims.exp > Date.now() + SESSION_TTL_MS - 60_000, "a full new lifetime");
    // The renewed token authenticates on its own.
    const again = await me(bearer(fresh));
    assert.equal(((await again.json()) as { signedIn: boolean }).signedIn, true);
    assert.equal(again.headers.get("x-lisa-session"), null, "a fresh token is not renewed");
  });

  test("a cookie token past half-life is renewed by cookie, never by header", async () => {
    const { uid, sv } = await account("renew-cookie@example.com");
    const old = mintSession(uid, secret, { sv, now: Date.now() - 20 * DAY });
    const res = await me(cookie(old));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-lisa-session"), null);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = /lisa_token=([^;]+)/.exec(setCookie);
    assert.ok(m, "renewal cookie set");
    const fresh = decodeURIComponent(m[1]!);
    assert.notEqual(fresh, old);
    assert.equal(verifySession(fresh, secret)?.uid, uid);
  });

  test("a token before half-life is not renewed", async () => {
    const { uid, sv } = await account("renew-none@example.com");
    const res = await me(bearer(mintSession(uid, secret, { sv })));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-lisa-session"), null);
  });
});

describe("GET /api/auth/me reports the presented session's expiry (#484)", () => {
  test("sessionExpiresAt is the exp of the token on this request", async () => {
    const { uid, sv } = await account("me-expiry@example.com");
    const token = mintSession(uid, secret, { sv, now: Date.now() - DAY });
    const body = (await (await me(bearer(token))).json()) as {
      signedIn: boolean;
      sessionExpiresAt?: number;
    };
    assert.equal(body.signedIn, true);
    assert.equal(body.sessionExpiresAt, verifySession(token, secret)!.exp);
  });
});

describe("POST /api/auth/refresh (#484)", () => {
  test("mints a fresh session for a Bearer account session", async () => {
    const { uid, sv } = await account("refresh@example.com");
    const old = mintSession(uid, secret, { sv });
    const before = Date.now();
    const res = await refresh(bearer(old));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    assert.equal(typeof body.token, "string");
    assert.notEqual(body.token, old);
    const claims = verifySession(body.token, secret);
    assert.equal(claims?.uid, uid);
    assert.equal(claims?.exp, body.expiresAt);
    assert.ok(body.expiresAt >= before + SESSION_TTL_MS);
    assert.equal(res.headers.get("x-lisa-session"), body.token, "one token per answer");
    assert.equal((await me(bearer(body.token))).status, 200);
  });

  test("always mints, even for a token well before half-life", async () => {
    const { uid, sv } = await account("refresh-early@example.com");
    const res = await refresh(bearer(mintSession(uid, secret, { sv })));
    assert.equal(res.status, 200);
  });

  test("refuses callers without a Bearer account session with 401 unauthorized", async () => {
    const { uid, sv } = await account("refresh-cookie@example.com");
    for (const headers of [
      {},
      bearer("not-a-session"),
      bearer(mintSession(uid, "some-other-secret", { sv })),
      cookie(mintSession(uid, secret, { sv })),
    ]) {
      const res = await refresh(headers);
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "unauthorized");
    }
  });

  test("is rate limited per account", async () => {
    const { uid, sv } = await account("refresh-limit@example.com");
    const token = mintSession(uid, secret, { sv });
    let last: Response | undefined;
    for (let i = 0; i < 21; i++) last = await refresh(bearer(token));
    assert.equal(last!.status, 429);
    const body = (await last!.json()) as { error: string; retryAfterSec: number };
    assert.equal(body.error, "rate_limited");
    assert.ok(body.retryAfterSec > 0);
  });
});
