/**
 * LISA accounts — the cloud edition's user directory
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.1, milestone B1).
 *
 * Two account kinds share one store (`$lisaHome()/accounts.json`, 0600):
 *  - **Apple** (`apple-<sub>`): created/updated on every verified Sign in with
 *    Apple. No password material — Apple is the authority.
 *  - **Email** (`em-<random>`): self-serve email+password, scrypt-hashed. This
 *    is what App Review's demo account uses (ASC insists on user/pass), and the
 *    path for desktop/web users without an Apple ID.
 *
 * Every account carries a `sessionVersion`; session tokens embed it and the
 *  gate rejects a mismatch — so deleting an account (App Store 5.1.1(v)) or a
 * future password change invalidates all outstanding sessions statelessly.
 *
 * Login throttling is in-memory (per normalized email, 5 fails → 15 min lock):
 * the cloud runs a single instance (min=max=1), so process-local is correct
 * until the Firestore move (B2), which takes this table with it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { firestoreEnabled, getDoc, casUpdate } from "../cloud/firestore.js";

export type AccountKind = "apple" | "email" | "google";

export interface ScryptParams {
  saltHex: string;
  keyHex: string;
  N: number;
  r: number;
  p: number;
}

export interface AccountRecord {
  uid: string;
  kind: AccountKind;
  /** Normalized (trimmed, lowercased). Optional for Apple (user may hide it). */
  email?: string;
  /** Password material — email accounts only. */
  scrypt?: ScryptParams;
  createdAt: number;
  lastLoginAt: number;
  /** Email ownership verified (B8a wires the mail); Apple counts as verified. */
  verified: boolean;
  /** Bump to invalidate every outstanding session for this uid. */
  sessionVersion: number;
  /** SHA-256 of the outstanding verification token (email kind, unverified). */
  verifyTokenHash?: string;
  /** Verification-token expiry, ms epoch. */
  verifyExpiresAt?: number;
  /**
   * Google `sub` linked to this account (S1). Set on a pure Google account AND
   * on an email/apple account a verified-email Google sign-in merged into — so
   * the user keeps one uid (one Lisa) across providers.
   */
  googleSub?: string;
  /** SHA-256 hex of the outstanding one-time code (S2). One OTP at a time. */
  otpHash?: string;
  /** What the outstanding code is FOR — a login code never resets a password. */
  otpPurpose?: OtpPurpose;
  /** Code expiry, ms epoch (10 minutes from mint). */
  otpExpiresAt?: number;
  /** Wrong guesses so far; the code burns itself after OTP_MAX_ATTEMPTS. */
  otpAttempts?: number;
}

/**
 * One-time-code purposes (S2). One infra, three uses:
 *  - "verify": prove email ownership after signup (levels the free window)
 *  - "login":  passwordless sign-in for email accounts
 *  - "reset":  forgot-password — proves ownership, then sets a new password
 */
export type OtpPurpose = "verify" | "login" | "reset";

export class AccountError extends Error {
  constructor(public code: "invalid_email" | "weak_password" | "email_taken" | "throttled") {
    super(code);
    this.name = "AccountError";
  }
}

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 } as const;

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}
function accountsPath(): string {
  return path.join(lisaHome(), "accounts.json");
}

function validRecords(parsed: unknown): AccountRecord[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (a): a is AccountRecord =>
      !!a && typeof (a as AccountRecord).uid === "string" && typeof (a as AccountRecord).sessionVersion === "number",
  );
}

function loadAccountsFile(): AccountRecord[] {
  try {
    return validRecords(JSON.parse(fs.readFileSync(accountsPath(), "utf8")));
  } catch {
    return [];
  }
}

// ── storage seam (B9): file under min=max=1, Firestore for multi-instance ───
// Firestore keeps the WHOLE directory in one doc (lisa-global/accounts) and
// every mutation is a CAS — trivially atomic and unique-email-safe. A record
// is ~300 bytes, so the 1 MB doc limit covers thousands of accounts; shard to
// per-uid docs if that ever gets tight.
const ACCOUNTS_DOC = "lisa-global/accounts";

/** Read the account list from the active backend. */
export async function loadAccounts(): Promise<AccountRecord[]> {
  if (firestoreEnabled()) {
    const doc = await getDoc(ACCOUNTS_DOC);
    return validRecords((doc?.data.list as unknown) ?? []);
  }
  return loadAccountsFile();
}

/** Read-modify-write the list atomically; `fn` mutates in place. */
async function mutateAccounts<T>(fn: (list: AccountRecord[]) => T): Promise<T> {
  if (firestoreEnabled()) {
    return casUpdate(ACCOUNTS_DOC, (current) => {
      const list = validRecords((current?.list as unknown) ?? []);
      const result = fn(list);
      return { next: { list: list as unknown as Record<string, unknown>[] }, result };
    });
  }
  const list = loadAccountsFile();
  const result = fn(list);
  saveAccounts(list);
  return result;
}

function saveAccounts(list: AccountRecord[]): void {
  const file = accountsPath();
  // Password hashes are credentials — private store, same posture as devices.json.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Deliberately loose — real ownership proof is the (B7) verification mail. */
export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export function validPassword(pw: string): boolean {
  return pw.length >= 8 && pw.length <= 256;
}

/**
 * Async scrypt (#260). `scryptSync` ran the whole KDF on the event loop, so a
 * handful of concurrent unauthenticated /register or /login calls stalled every
 * other request — a cheap DoS. The callback form runs on the libuv threadpool.
 */
function scryptAsync(pw: string, salt: Buffer, keyLen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(pw: string): Promise<ScryptParams> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw, salt, SCRYPT.keyLen, SCRYPT);
  return { saltHex: salt.toString("hex"), keyHex: key.toString("hex"), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
}

async function passwordMatches(pw: string, p: ScryptParams): Promise<boolean> {
  let stored: Buffer;
  try {
    stored = Buffer.from(p.keyHex, "hex");
  } catch {
    return false;
  }
  let derived: Buffer;
  try {
    derived = await scryptAsync(pw, Buffer.from(p.saltHex, "hex"), stored.length, {
      N: p.N,
      r: p.r,
      p: p.p,
    });
  } catch {
    return false; // corrupt stored params (bad N/r/p) — not a match
  }
  return derived.length === stored.length && crypto.timingSafeEqual(derived, stored);
}

/** Stable uid for an Apple `sub` (filesystem-safe: sub is digits/dots/dashes). */
export function appleUid(sub: string): string {
  return `apple-${sub.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** Stable uid for a Google `sub` (a decimal string; sanitized the same way). */
export function googleUid(sub: string): string {
  return `google-${sub.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

// ── login throttle (in-memory; single-instance cloud) ───────────────────────
interface Throttle {
  fails: number;
  lockedUntil: number;
}
const throttles = new Map<string, Throttle>();
const THROTTLE_MAX_FAILS = 5;
const THROTTLE_LOCK_MS = 15 * 60 * 1000;

export function loginThrottled(email: string, now: number = Date.now()): boolean {
  const t = throttles.get(normalizeEmail(email));
  return !!t && t.lockedUntil > now;
}

function noteLoginFailure(email: string, now: number): void {
  const key = normalizeEmail(email);
  const t = throttles.get(key) ?? { fails: 0, lockedUntil: 0 };
  t.fails += 1;
  if (t.fails >= THROTTLE_MAX_FAILS) {
    t.lockedUntil = now + THROTTLE_LOCK_MS;
    t.fails = 0;
  }
  throttles.set(key, t);
}

function clearThrottle(email: string): void {
  throttles.delete(normalizeEmail(email));
}

/** Test seam. */
export function resetLoginThrottles(): void {
  throttles.clear();
}

// ── account operations (async: file or Firestore behind the seam) ──────────

export async function getAccount(uid: string): Promise<AccountRecord | null> {
  return (await loadAccounts()).find((a) => a.uid === uid) ?? null;
}

export async function getAccountByEmail(email: string): Promise<AccountRecord | null> {
  const norm = normalizeEmail(email);
  return (await loadAccounts()).find((a) => a.kind === "email" && a.email === norm) ?? null;
}

/**
 * Create an email+password account. Throws AccountError on bad input / dup.
 * The duplicate check runs INSIDE the mutation, so under Firestore CAS a
 * concurrent double-register of the same email loses cleanly.
 */
export async function createEmailAccount(
  emailRaw: string,
  password: string,
  now: number = Date.now(),
): Promise<AccountRecord> {
  const email = normalizeEmail(emailRaw);
  if (!validEmail(email)) throw new AccountError("invalid_email");
  if (!validPassword(password)) throw new AccountError("weak_password");
  const scrypt = await hashPassword(password); // CPU work outside the CAS loop
  const rec: AccountRecord = {
    uid: `em-${crypto.randomBytes(9).toString("hex")}`,
    kind: "email",
    email,
    scrypt,
    createdAt: now,
    lastLoginAt: now,
    verified: false,
    sessionVersion: 0,
  };
  return mutateAccounts((list) => {
    if (list.some((a) => a.kind === "email" && a.email === email)) throw new AccountError("email_taken");
    list.push(rec);
    return rec;
  });
}

/**
 * Email+password login. Returns the account or null; throws AccountError
 * ("throttled") while the email is locked out. A wrong password on an unknown
 * email burns the same scrypt work as a known one (no user-enumeration timing).
 */
export async function verifyEmailLogin(
  emailRaw: string,
  password: string,
  now: number = Date.now(),
): Promise<AccountRecord | null> {
  const email = normalizeEmail(emailRaw);
  if (loginThrottled(email, now)) throw new AccountError("throttled");
  const acct = await getAccountByEmail(email);
  const params: ScryptParams = acct?.scrypt ?? {
    // Decoy: constant-cost verify against a random key for unknown emails.
    saltHex: "00".repeat(16),
    keyHex: "00".repeat(32),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  };
  const ok = (await passwordMatches(password, params)) && !!acct;
  if (!ok) {
    noteLoginFailure(email, now);
    return null;
  }
  clearThrottle(email);
  await mutateAccounts((list) => {
    const live = list.find((a) => a.uid === acct.uid);
    if (live) live.lastLoginAt = now;
  });
  return acct;
}

/**
 * Upsert the account record for a verified Apple identity. Called on every
 * successful Sign in with Apple — first sign-in creates the record.
 */
export async function upsertAppleAccount(
  sub: string,
  email: string | undefined,
  now: number = Date.now(),
): Promise<AccountRecord> {
  const uid = appleUid(sub);
  return mutateAccounts((list) => {
    const existing = list.find((a) => a.uid === uid);
    if (existing) {
      existing.lastLoginAt = now;
      if (email && !existing.email) existing.email = normalizeEmail(email);
      return existing;
    }
    const rec: AccountRecord = {
      uid,
      kind: "apple",
      email: email ? normalizeEmail(email) : undefined,
      createdAt: now,
      lastLoginAt: now,
      verified: true,
      sessionVersion: 0,
    };
    list.push(rec);
    return rec;
  });
}

/**
 * Upsert the account record for a verified Google identity (S1). Called on
 * every successful Sign in with Google.
 *
 * Merge policy (PLAN_WEB_SIGNUP §3 / D2 verdict): if Google asserts the email
 * is verified AND an existing **verified** account carries the same normalized
 * email, the Google identity is linked onto that account (`googleSub`) instead
 * of minting a new uid — same person, same Lisa. Both sides being verified is
 * what closes the account-takeover door: an unverified email squatter never
 * inherits a Google identity, and Google's `email_verified` is its ownership
 * proof. Otherwise a fresh `google-<sub>` account is created.
 */
export async function upsertGoogleAccount(
  sub: string,
  email: string | undefined,
  emailVerified: boolean | undefined,
  now: number = Date.now(),
): Promise<AccountRecord> {
  const uid = googleUid(sub);
  const norm = email ? normalizeEmail(email) : undefined;
  return mutateAccounts((list) => {
    // Returning user: linked via a previous merge, or a pure Google account.
    const existing = list.find((a) => a.googleSub === sub || a.uid === uid);
    if (existing) {
      existing.lastLoginAt = now;
      if (norm && !existing.email) existing.email = norm;
      return existing;
    }
    // First Google sign-in: merge into a verified same-email account if any.
    if (norm && emailVerified) {
      const match = list.find((a) => a.email === norm && a.verified);
      if (match) {
        match.googleSub = sub;
        match.lastLoginAt = now;
        return match;
      }
    }
    const rec: AccountRecord = {
      uid,
      kind: "google",
      email: norm,
      googleSub: sub,
      createdAt: now,
      lastLoginAt: now,
      // Google accounts count as verified only when Google says the email is
      // (in practice always true for Google-account emails).
      verified: emailVerified !== false,
      sessionVersion: 0,
    };
    list.push(rec);
    return rec;
  });
}

/**
 * Delete an account (App Store 5.1.1(v)). Removes the record — which kills all
 * of its sessions via the sessionVersion check — and returns true if one existed.
 * The caller deletes the per-uid home directory (server-side, B2 layout).
 */
export async function deleteAccount(uid: string): Promise<boolean> {
  return mutateAccounts((list) => {
    const idx = list.findIndex((a) => a.uid === uid);
    if (idx < 0) return false;
    list.splice(idx, 1);
    return true;
  });
}

/**
 * The gate's session check: does this (uid, sv) pair name a live account?
 * Wrong/stale sv ⇒ revoked (deleted account, future password change).
 */
export async function sessionAccountValid(uid: string, sv: number): Promise<boolean> {
  const acct = await getAccount(uid);
  return !!acct && acct.sessionVersion === sv;
}

/**
 * Operator-seeded account (B7): the App Review demo (ASC "Sign-in required"
 * wants user/pass). Creates the email account if missing and forces
 * verified=true (full free window). Idempotent; never rotates an existing
 * password. Returns the record.
 */
export async function ensureSeededAccount(email: string, password: string, now: number = Date.now()): Promise<AccountRecord> {
  const existing = (await getAccountByEmail(email)) ?? (await createEmailAccount(email, password, now));
  return mutateAccounts((list) => {
    const live = list.find((a) => a.uid === existing.uid);
    if (live && !live.verified) live.verified = true;
    return live ?? existing;
  });
}

// ── one-time codes (S2): verify / passwordless login / password reset ───────
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

// Send-cooldown is keyed by (purpose, email) and applied BEFORE the account
// lookup, uniformly for unknown emails too — so the 200-vs-429 pattern never
// leaks whether an address has an account. In-memory is correct for the
// single-instance cloud (same stance as the login throttle above).
const otpCooldowns = new Map<string, number>();

/** Test seam. */
export function resetOtpCooldowns(): void {
  otpCooldowns.clear();
}

function clearOtp(acct: AccountRecord): void {
  delete acct.otpHash;
  delete acct.otpPurpose;
  delete acct.otpExpiresAt;
  delete acct.otpAttempts;
}

/**
 * Try to consume the record's outstanding code (mutates in place; call inside
 * mutateAccounts). Every try counts an attempt; the code burns itself past
 * OTP_MAX_ATTEMPTS — a 6-digit space is only safe because guessing is capped.
 */
function takeOtp(acct: AccountRecord, code: string, purpose: OtpPurpose, now: number): boolean {
  if (!acct.otpHash || acct.otpPurpose !== purpose) return false;
  if (!acct.otpExpiresAt || acct.otpExpiresAt < now) return false;
  const attempts = (acct.otpAttempts ?? 0) + 1;
  acct.otpAttempts = attempts;
  if (attempts > OTP_MAX_ATTEMPTS) {
    clearOtp(acct);
    return false;
  }
  const presented = crypto.createHash("sha256").update(code).digest();
  let stored: Buffer;
  try {
    stored = Buffer.from(acct.otpHash, "hex");
  } catch {
    return false;
  }
  if (stored.length !== presented.length || !crypto.timingSafeEqual(stored, presented)) return false;
  clearOtp(acct);
  return true;
}

export type OtpBegin =
  | { status: "ok"; code: string; uid: string }
  | { status: "cooldown"; retryAfterSec: number }
  | { status: "none" };

/**
 * Mint a 6-digit code for (email, purpose). Returns the RAW code once — it
 * goes into the mail — with only its hash persisted. "none" means no eligible
 * account; callers still answer 200 so the endpoint can't be used to probe
 * which emails exist.
 */
export async function beginAccountOtp(
  emailRaw: string,
  purpose: OtpPurpose,
  now: number = Date.now(),
): Promise<OtpBegin> {
  const email = normalizeEmail(emailRaw);
  const key = `${purpose}:${email}`;
  const until = otpCooldowns.get(key) ?? 0;
  if (until > now) return { status: "cooldown", retryAfterSec: Math.ceil((until - now) / 1000) };
  otpCooldowns.set(key, now + OTP_RESEND_COOLDOWN_MS);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  return mutateAccounts((list) => {
    const acct = list.find((a) => a.kind === "email" && a.email === email);
    if (!acct) return { status: "none" } as const;
    if (purpose === "verify" && acct.verified) return { status: "none" } as const;
    acct.otpHash = hash;
    acct.otpPurpose = purpose;
    acct.otpExpiresAt = now + OTP_TTL_MS;
    acct.otpAttempts = 0;
    return { status: "ok", code, uid: acct.uid } as const;
  });
}

/**
 * Consume a code. Returns the account on success, null on any failure (wrong/
 * expired/burned code, unknown email). "verify" marks the account verified;
 * "login" stamps lastLoginAt — the caller mints the session.
 */
export async function consumeAccountOtp(
  emailRaw: string,
  code: string,
  purpose: OtpPurpose,
  now: number = Date.now(),
): Promise<AccountRecord | null> {
  const email = normalizeEmail(emailRaw);
  if (!code || !/^\d{6}$/.test(code)) return null;
  return mutateAccounts((list) => {
    const acct = list.find((a) => a.kind === "email" && a.email === email);
    if (!acct || !takeOtp(acct, code, purpose, now)) return null;
    if (purpose === "verify") {
      acct.verified = true;
      delete acct.verifyTokenHash;
      delete acct.verifyExpiresAt;
    }
    if (purpose === "login") acct.lastLoginAt = now;
    return acct;
  });
}

/**
 * Forgot-password (S2): consume a "reset" code and install the new password in
 * one atomic mutation. Bumps sessionVersion (every outstanding session dies),
 * marks the account verified (the code just proved email ownership), and
 * clears the login throttle so a locked-out owner can get back in.
 */
export async function resetPasswordWithOtp(
  emailRaw: string,
  code: string,
  newPassword: string,
  now: number = Date.now(),
): Promise<AccountRecord | null> {
  if (!validPassword(newPassword)) throw new AccountError("weak_password");
  const email = normalizeEmail(emailRaw);
  if (!code || !/^\d{6}$/.test(code)) return null;
  const scrypt = await hashPassword(newPassword); // CPU work outside the CAS loop
  const acct = await mutateAccounts((list) => {
    const live = list.find((a) => a.kind === "email" && a.email === email);
    if (!live || !takeOtp(live, code, "reset", now)) return null;
    live.scrypt = scrypt;
    live.sessionVersion += 1;
    live.verified = true;
    delete live.verifyTokenHash;
    delete live.verifyExpiresAt;
    live.lastLoginAt = now;
    return live;
  });
  if (acct) clearThrottle(email);
  return acct;
}

// ── email-ownership verification (B8a) ──────────────────────────────────────
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Mint (and store the hash of) a fresh verification token for an unverified
 * email account. Returns the RAW token once — it goes into the mailed link —
 * or null when the uid isn't an unverified email account.
 */
export async function beginEmailVerification(uid: string, now: number = Date.now()): Promise<string | null> {
  const token = crypto.randomBytes(24).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  return mutateAccounts((list) => {
    const acct = list.find((a) => a.uid === uid);
    if (!acct || acct.kind !== "email" || acct.verified) return null;
    acct.verifyTokenHash = hash;
    acct.verifyExpiresAt = now + VERIFY_TTL_MS;
    return token;
  });
}

/**
 * Confirm a verification link. Constant-time hash compare; expiry enforced.
 * On success the account is marked verified (free window levels $1 → $5) and
 * the token is cleared. Returns the account or null.
 */
export async function confirmEmailVerification(rawToken: string, now: number = Date.now()): Promise<AccountRecord | null> {
  if (!rawToken) return null;
  const presented = crypto.createHash("sha256").update(rawToken).digest();
  return mutateAccounts((list) => {
    for (const acct of list) {
      if (!acct.verifyTokenHash || acct.verified) continue;
      let stored: Buffer;
      try {
        stored = Buffer.from(acct.verifyTokenHash, "hex");
      } catch {
        continue;
      }
      if (stored.length !== presented.length || !crypto.timingSafeEqual(stored, presented)) continue;
      if (!acct.verifyExpiresAt || acct.verifyExpiresAt < now) return null; // matched but stale
      acct.verified = true;
      delete acct.verifyTokenHash;
      delete acct.verifyExpiresAt;
      return acct;
    }
    return null;
  });
}
