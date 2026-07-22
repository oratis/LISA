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

function readCounter(now: number): DayCounter {
  try {
    const parsed = JSON.parse(fs.readFileSync(counterPath(), "utf8")) as DayCounter;
    if (parsed.day === utcDay(now) && typeof parsed.microUSD === "number") return parsed;
  } catch {
    /* fresh day / missing file */
  }
  return { day: utcDay(now), microUSD: 0 };
}

/** Add spend to today's global counter (called from the meter). */
export function globalSpendAdd(microUSD: number, now: number = Date.now()): void {
  try {
    const c = readCounter(now);
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
  return readCounter(now).microUSD >= dailyCapMicroUSD(env);
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
