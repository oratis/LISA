import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyGoogleIdToken,
  GoogleAuthError,
  googleSignInConfig,
  type GoogleJWK,
} from "./googleAuth.js";

// A throwaway RSA key standing in for Google's signing key, exported as a JWK
// so the verifier imports it exactly as it would Google's real JWKS entry.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as unknown as GoogleJWK;
jwk.kid = "test-kid";
jwk.kty = "RSA";
jwk.alg = "RS256";

const AUD = "1234-abcd.apps.googleusercontent.com";
const FIXED_NOW = 1_700_000_000_000; // fixed clock so exp/iat are deterministic
const nowSec = Math.floor(FIXED_NOW / 1000);

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Mint a signed Google-style ID token for tests. */
function mintToken(claims: Record<string, unknown>, opts: { kid?: string; alg?: string } = {}): string {
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? "test-kid", typ: "JWT" };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${sig}`;
}

const baseClaims = {
  iss: "https://accounts.google.com",
  aud: AUD,
  sub: "110169484474386276334",
  iat: nowSec - 10,
  exp: nowSec + 3600,
  email: "user@gmail.com",
  email_verified: true,
};

const opts = {
  audience: AUD,
  fetchKeys: async () => [jwk],
  now: () => FIXED_NOW,
};

describe("verifyGoogleIdToken", () => {
  test("verifies a well-formed Google ID token", async () => {
    const id = await verifyGoogleIdToken(mintToken(baseClaims), opts);
    assert.equal(id.sub, "110169484474386276334");
    assert.equal(id.email, "user@gmail.com");
    assert.equal(id.emailVerified, true);
  });

  test("accepts both issuer spellings", async () => {
    const bare = await verifyGoogleIdToken(mintToken({ ...baseClaims, iss: "accounts.google.com" }), opts);
    assert.equal(bare.sub, baseClaims.sub);
  });

  test("email_verified arrives as a string in some flows", async () => {
    const id = await verifyGoogleIdToken(mintToken({ ...baseClaims, email_verified: "true" }), opts);
    assert.equal(id.emailVerified, true);
    const off = await verifyGoogleIdToken(mintToken({ ...baseClaims, email_verified: "false" }), opts);
    assert.equal(off.emailVerified, false);
  });

  test("rejects a foreign issuer", async () => {
    await assert.rejects(
      () => verifyGoogleIdToken(mintToken({ ...baseClaims, iss: "https://appleid.apple.com" }), opts),
      (e: Error) => e instanceof GoogleAuthError && /wrong issuer/.test(e.message),
    );
  });

  test("rejects a wrong audience (token minted for another app)", async () => {
    await assert.rejects(
      () => verifyGoogleIdToken(mintToken({ ...baseClaims, aud: "evil.apps.googleusercontent.com" }), opts),
      (e: Error) => e instanceof GoogleAuthError && /wrong audience/.test(e.message),
    );
  });

  test("rejects an expired token (beyond clock tolerance)", async () => {
    await assert.rejects(
      () => verifyGoogleIdToken(mintToken({ ...baseClaims, exp: nowSec - 120 }), opts),
      (e: Error) => e instanceof GoogleAuthError && /expired/.test(e.message),
    );
  });

  test("rejects a tampered payload (signature over original bytes)", async () => {
    const good = mintToken(baseClaims);
    const parts = good.split(".");
    const forged = `${parts[0]}.${b64url({ ...baseClaims, sub: "999" })}.${parts[2]}`;
    await assert.rejects(
      () => verifyGoogleIdToken(forged, opts),
      (e: Error) => e instanceof GoogleAuthError && /bad signature/.test(e.message),
    );
  });

  test("rejects unknown kid and non-RS256 alg", async () => {
    await assert.rejects(
      () => verifyGoogleIdToken(mintToken(baseClaims, { kid: "other-kid" }), opts),
      (e: Error) => e instanceof GoogleAuthError && /no matching/.test(e.message),
    );
    // alg confusion (e.g. HS256 with the public key as HMAC secret) must never verify
    const header = { alg: "HS256", kid: "test-kid", typ: "JWT" };
    const signingInput = `${b64url(header)}.${b64url(baseClaims)}`;
    const mac = crypto
      .createHmac("sha256", publicKey.export({ type: "spki", format: "pem" }))
      .update(signingInput)
      .digest("base64url");
    await assert.rejects(
      () => verifyGoogleIdToken(`${signingInput}.${mac}`, opts),
      (e: Error) => e instanceof GoogleAuthError && /unexpected alg/.test(e.message),
    );
  });

  test("rejects garbage that isn't a JWT", async () => {
    await assert.rejects(() => verifyGoogleIdToken("not-a-jwt", opts), GoogleAuthError);
  });
});

describe("googleSignInConfig", () => {
  test("default-OFF; flag alone is not enough — the client id is the audience", () => {
    assert.equal(googleSignInConfig({}).enabled, false);
    assert.equal(googleSignInConfig({ LISA_CLOUD_GOOGLE_SIGNIN: "1" }).enabled, false);
    assert.equal(
      googleSignInConfig({ LISA_CLOUD_GOOGLE_CLIENT_ID: AUD }).enabled,
      false,
    );
  });

  test("on when flag + client id are both set", () => {
    const cfg = googleSignInConfig({
      LISA_CLOUD_GOOGLE_SIGNIN: "1",
      LISA_CLOUD_GOOGLE_CLIENT_ID: ` ${AUD} `,
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.clientId, AUD);
  });
});
