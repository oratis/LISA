/**
 * Sign in with Google — ID-token verification for the hosted LISA Cloud
 * edition (docs/PLAN_WEB_SIGNUP_v1.0.md S1).
 *
 * The login page runs Google Identity Services (GIS); its callback hands the
 * browser a **ID token** (a JWT signed by Google) which the page POSTs to
 * `POST /api/auth/google`. We verify it here against Google's published JWKS
 * and, on success, the server upserts the account and mints a per-uid session
 * — the exact posture of the Apple channel (src/web/cloudAuth.ts).
 *
 * Deliberately mirrors cloudAuth.ts rather than abstracting over it: the two
 * issuers differ in issuer set (Google uses two `iss` values), audience
 * semantics (OAuth client id, not a bundle id), and replay posture (GIS
 * tokens are minted per page-load by Google's own script and live ~1h; there
 * is no client-mintable raw nonce in the button flow, so we accept the token
 * lifetime as the replay window — the same stance as pre-nonce Apple clients).
 *
 * No external dependencies: RS256 verifies natively from a JWK via
 * `node:crypto`. The verifier is pure (JWKS fetch + clock injected) so it
 * unit-tests offline — see googleAuth.test.ts.
 */
import crypto from "node:crypto";

/** A single JSON Web Key from Google's JWKS (the RSA fields we use). */
export interface GoogleJWK {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n: string;
  e: string;
}

/** The verified subset of a Google ID token we act on. */
export interface GoogleIdentity {
  /** Stable Google account id (`sub`, a decimal string). The account key. */
  sub: string;
  /** The account's email. Google includes it when the `email` scope is granted. */
  email?: string;
  /** Google's own assertion that it verified ownership of that email. */
  emailVerified?: boolean;
}

export interface VerifyGoogleOptions {
  /** Expected `aud` — the OAuth 2.0 web client id (…apps.googleusercontent.com). */
  audience: string;
  /** Returns Google's current signing keys. Injected so tests run offline. */
  fetchKeys: () => Promise<GoogleJWK[]>;
  /** Clock seam for tests (ms since epoch). Defaults to Date.now(). */
  now?: () => number;
  /** Leeway for clock skew, seconds (default 60). */
  clockToleranceSec?: number;
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

// Google mints `iss` in both bare and https forms depending on the flow.
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const GOOGLE_KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs";

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(b64urlToBuffer(segment).toString("utf8"));
  } catch {
    throw new GoogleAuthError("malformed token segment");
  }
}

/**
 * Verify a Google ID-token JWT. Throws `GoogleAuthError` on any failure
 * (bad signature, wrong issuer/audience, expired). Returns the identity on success.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  opts: VerifyGoogleOptions,
): Promise<GoogleIdentity> {
  const now = opts.now ?? Date.now;
  const tolerance = opts.clockToleranceSec ?? 60;

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleAuthError("not a JWT");
  const headerB64 = parts[0] as string;
  const payloadB64 = parts[1] as string;
  const sigB64 = parts[2] as string;

  const header = decodeJson(headerB64);
  if (header.alg !== "RS256") throw new GoogleAuthError(`unexpected alg ${String(header.alg)}`);
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) throw new GoogleAuthError("missing key id");

  const keys = await opts.fetchKeys();
  const jwk = keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (!jwk) throw new GoogleAuthError("no matching Google signing key");

  // RS256 = RSASSA-PKCS1-v1_5 over SHA-256. Node imports the JWK directly.
  const pubKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: "jwk" });
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const ok = crypto.verify("RSA-SHA256", signingInput, pubKey, b64urlToBuffer(sigB64));
  if (!ok) throw new GoogleAuthError("bad signature");

  const claims = decodeJson(payloadB64);
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) {
    throw new GoogleAuthError("wrong issuer");
  }

  // `aud` may be a string or array.
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience;
  if (!audOk) throw new GoogleAuthError("wrong audience");

  const nowSec = Math.floor(now() / 1000);
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  if (exp + tolerance < nowSec) throw new GoogleAuthError("token expired");
  const iat = typeof claims.iat === "number" ? claims.iat : 0;
  if (iat - tolerance > nowSec) throw new GoogleAuthError("token not yet valid");

  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) throw new GoogleAuthError("missing subject");

  const email = typeof claims.email === "string" ? claims.email : undefined;
  const emailVerified =
    claims.email_verified === true || claims.email_verified === "true" ? true
    : claims.email_verified === false || claims.email_verified === "false" ? false
    : undefined;

  return { sub, email, emailVerified };
}

// ── Google JWKS fetch (cached) ──────────────────────────────────────────────
let keyCache: { keys: GoogleJWK[]; at: number } | null = null;
// Google rotates roughly daily and old keys stay valid past rotation; an hour
// of caching (matching the Apple channel) never strands a fresh token.
const KEY_TTL_MS = 60 * 60 * 1000;

/** Fetch Google's signing keys, cached for an hour. The default `fetchKeys`. */
export async function fetchGoogleKeys(now: () => number = Date.now): Promise<GoogleJWK[]> {
  if (keyCache && now() - keyCache.at < KEY_TTL_MS) return keyCache.keys;
  const res = await fetch(GOOGLE_KEYS_URL);
  if (!res.ok) throw new GoogleAuthError(`Google JWKS fetch failed (${res.status})`);
  const body = (await res.json()) as { keys?: GoogleJWK[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (keys.length === 0) throw new GoogleAuthError("Google JWKS empty");
  keyCache = { keys, at: now() };
  return keys;
}

// ── Endpoint configuration (env) ────────────────────────────────────────────

export interface GoogleSignInConfig {
  /** Whether the endpoint is live. Off unless BOTH the flag and client id are set. */
  enabled: boolean;
  /** The OAuth web client id — the expected token audience. Null ⇒ disabled. */
  clientId: string | null;
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Read the Sign in with Google config from the environment. Default-OFF: the
 * endpoint (and the login-page button) light up only when
 * `LISA_CLOUD_GOOGLE_SIGNIN` is truthy AND `LISA_CLOUD_GOOGLE_CLIENT_ID` names
 * the OAuth web client — same flag philosophy as the Apple channel.
 */
export function googleSignInConfig(env: NodeJS.ProcessEnv = process.env): GoogleSignInConfig {
  const clientId = env.LISA_CLOUD_GOOGLE_CLIENT_ID?.trim() || null;
  return {
    enabled: truthy(env.LISA_CLOUD_GOOGLE_SIGNIN) && !!clientId,
    clientId,
  };
}
