import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyAppleIdentityToken,
  AppleAuthError,
  appleSignInConfig,
  audienceForClient,
  subAllowed,
  type AppleJWK,
} from "./cloudAuth.js";

// A throwaway RSA key standing in for Apple's signing key, exported as a JWK so
// the verifier imports it exactly as it would Apple's real JWKS entry.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as unknown as AppleJWK;
jwk.kid = "test-kid";
jwk.kty = "RSA";
jwk.alg = "RS256";

const AUD = "ai.meetlisa.main";
const FIXED_NOW = 1_700_000_000_000; // fixed clock so exp/iat are deterministic
const nowSec = Math.floor(FIXED_NOW / 1000);

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Mint a signed Apple-style identity token for tests. */
function mintToken(claims: Record<string, unknown>, opts: { kid?: string; alg?: string } = {}): string {
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? "test-kid", typ: "JWT" };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${sig}`;
}

const baseClaims = {
  iss: "https://appleid.apple.com",
  aud: AUD,
  sub: "001234.abcd",
  iat: nowSec - 10,
  exp: nowSec + 3600,
  email: "user@example.com",
  email_verified: "true",
};

const opts = {
  audience: AUD,
  fetchKeys: async () => [jwk],
  now: () => FIXED_NOW,
};

test("verifies a well-formed Apple identity token", async () => {
  const id = await verifyAppleIdentityToken(mintToken(baseClaims), opts);
  assert.equal(id.sub, "001234.abcd");
  assert.equal(id.email, "user@example.com");
  assert.equal(id.emailVerified, true);
});

test("accepts aud given as an array", async () => {
  const id = await verifyAppleIdentityToken(mintToken({ ...baseClaims, aud: ["other", AUD] }), opts);
  assert.equal(id.sub, "001234.abcd");
});

test("rejects a tampered payload (signature mismatch)", async () => {
  const tok = mintToken(baseClaims);
  const [h, , s] = tok.split(".");
  const forged = `${h}.${b64url({ ...baseClaims, sub: "999.evil" })}.${s}`;
  await assert.rejects(() => verifyAppleIdentityToken(forged, opts), AppleAuthError);
});

test("rejects the wrong audience", async () => {
  await assert.rejects(
    () => verifyAppleIdentityToken(mintToken({ ...baseClaims, aud: "com.someone.else" }), opts),
    /wrong audience/,
  );
});

test("rejects the wrong issuer", async () => {
  await assert.rejects(
    () => verifyAppleIdentityToken(mintToken({ ...baseClaims, iss: "https://evil.example" }), opts),
    /wrong issuer/,
  );
});

test("rejects an expired token (beyond tolerance)", async () => {
  await assert.rejects(
    () => verifyAppleIdentityToken(mintToken({ ...baseClaims, exp: nowSec - 3600 }), opts),
    /expired/,
  );
});

test("rejects a token signed by an unknown key id", async () => {
  await assert.rejects(
    () => verifyAppleIdentityToken(mintToken(baseClaims, { kid: "other-kid" }), opts),
    /no matching Apple signing key/,
  );
});

test("rejects a non-RS256 alg (algorithm confusion guard)", async () => {
  // Hand-craft an unsigned-style token claiming alg=none.
  const header = b64url({ alg: "none", kid: "test-kid", typ: "JWT" });
  const tok = `${header}.${b64url(baseClaims)}.`;
  await assert.rejects(() => verifyAppleIdentityToken(tok, opts), /unexpected alg/);
});

test("appleSignInConfig is default-off and parses the allowlist", () => {
  assert.equal(appleSignInConfig({}).enabled, false);
  const cfg = appleSignInConfig({
    LISA_CLOUD_APPLE_SIGNIN: "1",
    LISA_CLOUD_APPLE_SUBS: " a , b ,, c ",
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.audience, "ai.meetlisa.main");
  assert.deepEqual(cfg.allowedSubs, ["a", "b", "c"]);
});

test("subAllowed: empty allowlist admits anyone; non-empty restricts", () => {
  assert.equal(subAllowed("x", { enabled: true, audience: AUD, allowedSubs: [] }), true);
  assert.equal(subAllowed("x", { enabled: true, audience: AUD, allowedSubs: ["y"] }), false);
  assert.equal(subAllowed("y", { enabled: true, audience: AUD, allowedSubs: ["y"] }), true);
});

test("webServicesId parses from env; absent → null (B8b)", () => {
  const on = appleSignInConfig({ LISA_CLOUD_APPLE_WEB_SID: " ai.meetlisa.web " } as NodeJS.ProcessEnv);
  assert.equal(on.webServicesId, "ai.meetlisa.web");
  assert.equal(appleSignInConfig({} as NodeJS.ProcessEnv).webServicesId, null);
});

test("audienceForClient picks the surface's aud and rejects unconfigured web (B8b)", () => {
  const cfg = appleSignInConfig({ LISA_CLOUD_APPLE_WEB_SID: "ai.meetlisa.web" } as NodeJS.ProcessEnv);
  assert.equal(audienceForClient(cfg, "native"), "ai.meetlisa.main");
  assert.equal(audienceForClient(cfg, "web"), "ai.meetlisa.web");
  const bare = appleSignInConfig({} as NodeJS.ProcessEnv);
  assert.equal(audienceForClient(bare, "web"), null);
});
