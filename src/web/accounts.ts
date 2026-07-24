/**
 * LISA accounts — the cloud edition's user directory
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.1, milestone B1).
 *
 * Three account kinds share one store (`$lisaHome()/accounts.json`, 0600):
 *  - **Apple** (`apple-<sub>`): created/updated on every verified Sign in with
 *    Apple. No password material — Apple is the authority.
 *  - **Email** (`em-<random>`): self-serve, keyed by the address. Password
 *    material is OPTIONAL: accounts born from a mailed one-time code
 *    (src/web/otp.ts) carry no scrypt params at all, and the password path
 *    rejects them constant-time like any other bad credential. App Review's
 *    demo account is the password kind (ASC insists on user/pass).
 *  - **Google** (`g-<sub>`): created on the first verified Google sign-in.
 *
 * **One address, one account.** Email and Google accounts both *claim* their
 * address (`EMAIL_OWNER_KINDS`), so every lookup spans both kinds and a person
 * who signs in by Google today and by mailed code tomorrow lands on the same
 * uid — and therefore the same balance. Apple is excluded on purpose: its
 * private-relay addresses are per-app aliases, not a claim on a real inbox.
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

/**
 * Kinds whose `email` is an ownership claim on that inbox, and so must be
 * unique across the directory. Apple is absent deliberately (see the header).
 */
const EMAIL_OWNER_KINDS: readonly AccountKind[] = ["email", "google"];

function ownsEmail(a: AccountRecord, normalizedEmail: string): boolean {
  return EMAIL_OWNER_KINDS.includes(a.kind) && a.email === normalizedEmail;
}

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
  /**
   * Password material — email accounts that chose one. Absent for code-only
   * (OTP) accounts; `verifyEmailLogin` then fails against the decoy params, so
   * a passwordless account can never be password-authenticated.
   */
  scrypt?: ScryptParams;
  createdAt: number;
  lastLoginAt: number;
  /** Email ownership verified (B8a wires the mail); Apple counts as verified. */
  verified: boolean;
  /** Bump to invalidate every outstanding session for this uid. */
  sessionVersion: number;
  /** Google's stable account id — set on any account a Google sign-in owns. */
  googleSub?: string;
  /** SHA-256 of the outstanding verification token (email kind, unverified). */
  verifyTokenHash?: string;
  /** Verification-token expiry, ms epoch. */
  verifyExpiresAt?: number;
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

/** The account that owns this address, of whichever email-owning kind. */
export async function getAccountByEmail(email: string): Promise<AccountRecord | null> {
  const norm = normalizeEmail(email);
  return (await loadAccounts()).find((a) => ownsEmail(a, norm)) ?? null;
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
    // Spans Google too: the address is already spoken for, and a second record
    // would split the person's balance across two uids.
    if (list.some((a) => ownsEmail(a, email))) throw new AccountError("email_taken");
    list.push(rec);
    return rec;
  });
}

/**
 * Apply proof-of-ownership (a mailed OTP or a verified OIDC email) to an account.
 * The FIRST time an account becomes verified this way, anything set on it before
 * is untrusted — `/api/auth/register` is open and unauthenticated, so an attacker
 * can pre-create any address with a password of their choosing. So on the
 * unverified→verified transition we drop any pre-set password and rotate
 * `sessionVersion` (invalidating any session minted from that credential),
 * closing the account pre-hijacking path. A password the real owner sets AFTER
 * verifying is unaffected. Returns whether this was the first verification.
 */
function markVerifiedByOwnershipProof(acct: AccountRecord): boolean {
  const firstVerification = !acct.verified;
  acct.verified = true;
  delete acct.verifyTokenHash;
  delete acct.verifyExpiresAt;
  if (firstVerification && acct.scrypt) {
    delete acct.scrypt;
    acct.sessionVersion += 1;
  }
  return firstVerification;
}

/**
 * Sign-in by mailed code (A1). The code already proved this person reads the
 * address, so one call both registers and authenticates: an existing account
 * comes back marked verified (ownership was just demonstrated, which levels the
 * free window $1 → $5), a new one is created with no password material.
 *
 * The lookup and the insert share a single mutation, so two codes redeemed at
 * once can't create the address twice under Firestore CAS.
 *
 * Password lockouts are deliberately NOT cleared here: they guard the password
 * credential only, and leaving them in place means someone else's failed
 * guessing can never be undone by the victim signing in normally.
 */
export async function ensureOtpAccount(
  emailRaw: string,
  now: number = Date.now(),
): Promise<{ acct: AccountRecord; created: boolean }> {
  const email = normalizeEmail(emailRaw);
  if (!validEmail(email)) throw new AccountError("invalid_email");
  const uid = `em-${crypto.randomBytes(9).toString("hex")}`;
  return mutateAccounts((list) => {
    // A Google-owned address counts: proving the inbox signs you into that same
    // account rather than forking a second one.
    const existing = list.find((a) => ownsEmail(a, email));
    if (existing) {
      existing.lastLoginAt = now;
      // OTP proves inbox control → apply ownership proof. This drops any password
      // set before verification (an attacker can pre-register any address via the
      // open /api/auth/register) and rotates sessionVersion, closing the account
      // pre-hijacking path where the attacker's password survived the adoption.
      markVerifiedByOwnershipProof(existing);
      return { acct: existing, created: false };
    }
    const rec: AccountRecord = {
      uid,
      kind: "email",
      email,
      createdAt: now,
      lastLoginAt: now,
      verified: true,
      sessionVersion: 0,
    };
    list.push(rec);
    return { acct: rec, created: true };
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

/** Stable uid for a Google `sub` (filesystem-safe; Google subs are digits). */
export function googleUid(sub: string): string {
  return `g-${sub.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/**
 * Upsert the account for a verified Google identity (A3). Resolution order:
 *
 *  1. **by `sub`** — the identity anchor, so a Google user who changes the
 *     address on their Google account keeps their LISA account and balance;
 *  2. **by address** — binds to the email account already using it, which is
 *     the whole point of the one-address-one-account rule. Safe because the
 *     caller only reaches here with `email_verified` from Google;
 *  3. otherwise create `g-<sub>`.
 *
 * Binding marks the account verified: Google vouched for the inbox.
 */
export async function upsertGoogleAccount(
  sub: string,
  emailRaw: string,
  now: number = Date.now(),
): Promise<AccountRecord> {
  const email = normalizeEmail(emailRaw);
  if (!validEmail(email)) throw new AccountError("invalid_email");
  const uid = googleUid(sub);
  return mutateAccounts((list) => {
    const bySub = list.find((a) => a.googleSub === sub);
    if (bySub) {
      bySub.lastLoginAt = now;
      bySub.email = email;
      return bySub;
    }
    const byEmail = list.find((a) => ownsEmail(a, email));
    if (byEmail) {
      byEmail.googleSub = sub;
      byEmail.lastLoginAt = now;
      byEmail.verified = true;
      delete byEmail.verifyTokenHash;
      delete byEmail.verifyExpiresAt;
      return byEmail;
    }
    const rec: AccountRecord = {
      uid,
      kind: "google",
      email,
      googleSub: sub,
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
