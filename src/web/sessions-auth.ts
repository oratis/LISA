/**
 * LISA account sessions — compact HMAC-signed bearer tokens for the cloud
 * edition (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.1, milestone B1).
 *
 * After a sign-in (Sign in with Apple, or email+password from accounts.ts) the
 * server mints `s1.<payload>.<mac>` where payload is base64url JSON
 * `{uid, iat, exp, sv}`. Every later request presents it through the existing
 * Bearer/cookie/query token channels — no client protocol change. Verification
 * is pure (secret + clock injected) so it unit-tests offline.
 *
 * `sv` is the account's session version: bumping it (or deleting the account)
 * invalidates every outstanding session for that uid without any server-side
 * session store. Stateless by design — the single secret lives next to the
 * other credentials in `$LISA_HOME` (0600), auto-created on first use so the
 * cloud container needs no extra env to turn accounts on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface SessionClaims {
  uid: string;
  /** Issued-at, ms since epoch. */
  iat: number;
  /** Expiry, ms since epoch. */
  exp: number;
  /** Account session version — must match the account record at verify time. */
  sv: number;
}

/** 30 days — long enough that a phone rarely re-logs, short enough to expire leaks. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PREFIX = "s1";

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}

function secretPath(): string {
  return path.join(lisaHome(), "session-secret");
}

/**
 * Load the session-signing secret, creating (and persisting, 0600) a random one
 * on first use. On the cloud image `$LISA_HOME` is the durable /data mount, so
 * sessions survive restarts; losing the file merely signs everyone out.
 */
export function loadOrCreateSessionSecret(): string {
  const file = secretPath();
  try {
    const s = fs.readFileSync(file, "utf8").trim();
    if (s) return s;
  } catch {
    /* fall through to create */
  }
  const fresh = crypto.randomBytes(48).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, fresh + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort — non-POSIX filesystems may reject chmod
  }
  return fresh;
}

function mac(data: string, secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

/** Mint a session token for `uid`. Pure given (secret, now). */
export function mintSession(
  uid: string,
  secret: string,
  opts: { now?: number; ttlMs?: number; sv?: number } = {},
): string {
  const iat = opts.now ?? Date.now();
  const claims: SessionClaims = {
    uid,
    iat,
    exp: iat + (opts.ttlMs ?? SESSION_TTL_MS),
    sv: opts.sv ?? 0,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const sig = mac(`${PREFIX}.${payload}`, secret).toString("base64url");
  return `${PREFIX}.${payload}.${sig}`;
}

/** True when `token` even looks like one of our session tokens (cheap pre-check). */
export function looksLikeSession(token: string): boolean {
  return token.startsWith(`${PREFIX}.`);
}

/**
 * Verify a session token: signature (constant-time), shape, expiry. Returns the
 * claims or null — the caller still has to check `sv` against the account record
 * (accounts.ts) so deleted accounts lose access immediately.
 */
export function verifySession(
  token: string,
  secret: string,
  now: number = Date.now(),
): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const payload = parts[1] as string;
  const sig = parts[2] as string;
  const expected = mac(`${PREFIX}.${payload}`, secret);
  let presented: Buffer;
  try {
    presented = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
    return null;
  }
  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return null;
  }
  if (typeof claims.uid !== "string" || !claims.uid) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.sv !== "number") return null;
  return claims;
}

/** Renew when more than half the lifetime is gone (sliding sessions via cookie). */
export function shouldRenew(claims: SessionClaims, now: number = Date.now()): boolean {
  return now > claims.iat + (claims.exp - claims.iat) / 2;
}
