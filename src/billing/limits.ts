/**
 * Abuse guards — per-uid rate limits, the global daily spend cap, and the
 * kill switch (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.5, milestone B7).
 *
 * Free quota is an attack surface: these are the backstops that make the §7
 * economics hold even against a determined farmer.
 *
 *  - Per-uid RPM (in-memory sliding minute; single-instance cloud): calibrated
 *    so burning a whole window requires sustained max-rate requests.
 *  - Global daily face-value cap: persisted under the GLOBAL home so a restart
 *    can't reset the day's accounting. Exceeded ⇒ the whole cloud answers 402
 *    until the (UTC) day rolls or the operator raises the cap.
 *  - Kill switch: LISA_BILLING_KILL=1 pauses all metered inference immediately.
 *
 * Env knobs: LISA_RPM_LIMIT (default 20), LISA_DAILY_CAP_USD (default 200).
 */
import fs from "node:fs";
import path from "node:path";
import { lisaGlobalHome } from "../paths.js";
import { firestoreEnabled, getDoc, casUpdate } from "../cloud/firestore.js";

function truthy(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function killSwitchOn(env: Record<string, string | undefined> = process.env): boolean {
  return truthy(env.LISA_BILLING_KILL);
}

// ── per-uid RPM (sliding minute) ────────────────────────────────────────────
const rpmBuckets = new Map<string, number[]>();

export function rpmLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.LISA_RPM_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/** Record + check one request for `uid`. False ⇒ over the per-minute limit. */
export function rpmOk(uid: string, now: number = Date.now(), env: Record<string, string | undefined> = process.env): boolean {
  const windowStart = now - 60_000;
  const bucket = (rpmBuckets.get(uid) ?? []).filter((t) => t > windowStart);
  if (bucket.length >= rpmLimit(env)) {
    rpmBuckets.set(uid, bucket);
    return false;
  }
  bucket.push(now);
  rpmBuckets.set(uid, bucket);
  return true;
}

/** Test seam. */
export function resetRpm(): void {
  rpmBuckets.clear();
}

// ── generic per-key sliding window (unauthenticated endpoints) ──────────────
// Separate from rpmBuckets: that one is keyed by uid AFTER auth, this one is
// keyed by client IP BEFORE it, so an attacker controls the key space. (#260)
const genericBuckets = new Map<string, number[]>();
const GENERIC_MAX_KEYS = 10_000;

/**
 * Record + check one hit for `key` in a sliding `windowMs`. False ⇒ over limit.
 *
 * In-memory and per-instance, and the IP behind Cloud Run comes from a header a
 * client can spoof — so this is a coarse backstop against a single naive
 * attacker, NOT a security boundary. The real guards on /register and /login
 * are scrypt's cost, email uniqueness, and the per-email login throttle.
 */
export function ipRateOk(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
  const windowStart = now - windowMs;
  if (genericBuckets.size >= GENERIC_MAX_KEYS) {
    // Prune fully-expired keys so IP rotation can't grow the map without bound.
    for (const [k, hits] of genericBuckets) {
      if (hits.length === 0 || hits[hits.length - 1]! <= windowStart) genericBuckets.delete(k);
    }
    // Still full ⇒ everything in it is live. Fail OPEN, deliberately: the key
    // space is attacker-controlled (the IP comes from a spoofable XFF header),
    // so refusing here would let one client fill the map with 10k junk keys and
    // lock every *new* IP out of /register + /login. This is a coarse backstop,
    // not a security boundary — scrypt's cost, email uniqueness and the
    // per-email login throttle are the guards that must not fail open, and none
    // of them depends on this map. Admitting the overflow is strictly safer
    // than denying real users.
    if (genericBuckets.size >= GENERIC_MAX_KEYS && !genericBuckets.has(key)) return true;
  }
  const bucket = (genericBuckets.get(key) ?? []).filter((t) => t > windowStart);
  if (bucket.length >= limit) {
    genericBuckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  genericBuckets.set(key, bucket);
  return true;
}

/** Test seam. */
export function resetIpRate(): void {
  genericBuckets.clear();
}

// ── global daily spend cap (persisted; survives restarts) ───────────────────
interface DayCounter {
  /** UTC day, "YYYY-MM-DD". */
  day: string;
  microUSD: number;
}

function counterPath(): string {
  return path.join(lisaGlobalHome(), "billing-global.json");
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Read today's counter. A MISSING file (ENOENT) or yesterday's stale file is
 * the normal "no spend yet today" case and reads as 0. A genuine read/parse
 * FAILURE (permission error, GCS-mount hiccup, corrupt JSON) is reported as
 * `ok:false` so the cap check can fail CLOSED instead of silently zeroing the
 * $200/day hard cap. (#267)
 */
type CounterRead = { ok: true; counter: DayCounter } | { ok: false };

function readCounter(now: number): CounterRead {
  let raw: string;
  try {
    raw = fs.readFileSync(counterPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, counter: { day: utcDay(now), microUSD: 0 } }; // fresh day
    }
    return { ok: false }; // I/O error — the counter is UNKNOWN, not zero
  }
  try {
    const parsed = JSON.parse(raw) as DayCounter;
    if (typeof parsed.microUSD !== "number") return { ok: false }; // malformed shape
    if (parsed.day !== utcDay(now)) return { ok: true, counter: { day: utcDay(now), microUSD: 0 } }; // day rolled
    return { ok: true, counter: parsed };
  } catch {
    return { ok: false }; // corrupt JSON — don't silently disable the cap
  }
}

// Throttle the fail-closed log so a persistent storage fault doesn't spam every
// request; one line per minute is enough for an operator to notice.
let lastCapReadWarnAt = 0;
function warnCapReadFailure(now: number): void {
  if (now - lastCapReadWarnAt < 60_000) return;
  lastCapReadWarnAt = now;
  console.error(
    "[billing] ⚠ global daily-cap counter unreadable — failing CLOSED (service_paused) until the store recovers",
  );
}

// B9: with Firestore on, the day counter is a shared doc
// (lisa-global/day-YYYY-MM-DD) incremented by CAS from every instance. Reads
// go through a short-lived local cache so the sync exceeded-check stays sync;
// a $200 cap tolerates seconds of staleness.
let fsCounterCache: { day: string; microUSD: number; readAt: number } | null = null;

/** Add spend to today's global counter (called from the meter). */
export function globalSpendAdd(microUSD: number, now: number = Date.now()): void {
  if (firestoreEnabled()) {
    const day = utcDay(now);
    void casUpdate(`lisa-global/day-${day}`, (current) => {
      const total = (typeof current?.microUSD === "number" ? current.microUSD : 0) + microUSD;
      fsCounterCache = { day, microUSD: total, readAt: now };
      return { next: { day, microUSD: total }, result: undefined };
    }).catch(() => {
      // accounting is best-effort; the audit ledger remains authoritative
    });
    return;
  }
  try {
    const r = readCounter(now);
    // If the counter is unreadable (not merely absent), DON'T overwrite it with
    // a fresh 0 — that would clobber a temporarily-unreadable-but-valid file and
    // undercount the day. Skip the increment; accounting is best-effort and the
    // audit ledger remains authoritative.
    if (!r.ok) return;
    const c = r.counter;
    c.microUSD += microUSD;
    const file = counterPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, file);
  } catch {
    // accounting is best-effort; the audit ledger remains authoritative
  }
}

export function dailyCapMicroUSD(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.LISA_DAILY_CAP_USD);
  return (Number.isFinite(n) && n > 0 ? n : 200) * 1_000_000;
}

export function globalSpendExceeded(now: number = Date.now(), env: Record<string, string | undefined> = process.env): boolean {
  if (firestoreEnabled(env)) {
    const day = utcDay(now);
    // Refresh the cache in the background when stale; decide on what we have.
    if (!fsCounterCache || fsCounterCache.day !== day || now - fsCounterCache.readAt > 30_000) {
      void getDoc(`lisa-global/day-${day}`)
        .then((doc) => {
          const total = typeof doc?.data.microUSD === "number" ? doc.data.microUSD : 0;
          fsCounterCache = { day, microUSD: total, readAt: now };
        })
        .catch(() => {});
    }
    return (fsCounterCache?.day === day ? fsCounterCache.microUSD : 0) >= dailyCapMicroUSD(env);
  }
  const r = readCounter(now);
  if (!r.ok) {
    // The counter is unreadable — fail CLOSED so a storage fault can't silently
    // disable the hard cap (#267). Reported as "exceeded" ⇒ preflight 402s.
    warnCapReadFailure(now);
    return true;
  }
  return r.counter.microUSD >= dailyCapMicroUSD(env);
}

// ── the combined preflight the request paths call ───────────────────────────
export type LimitVerdict =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

/** All non-quota guards for one metered request from `uid`. */
export function preflightLimits(uid: string, now: number = Date.now()): LimitVerdict {
  if (killSwitchOn() || globalSpendExceeded(now)) {
    return { ok: false, status: 402, body: { error: "service_paused" } };
  }
  if (!rpmOk(uid, now)) {
    return { ok: false, status: 429, body: { error: "rate_limited", retryAfterSec: 30 } };
  }
  return { ok: true };
}
