/**
 * Sign in with Google — ID-token verification
 * (docs/PLAN_AUTH_OTP_GOOGLE_v1.0.md §2.2, milestone A3).
 *
 * The sibling of cloudAuth.ts, and deliberately the same shape: Google signs its
 * ID tokens with RS256, which Node verifies natively from a JWK, so this stays
 * zero-dependency and unit-testable offline (JWKS fetch + clock injected).
 *
 * Two client surfaces mint tokens with different audiences — the web page's
 * Google Identity Services button (`aud` = the Web client id) and the iOS app's
 * PKCE flow (`aud` = the iOS client id). Both are accepted only when the
 * matching id is configured, so an unconfigured surface can't slip a token past
 * the wrong audience check.
 *
 * `email_verified` is REQUIRED, not advisory: the address is what binds a Google
 * identity to an existing LISA account (accounts.ts), so an unproven address
 * would be an account-takeover primitive.
 *
 * Env: LISA_GOOGLE_WEB_CLIENT_ID, LISA_GOOGLE_IOS_CLIENT_ID. With neither set
 * the endpoint reports disabled and rejects everything.
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
  /** Stable Google account id (`sub`) — the identity anchor. */
  sub: string;
  /** Always present and always verified (we reject the token otherwise). */
  email: string;
}

export interface VerifyGoogleOptions {
  /** Accepted `aud` values — the configured client ids for the live surfaces. */
  audiences: string[];
  /** Returns Google's current signing keys. Injected so tests run offline. */
  fetchKeys: () => Promise<GoogleJWK[]>;
  /** Clock seam for tests (ms since epoch). Defaults to Date.now(). */
  now?: () => number;
  /** Leeway for clock skew, seconds (default 60). */
  clockToleranceSec?: number;
  /**
   * Raw nonce this sign-in minted. Google echoes it back verbatim (unlike
   * Apple, which echoes SHA-256 of it). Omitted ⇒ no nonce check.
   */
  expectedNonce?: string;
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

// Google has issued tokens under both spellings for years; both are canonical.
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const GOOGLE_KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs";

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(b64urlToBuffer(segment).toString("utf8"));
  } catch {
    throw new GoogleAuthError("malformed token segment");
  }
}

/**
 * Verify a Google ID-token JWT. Throws `GoogleAuthError` on any failure (bad
 * signature, wrong issuer/audience, expired, unverified email). Returns the
 * identity on success.
 */
export async function verifyGoogleIdToken(idToken: string, opts: VerifyGoogleOptions): Promise<GoogleIdentity> {
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

  const pubKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: "jwk" });
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  if (!crypto.verify("RSA-SHA256", signingInput, pubKey, b64urlToBuffer(sigB64))) {
    throw new GoogleAuthError("bad signature");
  }

  const claims = decodeJson(payloadB64);
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) {
    throw new GoogleAuthError("wrong issuer");
  }

  // An empty audience list means nothing is configured — reject rather than
  // vacuously pass.
  const aud = claims.aud;
  const audOk = opts.audiences.length > 0 && typeof aud === "string" && opts.audiences.includes(aud);
  if (!audOk) throw new GoogleAuthError("wrong audience");

  const nowSec = Math.floor(now() / 1000);
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  if (exp + tolerance < nowSec) throw new GoogleAuthError("token expired");
  const iat = typeof claims.iat === "number" ? claims.iat : 0;
  if (iat - tolerance > nowSec) throw new GoogleAuthError("token not yet valid");

  if (opts.expectedNonce !== undefined) {
    const got = typeof claims.nonce === "string" ? claims.nonce : "";
    if (!got || !timingSafeEqualStr(got, opts.expectedNonce)) throw new GoogleAuthError("nonce mismatch");
  }

  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) throw new GoogleAuthError("missing subject");

  const email = typeof claims.email === "string" ? claims.email : "";
  if (!email) throw new GoogleAuthError("missing email");
  // The address is what binds this identity to an existing LISA account, so an
  // unverified one would be a takeover primitive. Google sends a real boolean;
  // some older paths sent the string. Anything else ⇒ reject.
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!verified) throw new GoogleAuthError("email not verified by Google");

  return { sub, email };
}

// ── Google JWKS fetch (cached) ──────────────────────────────────────────────
let keyCache: { keys: GoogleJWK[]; at: number } | null = null;
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

/** Test seam. */
export function _resetGoogleKeyCacheForTests(): void {
  keyCache = null;
}

// ── Endpoint configuration (env) ────────────────────────────────────────────

export interface GoogleSignInConfig {
  /** Live when at least one client id is configured. */
  enabled: boolean;
  /** GIS button on the login page; null ⇒ the button stays hidden. */
  webClientId: string | null;
  /** The iOS app's PKCE flow. */
  iosClientId: string | null;
}

export function googleSignInConfig(env: NodeJS.ProcessEnv = process.env): GoogleSignInConfig {
  const webClientId = env.LISA_GOOGLE_WEB_CLIENT_ID?.trim() || null;
  const iosClientId = env.LISA_GOOGLE_IOS_CLIENT_ID?.trim() || null;
  return { enabled: !!(webClientId || iosClientId), webClientId, iosClientId };
}

/**
 * Audiences a token may legitimately carry. Only configured surfaces are
 * accepted, so a token minted for a client id we don't run is rejected.
 */
export function googleAudiences(cfg: GoogleSignInConfig): string[] {
  return [cfg.webClientId, cfg.iosClientId].filter((v): v is string => !!v);
}
