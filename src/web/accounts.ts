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

export type AccountKind = "apple" | "email";

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
  /** Email ownership verified (B7 wires actual mail); Apple counts as verified. */
  verified: boolean;
  /** Bump to invalidate every outstanding session for this uid. */
  sessionVersion: number;
}

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

export function loadAccounts(): AccountRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(accountsPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is AccountRecord =>
        !!a && typeof (a as AccountRecord).uid === "string" && typeof (a as AccountRecord).sessionVersion === "number",
    );
  } catch {
    return [];
  }
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

function hashPassword(pw: string): ScryptParams {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, SCRYPT.keyLen, SCRYPT);
  return { saltHex: salt.toString("hex"), keyHex: key.toString("hex"), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
}

function passwordMatches(pw: string, p: ScryptParams): boolean {
  let stored: Buffer;
  try {
    stored = Buffer.from(p.keyHex, "hex");
  } catch {
    return false;
  }
  const derived = crypto.scryptSync(pw, Buffer.from(p.saltHex, "hex"), stored.length, {
    N: p.N,
    r: p.r,
    p: p.p,
  });
  return derived.length === stored.length && crypto.timingSafeEqual(derived, stored);
}

/** Stable uid for an Apple `sub` (filesystem-safe: sub is digits/dots/dashes). */
export function appleUid(sub: string): string {
  return `apple-${sub.replace(/[^A-Za-z0-9._-]/g, "_")}`;
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

// ── account operations ──────────────────────────────────────────────────────

export function getAccount(uid: string): AccountRecord | null {
  return loadAccounts().find((a) => a.uid === uid) ?? null;
}

export function getAccountByEmail(email: string): AccountRecord | null {
  const norm = normalizeEmail(email);
  return loadAccounts().find((a) => a.kind === "email" && a.email === norm) ?? null;
}

/** Create an email+password account. Throws AccountError on bad input / dup. */
export function createEmailAccount(
  emailRaw: string,
  password: string,
  now: number = Date.now(),
): AccountRecord {
  const email = normalizeEmail(emailRaw);
  if (!validEmail(email)) throw new AccountError("invalid_email");
  if (!validPassword(password)) throw new AccountError("weak_password");
  const list = loadAccounts();
  if (list.some((a) => a.kind === "email" && a.email === email)) throw new AccountError("email_taken");
  const rec: AccountRecord = {
    uid: `em-${crypto.randomBytes(9).toString("hex")}`,
    kind: "email",
    email,
    scrypt: hashPassword(password),
    createdAt: now,
    lastLoginAt: now,
    verified: false,
    sessionVersion: 0,
  };
  list.push(rec);
  saveAccounts(list);
  return rec;
}

/**
 * Email+password login. Returns the account or null; throws AccountError
 * ("throttled") while the email is locked out. A wrong password on an unknown
 * email burns the same scrypt work as a known one (no user-enumeration timing).
 */
export function verifyEmailLogin(
  emailRaw: string,
  password: string,
  now: number = Date.now(),
): AccountRecord | null {
  const email = normalizeEmail(emailRaw);
  if (loginThrottled(email, now)) throw new AccountError("throttled");
  const acct = getAccountByEmail(email);
  const params: ScryptParams = acct?.scrypt ?? {
    // Decoy: constant-cost verify against a random key for unknown emails.
    saltHex: "00".repeat(16),
    keyHex: "00".repeat(32),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  };
  const ok = passwordMatches(password, params) && !!acct;
  if (!ok) {
    noteLoginFailure(email, now);
    return null;
  }
  clearThrottle(email);
  const list = loadAccounts();
  const live = list.find((a) => a.uid === acct.uid);
  if (live) {
    live.lastLoginAt = now;
    saveAccounts(list);
  }
  return acct;
}

/**
 * Upsert the account record for a verified Apple identity. Called on every
 * successful Sign in with Apple — first sign-in creates the record.
 */
export function upsertAppleAccount(
  sub: string,
  email: string | undefined,
  now: number = Date.now(),
): AccountRecord {
  const uid = appleUid(sub);
  const list = loadAccounts();
  const existing = list.find((a) => a.uid === uid);
  if (existing) {
    existing.lastLoginAt = now;
    if (email && !existing.email) existing.email = normalizeEmail(email);
    saveAccounts(list);
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
  saveAccounts(list);
  return rec;
}

/**
 * Delete an account (App Store 5.1.1(v)). Removes the record — which kills all
 * of its sessions via the sessionVersion check — and returns true if one existed.
 * The caller deletes the per-uid home directory (server-side, B2 layout).
 */
export function deleteAccount(uid: string): boolean {
  const list = loadAccounts();
  const next = list.filter((a) => a.uid !== uid);
  if (next.length === list.length) return false;
  saveAccounts(next);
  return true;
}

/**
 * The gate's session check: does this (uid, sv) pair name a live account?
 * Wrong/stale sv ⇒ revoked (deleted account, future password change).
 */
export function sessionAccountValid(uid: string, sv: number): boolean {
  const acct = getAccount(uid);
  return !!acct && acct.sessionVersion === sv;
}
