/**
 * Sign in with Apple — identity-token verification for the hosted LISA Cloud
 * edition (docs/PLAN_CLOUD_v1.0.md §"Auth + account lifecycle", milestone M4 of
 * docs/PLAN_IOS_ONBOARDING_v1.0.md).
 *
 * The iOS app runs the native Sign in with Apple flow and POSTs the resulting
 * **identity token** (a JWT signed by Apple) to `POST /api/auth/apple`. We verify
 * it here against Apple's published public keys and, on success, hand back the
 * cloud session token so the phone can authenticate like any other client.
 *
 * Scope is deliberately single-tenant (matches the deployed M0/C2 demo: one
 * shared soul behind one `LISA_WEB_TOKEN`). Verifying Apple's signature lets a
 * reviewer — or any operator-approved Apple ID — sign in instead of pasting the
 * token, which is the App Store reviewability unlock. Per-`uid` isolation +
 * Firebase + account deletion stay deferred C3 work; this module does NOT mint
 * per-user state.
 *
 * No external dependencies: Apple uses RS256, which Node verifies natively from
 * a JWK via `node:crypto`. The verifier is pure (JWKS fetch + clock injected) so
 * it unit-tests offline — see cloudAuth.test.ts.
 */
import crypto from "node:crypto";

/** A single JSON Web Key from Apple's JWKS (the RSA fields we use). */
export interface AppleJWK {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n: string;
  e: string;
}

/** The verified subset of an Apple identity token we act on. */
export interface AppleIdentity {
  /** Stable, team-scoped user id (`sub`). The account key if/when we go multi-tenant. */
  sub: string;
  /** Present only when the user shared it (first sign-in, or always for real email). */
  email?: string;
  /** Whether Apple marked the email verified ("true"/"false" string in the JWT). */
  emailVerified?: boolean;
}

export interface VerifyAppleOptions {
  /** Expected `aud` — the app's bundle id (e.g. `ai.meetlisa.main`). */
  audience: string;
  /** Returns Apple's current signing keys. Injected so tests run offline. */
  fetchKeys: () => Promise<AppleJWK[]>;
  /** Clock seam for tests (ms since epoch). Defaults to Date.now(). */
  now?: () => number;
  /** Leeway for clock skew, seconds (default 60). */
  clockToleranceSec?: number;
}

export class AppleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleAuthError";
  }
}

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(b64urlToBuffer(segment).toString("utf8"));
  } catch {
    throw new AppleAuthError("malformed token segment");
  }
}

/**
 * Verify an Apple identity-token JWT. Throws `AppleAuthError` on any failure
 * (bad signature, wrong issuer/audience, expired). Returns the identity on success.
 */
export async function verifyAppleIdentityToken(
  idToken: string,
  opts: VerifyAppleOptions,
): Promise<AppleIdentity> {
  const now = opts.now ?? Date.now;
  const tolerance = opts.clockToleranceSec ?? 60;

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AppleAuthError("not a JWT");
  const headerB64 = parts[0] as string;
  const payloadB64 = parts[1] as string;
  const sigB64 = parts[2] as string;

  const header = decodeJson(headerB64);
  if (header.alg !== "RS256") throw new AppleAuthError(`unexpected alg ${String(header.alg)}`);
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) throw new AppleAuthError("missing key id");

  const keys = await opts.fetchKeys();
  const jwk = keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (!jwk) throw new AppleAuthError("no matching Apple signing key");

  // RS256 = RSASSA-PKCS1-v1_5 over SHA-256. Node imports the JWK directly.
  const pubKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: "jwk" });
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const ok = crypto.verify("RSA-SHA256", signingInput, pubKey, b64urlToBuffer(sigB64));
  if (!ok) throw new AppleAuthError("bad signature");

  const claims = decodeJson(payloadB64);
  if (claims.iss !== APPLE_ISSUER) throw new AppleAuthError("wrong issuer");

  // `aud` may be a string or array.
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience;
  if (!audOk) throw new AppleAuthError("wrong audience");

  const nowSec = Math.floor(now() / 1000);
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  if (exp + tolerance < nowSec) throw new AppleAuthError("token expired");
  const iat = typeof claims.iat === "number" ? claims.iat : 0;
  if (iat - tolerance > nowSec) throw new AppleAuthError("token not yet valid");

  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) throw new AppleAuthError("missing subject");

  const email = typeof claims.email === "string" ? claims.email : undefined;
  const emailVerified =
    claims.email_verified === true || claims.email_verified === "true" ? true
    : claims.email_verified === false || claims.email_verified === "false" ? false
    : undefined;

  return { sub, email, emailVerified };
}

// ── Apple JWKS fetch (cached) ───────────────────────────────────────────────
let keyCache: { keys: AppleJWK[]; at: number } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000; // Apple rotates infrequently; an hour is safe.

/** Fetch Apple's signing keys, cached for an hour. The default `fetchKeys`. */
export async function fetchAppleKeys(now: () => number = Date.now): Promise<AppleJWK[]> {
  if (keyCache && now() - keyCache.at < KEY_TTL_MS) return keyCache.keys;
  const res = await fetch(APPLE_KEYS_URL);
  if (!res.ok) throw new AppleAuthError(`Apple JWKS fetch failed (${res.status})`);
  const body = (await res.json()) as { keys?: AppleJWK[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (keys.length === 0) throw new AppleAuthError("Apple JWKS empty");
  keyCache = { keys, at: now() };
  return keys;
}

// ── Endpoint configuration (env) ────────────────────────────────────────────

export interface AppleSignInConfig {
  /** Whether the endpoint is live. Off unless `LISA_CLOUD_APPLE_SIGNIN` is truthy. */
  enabled: boolean;
  /** Expected token audience — the app bundle id. */
  audience: string;
  /**
   * Sign in with Apple on the WEB (B8b): the Services ID that Apple's JS flow
   * mints tokens for (`aud` differs from the native bundle id). Unset ⇒ the
   * web button stays hidden and web-audience tokens are rejected.
   */
  webServicesId: string | null;
  /** Optional allowlist of Apple `sub`s; empty = any verified Apple ID may sign in. */
  allowedSubs: string[];
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Read the Sign in with Apple config from the environment. Default-OFF: with
 * `LISA_CLOUD_APPLE_SIGNIN` unset the endpoint reports disabled and never hands
 * back the session token. `LISA_CLOUD_APPLE_AUD` overrides the expected bundle id
 * (default `ai.meetlisa.main`); `LISA_CLOUD_APPLE_SUBS` is a comma-separated
 * allowlist (set it to the reviewer's `sub` to restrict the shared demo).
 */
export function appleSignInConfig(env: NodeJS.ProcessEnv = process.env): AppleSignInConfig {
  return {
    enabled: truthy(env.LISA_CLOUD_APPLE_SIGNIN),
    audience: env.LISA_CLOUD_APPLE_AUD?.trim() || "ai.meetlisa.main",
    webServicesId: env.LISA_CLOUD_APPLE_WEB_SID?.trim() || null,
    allowedSubs: (env.LISA_CLOUD_APPLE_SUBS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Pick the expected `aud` for a sign-in request: web-client tokens carry the
 * Services ID, native ones the bundle id. Returns null when that surface
 * isn't configured (⇒ reject).
 */
export function audienceForClient(cfg: AppleSignInConfig, client: "native" | "web"): string | null {
  return client === "web" ? cfg.webServicesId : cfg.audience;
}

/** True when `sub` is permitted by the (possibly empty) allowlist. */
export function subAllowed(sub: string, cfg: AppleSignInConfig): boolean {
  return cfg.allowedSubs.length === 0 || cfg.allowedSubs.includes(sub);
}
