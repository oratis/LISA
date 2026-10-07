/** Exercise account deletion through the actual cloud HTTP server, with disposable data. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-delete-audit-"));
process.env.LISA_HOME = dir;
process.env.CLAUDE_HOME = path.join(dir, "claude");
process.env.LISA_EDITION = "cloud";
process.env.LISA_CLOUD_APPLE_SIGNIN = "1";
process.env.LISA_PUBLIC_ORIGIN = "https://cloud.example.com";
process.env.LISA_WEB_TOKEN = "test-only-operator-token";
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
for (const name of [
  "LISA_REVIEWER_SEED",
  "LISA_FIRESTORE_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "LISA_MANAGED_SESSION",
  "LISA_MODEL_FALLBACK",
  "LISA_BASE_URL",
  "LISA_PROVIDER",
])
  delete process.env[name];

const { startWebServer } = await import("./server.js");
const { createEmailAccount, upsertAppleAccount, getAccount, saveAppleAuthorization, loadAccounts } =
  await import("./accounts.js");
const { encryptAppleRefreshToken, decryptAppleRefreshToken } =
  await import("./apple-authorization.js");
const { mintSession, loadOrCreateSessionSecret } = await import("./sessions-auth.js");
let server: Awaited<ReturnType<typeof startWebServer>>;
let base: string;
let secret: string;
const originalFetch = globalThis.fetch;
let appleRevocations = 0;
let refuseRevocation = false;
let exchangedSubject = "code-user";
const identityKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const identityJwk = {
  ...identityKeys.publicKey.export({ format: "jwk" }),
  kid: "audit-key",
  alg: "RS256",
};
function identityToken(sub: string): string {
  const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${encode({ alg: "RS256", kid: "audit-key" })}.${encode({
    sub,
    iss: "https://appleid.apple.com",
    aud: "ai.meetlisa.main",
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: crypto.createHash("sha256").update("audit-nonce").digest("hex"),
  })}`;
  return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), identityKeys.privateKey).toString("base64url")}`;
}

before(async () => {
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  process.env.LISA_APPLE_TEAM_ID = "TESTTEAM";
  process.env.LISA_APPLE_KEY_ID = "TESTKEY";
  process.env.LISA_APPLE_PRIVATE_KEY = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  // No real Apple tokens, accounts, mail or model calls in this suite.
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://appleid.apple.com/auth/keys")
      return Response.json({ keys: [identityJwk] });
    if (String(url) === "https://appleid.apple.com/auth/token") {
      assert.equal((init?.body as URLSearchParams).get("code"), "test-code");
      return Response.json({
        refresh_token: "test-refresh",
        id_token: identityToken(exchangedSubject),
      });
    }
    if (String(url) === "https://appleid.apple.com/auth/revoke") {
      appleRevocations++;
      assert.equal((init?.body as URLSearchParams).get("token"), "test-refresh");
      return new Response(null, { status: refuseRevocation ? 503 : 200 });
    }
    if (!String(url).startsWith("http://127.0.0.1:"))
      throw new Error("unexpected external request");
    return originalFetch(url, init);
  };
  server = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    tools: [],
    model: "gemini-2.5-flash",
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
  fs.chmodSync(path.join(dir, "users"), 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

function request(token: string, route = "/api/account", method = "DELETE") {
  return fetch(base + route, { method, headers: { authorization: `Bearer ${token}` } });
}

test("cloud introspection calls no AI; deleting account removes only its files and invalidates every session", async () => {
  const user = await createEmailAccount("delete@example.com", "test-password");
  const other = await createEmailAccount("keep@example.com", "test-password");
  const home = path.join(dir, "users", user.uid);
  const otherHome = path.join(dir, "users", other.uid);
  for (const folder of [home, otherHome]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "private.txt"), "private test data");
  }
  const token = mintSession(user.uid, secret);
  assert.equal((await request(token, "/api/auth/me", "GET")).status, 200);
  assert.deepEqual(
    fs.readdirSync(home),
    ["private.txt"],
    "opening account settings must not create a soul through AI",
  );
  const reply = await request(token);
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), {
    ok: true,
    removed: true,
    requiresManualAppleRevocation: false,
  });
  assert.equal(fs.existsSync(home), false);
  assert.equal(fs.readFileSync(path.join(otherHome, "private.txt"), "utf8"), "private test data");
  assert.equal((await request(token, "/api/auth/me", "GET")).status, 401);
});

test("legacy Apple deletion succeeds and returns the documented manual-revocation follow-up", async () => {
  const user = await upsertAppleAccount("legacy-apple", "legacy@example.com");
  const reply = await request(mintSession(user.uid, secret));
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).requiresManualAppleRevocation, true);
  assert.equal(await getAccount(user.uid), null);
});

test("Apple authorization is revoked before deletion, and a refusal preserves the account for retry", async () => {
  const user = await upsertAppleAccount("new-apple", "apple@example.com");
  await saveAppleAuthorization(user.uid, {
    clientId: "ai.meetlisa.main",
    encryptedRefreshToken: encryptAppleRefreshToken(
      "test-refresh",
      secret,
      user.uid,
      "ai.meetlisa.main",
    ),
  });
  const token = mintSession(user.uid, secret);
  const me = await (await request(token, "/api/auth/me", "GET")).json();
  assert.equal(me.appleUserId, "new-apple");
  assert.ok(!JSON.stringify(me).includes("RefreshToken"));
  refuseRevocation = true;
  assert.equal((await request(token)).status, 503);
  assert.ok(await getAccount(user.uid));
  refuseRevocation = false;
  const reply = await request(token);
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).requiresManualAppleRevocation, false);
  assert.equal(appleRevocations, 2);
  assert.equal(await getAccount(user.uid), null);
});

test(
  "failed file cleanup is reported as failure instead of deleting the only credential for a retry",
  { skip: process.platform === "win32" },
  async () => {
    const user = await createEmailAccount("retry@example.com", "test-password");
    const token = mintSession(user.uid, secret);
    const home = path.join(dir, "users", user.uid);
    fs.mkdirSync(home, { recursive: true });
    const parent = path.dirname(home);
    fs.chmodSync(parent, 0o500);
    try {
      const reply = await request(token);
      assert.equal(reply.status, 503);
      assert.ok(await getAccount(user.uid));
    } finally {
      fs.chmodSync(parent, 0o700);
    }
    assert.equal((await request(token)).status, 200);
    assert.equal(fs.existsSync(home), false);
  },
);

test("Apple login exchanges its code, binds the returned identity and stores only encrypted authorization", async () => {
  const login = async (sub: string) =>
    fetch(base + "/api/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identityToken: identityToken(sub),
        authorizationCode: "test-code",
        nonce: "audit-nonce",
      }),
    });
  exchangedSubject = "wrong-user";
  assert.equal((await login("code-user")).status, 401);
  assert.ok(!(await loadAccounts()).some((a) => a.appleSub === "code-user"));
  exchangedSubject = "code-user";
  const response = await login("code-user");
  assert.equal(response.status, 200);
  const { uid, token } = await response.json();
  const account = await getAccount(uid);
  assert.ok(account?.appleAuthorization);
  assert.ok(!JSON.stringify(account).includes("test-refresh"));
  assert.equal(
    decryptAppleRefreshToken(
      account.appleAuthorization.encryptedRefreshToken,
      secret,
      uid,
      "ai.meetlisa.main",
    ),
    "test-refresh",
  );
  assert.equal((await request(token)).status, 200);
});
