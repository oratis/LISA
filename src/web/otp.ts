/**
 * Email one-time codes — passwordless sign-in for LISA accounts
 * (docs/PLAN_AUTH_OTP_GOOGLE_v1.0.md §2.1, milestone A1).
 *
 * A 6-digit code mailed to an address proves the person reading that inbox
 * asked to sign in. That single proof does three jobs at once: it authenticates
 * an existing account, it registers a new one (no password to choose), and it
 * marks the address verified — which is what levels the free window from $1 to
 * $5 (src/billing/quota.ts). The password path stays untouched beside it: App
 * Review's demo account needs user/pass, and existing accounts keep working.
 *
 * The store lives beside the account directory (`$LISA_HOME/otp.json`, 0600, or
 * `lisa-global/otps` under Firestore) and holds ONE record per email address,
 * split into two independent halves:
 *
 *  - the **challenge** (code hash, expiry, wrong-guess count) — cleared the
 *    moment it is spent or burned;
 *  - the **send budget** (last send, sends today) — deliberately survives a
 *    successful verify, so spending a code can't reset the mail-bombing cap.
 *
 * Codes are never stored: we keep SHA-256 of `email:code`, salted by the address
 * so the same digits for two people hash differently, and compare in constant
 * time. A code dies at the first of: expiry, five wrong guesses, or being spent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { firestoreEnabled, getDoc, casUpdate } from "../cloud/firestore.js";
import { normalizeEmail } from "./accounts.js";

/** Digits in a mailed code. Six is the usual phone-friendly length. */
export const OTP_CODE_LENGTH = 6;
/** How long a code stays usable. */
export const OTP_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses before the code is burned (an attacker gets 5-in-a-million). */
export const OTP_MAX_ATTEMPTS = 5;
/** Minimum gap between two sends to one address. */
export const OTP_COOLDOWN_MS = 60 * 1000;
/** Sends per address per UTC day — the mail-bombing cap. */
export const OTP_DAILY_MAX_SENDS = 10;

export interface OtpRecord {
  /** Normalized email — also the record key. */
  email: string;
  /** SHA-256 of `email:code`. Absent when no challenge is outstanding. */
  codeHash?: string;
  expiresAt?: number;
  attempts?: number;
  /** Send budget (survives a spent code). */
  lastSentAt: number;
  sentToday: number;
  /** UTC day the `sentToday` counter belongs to, "YYYY-MM-DD". */
  day: string;
}

export type OtpRequestResult =
  | { ok: true; code: string; expiresInSec: number }
  | { ok: false; reason: "cooldown" | "daily_cap"; retryAfterSec: number };

export type OtpVerifyReason = "no_pending" | "expired" | "bad_code" | "too_many_attempts";
export type OtpVerifyResult = { ok: true } | { ok: false; reason: OtpVerifyReason };

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}
function otpPath(): string {
  return path.join(lisaHome(), "otp.json");
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Uniform 6-digit code — `randomInt` avoids the modulo bias of `randomBytes % n`. */
function generateCode(): string {
  return String(crypto.randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, "0");
}

/** Address-salted digest: the same digits for two people never collide. */
function codeDigest(email: string, code: string): string {
  return crypto.createHash("sha256").update(`${email}:${code}`).digest("hex");
}

function validRecords(parsed: unknown): OtpRecord[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (r): r is OtpRecord => !!r && typeof (r as OtpRecord).email === "string" && typeof (r as OtpRecord).day === "string",
  );
}

function loadFile(): OtpRecord[] {
  try {
    return validRecords(JSON.parse(fs.readFileSync(otpPath(), "utf8")));
  } catch {
    return [];
  }
}

function saveFile(list: OtpRecord[]): void {
  const file = otpPath();
  // Code hashes are credentials — same 0600 posture as accounts.json.
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

// ── storage seam (mirrors accounts.ts): file under min=max=1, Firestore for
// multi-instance. One doc holds the whole table; every mutation is a CAS.
const OTP_DOC = "lisa-global/otps";

async function loadRecords(): Promise<OtpRecord[]> {
  if (firestoreEnabled()) {
    const doc = await getDoc(OTP_DOC);
    return validRecords((doc?.data.list as unknown) ?? []);
  }
  return loadFile();
}

/**
 * Drop records that can no longer do anything: no live challenge AND a send
 * budget from an earlier day. Keeps the table from growing with every address
 * that ever asked for a code.
 */
function prune(list: OtpRecord[], now: number): OtpRecord[] {
  const today = utcDay(now);
  return list.filter((r) => {
    const liveChallenge = !!r.codeHash && (r.expiresAt ?? 0) > now;
    const liveBudget = r.day === today;
    return liveChallenge || liveBudget;
  });
}

async function mutate<T>(fn: (list: OtpRecord[]) => T, now: number): Promise<T> {
  if (firestoreEnabled()) {
    return casUpdate(OTP_DOC, (current) => {
      const list = prune(validRecords((current?.list as unknown) ?? []), now);
      const result = fn(list);
      return { next: { list: list as unknown as Record<string, unknown>[] }, result };
    });
  }
  const list = prune(loadFile(), now);
  const result = fn(list);
  saveFile(list);
  return result;
}

function findOrCreate(list: OtpRecord[], email: string, now: number): OtpRecord {
  const existing = list.find((r) => r.email === email);
  if (existing) return existing;
  const rec: OtpRecord = { email, lastSentAt: 0, sentToday: 0, day: utcDay(now) };
  list.push(rec);
  return rec;
}

/**
 * Mint a code for `email`, or refuse when the address is over its send budget.
 * Returns the RAW code exactly once — it goes straight into the mail and is
 * never recoverable afterwards. Any outstanding challenge is replaced, so the
 * newest code is always the only valid one.
 */
export async function requestEmailOtp(emailRaw: string, now: number = Date.now()): Promise<OtpRequestResult> {
  const email = normalizeEmail(emailRaw);
  const code = generateCode();
  const hash = codeDigest(email, code);
  return mutate((list) => {
    const rec = findOrCreate(list, email, now);
    if (rec.day !== utcDay(now)) {
      rec.day = utcDay(now);
      rec.sentToday = 0;
    }
    const sinceLast = now - rec.lastSentAt;
    if (sinceLast < OTP_COOLDOWN_MS) {
      return {
        ok: false as const,
        reason: "cooldown" as const,
        retryAfterSec: Math.ceil((OTP_COOLDOWN_MS - sinceLast) / 1000),
      };
    }
    if (rec.sentToday >= OTP_DAILY_MAX_SENDS) {
      // Until the UTC day rolls over.
      const midnight = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate() + 1,
      );
      return { ok: false as const, reason: "daily_cap" as const, retryAfterSec: Math.ceil((midnight - now) / 1000) };
    }
    rec.codeHash = hash;
    rec.expiresAt = now + OTP_TTL_MS;
    rec.attempts = 0;
    rec.lastSentAt = now;
    rec.sentToday += 1;
    return { ok: true as const, code, expiresInSec: Math.floor(OTP_TTL_MS / 1000) };
  }, now);
}

/**
 * Spend a code. Success clears the challenge (a code is single-use) but keeps
 * the send budget. A wrong guess counts against `OTP_MAX_ATTEMPTS`; the fifth
 * burns the challenge outright, so brute force costs a fresh mail each time.
 */
export async function verifyEmailOtp(
  emailRaw: string,
  codeRaw: string,
  now: number = Date.now(),
): Promise<OtpVerifyResult> {
  const email = normalizeEmail(emailRaw);
  const code = codeRaw.trim();
  const presented = Buffer.from(codeDigest(email, code), "utf8");
  return mutate((list) => {
    const rec = list.find((r) => r.email === email);
    if (!rec?.codeHash) return { ok: false as const, reason: "no_pending" as const };
    if ((rec.expiresAt ?? 0) <= now) {
      clearChallenge(rec);
      return { ok: false as const, reason: "expired" as const };
    }
    const stored = Buffer.from(rec.codeHash, "utf8");
    const match = stored.length === presented.length && crypto.timingSafeEqual(stored, presented);
    if (!match) {
      rec.attempts = (rec.attempts ?? 0) + 1;
      if (rec.attempts >= OTP_MAX_ATTEMPTS) {
        clearChallenge(rec);
        return { ok: false as const, reason: "too_many_attempts" as const };
      }
      return { ok: false as const, reason: "bad_code" as const };
    }
    clearChallenge(rec);
    return { ok: true as const };
  }, now);
}

function clearChallenge(rec: OtpRecord): void {
  delete rec.codeHash;
  delete rec.expiresAt;
  delete rec.attempts;
}

/** Test/diagnostic seam: the live record for an address (challenge included). */
export async function peekOtpRecord(emailRaw: string): Promise<OtpRecord | null> {
  const email = normalizeEmail(emailRaw);
  return (await loadRecords()).find((r) => r.email === email) ?? null;
}
