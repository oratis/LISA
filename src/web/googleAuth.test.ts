import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyGoogleIdToken,
  GoogleAuthError,
  googleSignInConfig,
  googleAudiences,
  type GoogleJWK,
} from "./googleAuth.js";

// A throwaway RSA key standing in for Google's signing key, exported as a JWK so
// the verifier imports it exactly as it would Google's real JWKS entry.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as unknown as GoogleJWK;
jwk.kid = "test-kid";
jwk.kty = "RSA";
jwk.alg = "RS256";

const WEB_AUD = "123-web.apps.googleusercontent.com";
const IOS_AUD = "123-ios.apps.googleusercontent.com";
const FIXED_NOW = 1_700_000_000_000;
const nowSec = Math.floor(FIXED_NOW / 1000);

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function mintToken(claims: Record<string, unknown>, opts: { kid?: string; alg?: string } = {}): string {
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? "test-kid", typ: "JWT" };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${sig}`;
}

const baseClaims = {
  iss: "https://accounts.google.com",
  aud: WEB_AUD,
  sub: "108123456789",
  iat: nowSec - 10,
  exp: nowSec + 3600,
  email: "user@example.com",
  email_verified: true,
};

const opts = {
  audiences: [WEB_AUD, IOS_AUD],
  fetchKeys: async () => [jwk],
  now: () => FIXED_NOW,
};

const isGoogleError = (msg: RegExp) => (e: unknown) =>
  e instanceof GoogleAuthError && msg.test(e.message);

describe("google id-token verification", () => {
  test("accepts a well-formed token", async () => {
    const id = await verifyGoogleIdToken(mintToken(baseClaims), opts);
    assert.equal(id.sub, "108123456789");
    assert.equal(id.email, "user@example.com");
  });

  test("accepts both issuer spellings", async () => {
    const id = await verifyGoogleIdToken(mintToken({ ...baseClaims, iss: "accounts.google.com" }), opts);
    assert.equal(id.sub, "108123456789");
  });

  test("accepts either configured client id", async () => {
    const id = await verifyGoogleIdToken(mintToken({ ...baseClaims, aud: IOS_AUD }), opts);
    assert.equal(id.sub, "108123456789");
  });

  test("rejects a tampered payload", async () => {
    const token = mintToken(baseClaims);
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64url({ ...baseClaims, sub: "999" })}.${s}`;
    await assert.rejects(verifyGoogleIdToken(forged, opts), isGoogleError(/bad signature/));
  });

  test("rejects a foreign issuer", async () => {
    await assert.rejects(
      verifyGoogleIdToken(mintToken({ ...baseClaims, iss: "https://evil.example" }), opts),
      isGoogleError(/wrong issuer/),
    );
  });

  test("rejects an audience we don't run", async () => {
    await assert.rejects(
      verifyGoogleIdToken(mintToken({ ...baseClaims, aud: "someone-else.apps.googleusercontent.com" }), opts),
      isGoogleError(/wrong audience/),
    );
  });

  test("rejects everything when no audience is configured", async () => {
    await assert.rejects(
      verifyGoogleIdToken(mintToken(baseClaims), { ...opts, audiences: [] }),
      isGoogleError(/wrong audience/),
    );
  });

  test("rejects an expired token, honouring the skew allowance", async () => {
    await assert.rejects(
      verifyGoogleIdToken(mintToken({ ...baseClaims, exp: nowSec - 120 }), opts),
      isGoogleError(/expired/),
    );
    // Inside the 60s tolerance it still passes.
    const id = await verifyGoogleIdToken(mintToken({ ...baseClaims, exp: nowSec - 30 }), opts);
    assert.equal(id.sub, "108123456789");
  });

  test("rejects alg confusion (alg: none)", async () => {
    const header = b64url({ alg: "none", kid: "test-kid", typ: "JWT" });
    const unsigned = `${header}.${b64url(baseClaims)}.`;
    await assert.rejects(verifyGoogleIdToken(unsigned, opts), isGoogleError(/unexpected alg/));
  });

  test("rejects an unknown key id", async () => {
    await assert.rejects(
      verifyGoogleIdToken(mintToken(baseClaims, { kid: "other-kid" }), opts),
      isGoogleError(/no matching Google signing key/),
    );
  });

  test("an unverified address is refused — it would be a takeover primitive", async () => {
    await assert.rejects(
      verifyGoogleIdToken(mintToken({ ...baseClaims, email_verified: false }), opts),
      isGoogleError(/not verified/),
    );
    await assert.rejects(
      verifyGoogleIdToken(mintToken({ ...baseClaims, email_verified: undefined }), opts),
      isGoogleError(/not verified/),
    );
  });

  test("accepts the legacy string form of email_verified", async () => {
    const id = await verifyGoogleIdToken(mintToken({ ...baseClaims, email_verified: "true" }), opts);
    assert.equal(id.email, "user@example.com");
  });

  test("rejects a token with no email at all", async () => {
    await assert.rejects(
      verifyGoogleIdToken(mintToken({ ...baseClaims, email: undefined }), opts),
      isGoogleError(/missing email/),
    );
  });

  test("nonce is checked when supplied (raw, not hashed)", async () => {
    const claims = { ...baseClaims, nonce: "raw-nonce-value" };
    const id = await verifyGoogleIdToken(mintToken(claims), { ...opts, expectedNonce: "raw-nonce-value" });
    assert.equal(id.sub, "108123456789");
    await assert.rejects(
      verifyGoogleIdToken(mintToken(claims), { ...opts, expectedNonce: "different" }),
      isGoogleError(/nonce mismatch/),
    );
    // A client that claims a nonce but gets a token without one is rejected.
    await assert.rejects(
      verifyGoogleIdToken(mintToken(baseClaims), { ...opts, expectedNonce: "raw-nonce-value" }),
      isGoogleError(/nonce mismatch/),
    );
  });

  test("rejects malformed input", async () => {
    await assert.rejects(verifyGoogleIdToken("not-a-jwt", opts), isGoogleError(/not a JWT/));
  });
});

describe("google config", () => {
  test("disabled with no client ids", () => {
    const cfg = googleSignInConfig({});
    assert.equal(cfg.enabled, false);
    assert.deepEqual(googleAudiences(cfg), []);
  });

  test("either id alone enables it; audiences list only what's configured", () => {
    const webOnly = googleSignInConfig({ LISA_GOOGLE_WEB_CLIENT_ID: WEB_AUD });
    assert.equal(webOnly.enabled, true);
    assert.deepEqual(googleAudiences(webOnly), [WEB_AUD]);

    const iosOnly = googleSignInConfig({ LISA_GOOGLE_IOS_CLIENT_ID: IOS_AUD });
    assert.equal(iosOnly.enabled, true);
    assert.equal(iosOnly.webClientId, null);
    assert.deepEqual(googleAudiences(iosOnly), [IOS_AUD]);
  });

  test("blank env values are treated as unset", () => {
    const cfg = googleSignInConfig({ LISA_GOOGLE_WEB_CLIENT_ID: "   " });
    assert.equal(cfg.enabled, false);
  });
});
