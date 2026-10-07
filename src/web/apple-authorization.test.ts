import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  appleAuthorizationConfig,
  appleClientSecret,
  exchangeAppleAuthorizationCode,
  revokeAppleAuthorization,
  encryptAppleRefreshToken,
  decryptAppleRefreshToken,
} from "./apple-authorization.js";

const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const config = {
  teamId: "TESTTEAM",
  keyId: "TESTKEY",
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const clientId = "ai.meetlisa.main";

test("Apple client secret is an expiring ES256 JWT scoped to this App ID", () => {
  const jwt = appleClientSecret(config, clientId, 1_800_000_000_000);
  const [header, body, signature] = jwt.split(".") as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "ES256",
    kid: "TESTKEY",
  });
  assert.deepEqual(JSON.parse(Buffer.from(body, "base64url").toString()), {
    iss: "TESTTEAM",
    sub: clientId,
    aud: "https://appleid.apple.com",
    iat: 1_800_000_000,
    exp: 1_800_000_300,
  });
  assert.ok(
    crypto.verify(
      "sha256",
      Buffer.from(`${header}.${body}`),
      { key: keys.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  );
});

test("missing configuration never creates a client secret from the ASC upload key", () => {
  assert.equal(appleAuthorizationConfig({ ASC_KEY_ID: "upload-only" }), null);
  assert.equal(appleAuthorizationConfig({ LISA_APPLE_TEAM_ID: "TEAM" }), null);
  assert.equal(
    appleAuthorizationConfig({
      LISA_APPLE_TEAM_ID: "TEAM",
      LISA_APPLE_KEY_ID: "KEY",
      LISA_APPLE_PRIVATE_KEY: "line1\\nline2",
    })?.privateKey,
    "line1\nline2",
  );
});

test("authorization code is exchanged with Apple's endpoint and revocation uses the returned refresh token", async () => {
  const tokens = await exchangeAppleAuthorizationCode(config, clientId, "one-time-code", {
    fetch: async (url, init) => {
      assert.equal(url, "https://appleid.apple.com/auth/token");
      assert.equal(init?.method, "POST");
      const form = init?.body as URLSearchParams;
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "one-time-code");
      assert.equal(form.get("client_id"), clientId);
      return Response.json({ refresh_token: "private-refresh", id_token: "signed-identity" });
    },
  });
  assert.deepEqual(tokens, { refreshToken: "private-refresh", identityToken: "signed-identity" });
  await revokeAppleAuthorization(config, clientId, tokens.refreshToken, async (url, init) => {
    assert.equal(url, "https://appleid.apple.com/auth/revoke");
    const form = init?.body as URLSearchParams;
    assert.equal(form.get("token_type_hint"), "refresh_token");
    assert.equal(form.get("token"), "private-refresh");
    assert.equal(form.get("client_id"), clientId);
    return new Response(null, { status: 200 });
  });
});

test("refused or malformed Apple responses fail without leaking credentials", async () => {
  for (const response of [
    Response.json({ error: "private-secret" }, { status: 400 }),
    Response.json({ access_token: "private-secret" }),
  ]) {
    await assert.rejects(
      exchangeAppleAuthorizationCode(config, clientId, "secret-code", {
        fetch: async () => response,
      }),
      { message: "apple_authorization_failed" },
    );
  }
  await assert.rejects(
    revokeAppleAuthorization(config, clientId, "private-refresh", async () => {
      throw new Error("private-refresh");
    }),
    { message: "apple_revocation_failed" },
  );
});

test("stored Apple authorization is confidential and cannot be moved between accounts or App IDs", () => {
  const encrypted = encryptAppleRefreshToken(
    "private-refresh",
    "server-secret",
    "apple-user",
    clientId,
  );
  assert.ok(!encrypted.includes("private-refresh"));
  assert.equal(
    decryptAppleRefreshToken(encrypted, "server-secret", "apple-user", clientId),
    "private-refresh",
  );
  for (const [secret, uid, app] of [
    ["wrong-secret", "apple-user", clientId],
    ["server-secret", "another-user", clientId],
    ["server-secret", "apple-user", "another-app"],
  ]) {
    assert.throws(() => decryptAppleRefreshToken(encrypted, secret!, uid!, app!), {
      message: "apple_revocation_failed",
    });
  }
  assert.notEqual(
    encryptAppleRefreshToken("private-refresh", "server-secret", "apple-user", clientId),
    encrypted,
  );
});
