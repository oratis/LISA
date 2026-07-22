/**
 * Quota engine — the 12h session window, paid tiers, and debit order
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §5.2/§6.3, milestone B4).
 *
 * Model (decisions locked 2026-07-21):
 *  - A signed-in account's first request opens a 12h WINDOW carrying a free
 *    face-value allowance. The window expires, the allowance resets — no
 *    carry-over (Claude Code's session model, 5h→12h).
 *  - The allowance depends on account standing: Apple / verified email $5;
 *    unverified email $1. PAYING raises it by tier — 30-day cumulative IAP
 *    purchases ≥ $4.99 → $10, ≥ $19.99 → $20 (the tier is a perk that decays
 *    30 days after the purchases stop; the PAID BALANCE itself never expires —
 *    App Store 3.1.1).
 *  - Debit order: free window first, then paid balance. PREMIUM models
 *    (Claude/GPT — prices.ts tier) never touch the free window: paid only.
 *  - A refund clawback (B5) may push the paid balance negative; standard-model
 *    free-window use keeps working, premium stays locked until topped up.
 *
 * Storage: `<active home>/billing/balance.json` — the fast path beside the
 * usage.jsonl audit ledger; atomic writes under the billing lock.
 */
import path from "node:path";
import { lisaHome, scopedUid } from "../paths.js";
import { atomicWrite, readTextOrEmpty, ensureDir } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import type { AccountRecord } from "../web/accounts.js";
import { modelTier } from "./prices.js";
import { billingDir } from "./meter.js";
import { firestoreEnabled, getDoc, casUpdate } from "../cloud/firestore.js";

export const WINDOW_MS = 12 * 60 * 60 * 1000;
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Face-value allowances, micro-USD.
export const FREE_WINDOW_FULL = 5_000_000; // Apple / verified email
export const FREE_WINDOW_UNVERIFIED = 1_000_000; // email before verification (B7 levels it)
export const TIER1_WINDOW = 10_000_000;
export const TIER2_WINDOW = 20_000_000;
export const TIER1_THRESHOLD = 4_990_000; // ≥ $4.99 bought in the last 30d
export const TIER2_THRESHOLD = 19_990_000; // ≥ $19.99

export interface PurchaseEntry {
  /** ms since epoch. */
  at: number;
  /** Face value credited, micro-USD. */
  microUSD: number;
  /** StoreKit transactionId (dedup + refund clawback key, B5). */
  transactionId?: string;
}

export interface BalanceState {
  /** Paid balance, micro-USD. Never expires; may go negative after a refund. */
  paidMicroUSD: number;
  /** Purchases (for the 30d tier); pruned past 60d. */
  purchases: PurchaseEntry[];
  /** The active free window, if one has been opened. */
  window?: { start: number; spentMicroUSD: number };
}

function balanceFile(): string {
  return path.join(billingDir(), "balance.json");
}
function balanceLock(): string {
  return path.join(billingDir(), "balance.lock");
}

const EMPTY: BalanceState = { paidMicroUSD: 0, purchases: [] };

function sanitizeBalance(parsed: Partial<BalanceState> | null | undefined): BalanceState {
  return {
    paidMicroUSD: typeof parsed?.paidMicroUSD === "number" ? parsed.paidMicroUSD : 0,
    purchases: Array.isArray(parsed?.purchases) ? parsed.purchases : [],
    window: parsed?.window,
  };
}

// B9: with Firestore enabled AND a per-uid scope active, the balance lives in
// lisa-balances/{uid} and every mutation is a CAS — safe across instances.
// Outside a uid scope (or with Firestore off) the file beside the usage ledger
// stays authoritative, exactly as before.
function balanceDocPath(): string | null {
  if (!firestoreEnabled()) return null;
  const uid = scopedUid();
  return uid ? `lisa-balances/${uid}` : null;
}

export async function readBalance(): Promise<BalanceState> {
  const doc = balanceDocPath();
  if (doc) {
    try {
      const d = await getDoc(doc);
      return sanitizeBalance((d?.data as Partial<BalanceState> | undefined) ?? null);
    } catch {
      return { ...EMPTY, purchases: [] };
    }
  }
  try {
    const text = await readTextOrEmpty(balanceFile());
    if (!text.trim()) return { ...EMPTY, purchases: [] };
    return sanitizeBalance(JSON.parse(text) as Partial<BalanceState>);
  } catch {
    return { ...EMPTY, purchases: [] };
  }
}

async function writeBalance(state: BalanceState): Promise<void> {
  await ensureDir(billingDir());
  await atomicWrite(balanceFile(), JSON.stringify(state, null, 2));
}

/** Mutate the balance atomically (Firestore CAS or the file lock). */
export async function updateBalance<T>(
  fn: (state: BalanceState) => T,
): Promise<T> {
  const doc = balanceDocPath();
  if (doc) {
    return casUpdate(doc, (current) => {
      const state = sanitizeBalance((current as Partial<BalanceState> | null) ?? null);
      const out = fn(state);
      return { next: state as unknown as Record<string, unknown>, result: out };
    });
  }
  await ensureDir(billingDir());
  return withFileLock(balanceLock(), async () => {
    const state = await readBalance();
    const out = fn(state);
    await writeBalance(state);
    return out;
  });
}

/** 30-day cumulative purchase face value, micro-USD. */
export function purchases30d(state: BalanceState, now: number): number {
  return state.purchases
    .filter((p) => now - p.at <= THIRTY_DAYS_MS)
    .reduce((sum, p) => sum + p.microUSD, 0);
}

export type QuotaTier = "free" | "free-unverified" | "tier1" | "tier2";

export function tierFor(acct: AccountRecord, state: BalanceState, now: number): QuotaTier {
  const bought = purchases30d(state, now);
  if (bought >= TIER2_THRESHOLD) return "tier2";
  if (bought >= TIER1_THRESHOLD) return "tier1";
  return acct.verified ? "free" : "free-unverified";
}

export function windowAllowance(tier: QuotaTier): number {
  switch (tier) {
    case "tier2": return TIER2_WINDOW;
    case "tier1": return TIER1_WINDOW;
    case "free": return FREE_WINDOW_FULL;
    case "free-unverified": return FREE_WINDOW_UNVERIFIED;
  }
}

export interface QuotaStatus {
  tier: QuotaTier;
  /** Face allowance of the current window. */
  windowMicroUSD: number;
  /** Spent inside the current window. */
  spentMicroUSD: number;
  /** max(0, allowance - spent). */
  remainingMicroUSD: number;
  /** Paid balance (may be negative after a refund). */
  paidMicroUSD: number;
  /** When the current window resets (ms epoch), or null if none is open. */
  resetAt: number | null;
}

/** Roll the window if expired (mutates state); returns the live window. */
function liveWindow(state: BalanceState, now: number): { start: number; spentMicroUSD: number } {
  if (!state.window || now - state.window.start >= WINDOW_MS) {
    state.window = { start: now, spentMicroUSD: 0 };
  }
  return state.window;
}

export async function quotaStatus(acct: AccountRecord, now: number = Date.now()): Promise<QuotaStatus> {
  const state = await readBalance();
  const tier = tierFor(acct, state, now);
  const allowance = windowAllowance(tier);
  // Read-only view: an expired window shows as fresh (it WILL reset on use).
  const w = state.window && now - state.window.start < WINDOW_MS ? state.window : null;
  const spent = w?.spentMicroUSD ?? 0;
  return {
    tier,
    windowMicroUSD: allowance,
    spentMicroUSD: spent,
    remainingMicroUSD: Math.max(0, allowance - spent),
    paidMicroUSD: state.paidMicroUSD,
    resetAt: w ? w.start + WINDOW_MS : null,
  };
}

export type PrecheckResult =
  | { ok: true; /** budget hint for the agent's token breaker, micro-USD */ budgetMicroUSD: number }
  | { ok: false; error: "quota_exhausted"; resetAt: number; tier: QuotaTier }
  | { ok: false; error: "premium_requires_balance"; tier: QuotaTier }
  | { ok: false; error: "billing_unavailable" };

// Fail-closed on serving: flipped false when a balance-store write fails (e.g. a
// full disk), so precheckTurn refuses NEW turns until a write succeeds — no
// accumulating unbillable turns. A successful precheck/debit write clears it.
let storeHealthy = true;
/** True while the balance store is writable. See debitTurn / precheckTurn. */
export function billingStoreHealthy(): boolean {
  return storeHealthy;
}

/**
 * Gate one turn BEFORE it runs. Opens/rolls the window as a side effect (the
 * window starts at first use, Claude Code-style).
 */
export async function precheckTurn(
  acct: AccountRecord,
  model: string,
  now: number = Date.now(),
): Promise<PrecheckResult> {
  try {
    const result = await updateBalance((state): PrecheckResult => {
      const tier = tierFor(acct, state, now);
      if (modelTier(model) === "premium") {
        // Premium never draws on the free window.
        if (state.paidMicroUSD > 0) return { ok: true, budgetMicroUSD: state.paidMicroUSD };
        return { ok: false, error: "premium_requires_balance", tier };
      }
      const w = liveWindow(state, now);
      const allowance = windowAllowance(tier);
      const freeLeft = allowance - w.spentMicroUSD;
      const paid = Math.max(0, state.paidMicroUSD);
      if (freeLeft <= 0 && paid <= 0) {
        return { ok: false, error: "quota_exhausted", resetAt: w.start + WINDOW_MS, tier };
      }
      return { ok: true, budgetMicroUSD: Math.max(0, freeLeft) + paid };
    });
    storeHealthy = true; // this precheck just wrote the balance file → store is writable
    return result;
  } catch (err) {
    // The store write (precheck opens/rolls the window as a side effect) failed
    // — e.g. a full disk. Fail CLOSED on serving: refuse the turn cleanly rather
    // than throwing a 500 or serving a turn we then can't bill.
    storeHealthy = false;
    console.error(
      `[billing] precheck: balance store unwritable — refusing turn: ${(err as Error)?.message}`,
    );
    return { ok: false, error: "billing_unavailable" };
  }
}

/**
 * Debit one metered turn AFTER it ran: free window first (standard models),
 * then paid balance. Premium models bill paid only. A concurrent overshoot may
 * push paid slightly negative — absorbed by the next purchase.
 */
export async function debitTurn(
  acct: AccountRecord,
  model: string,
  microUSD: number,
  now: number = Date.now(),
): Promise<void> {
  if (microUSD <= 0) return;
  const apply = (state: BalanceState): void => {
    if (modelTier(model) === "premium") {
      state.paidMicroUSD -= microUSD;
      return;
    }
    const tier = tierFor(acct, state, now);
    const w = liveWindow(state, now);
    const allowance = windowAllowance(tier);
    const freeLeft = Math.max(0, allowance - w.spentMicroUSD);
    const fromFree = Math.min(freeLeft, microUSD);
    w.spentMicroUSD += fromFree;
    const rest = microUSD - fromFree;
    if (rest > 0) state.paidMicroUSD -= rest;
  };
  // The debit runs AFTER the answer already shipped, so a lost write is a free
  // turn. updateBalance is atomic (temp-write + rename) so a failed attempt
  // persisted nothing — retry is safe, no double-debit. After the retries fail
  // (a full disk / fd exhaustion mid-turn), make it LOUD so the spend is
  // reconcilable from logs, and mark the store unhealthy so the next precheck
  // refuses new turns until it recovers (no accumulating free turns).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await updateBalance(apply);
      storeHealthy = true;
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  storeHealthy = false;
  console.error(
    `[billing] CRITICAL: debit of ${microUSD} µUSD for ${acct.uid} (${model}) failed — ` +
      `balance store unwritable: ${(lastErr as Error)?.message}. Refusing new turns until it recovers.`,
  );
  throw lastErr;
}

/** Credit a purchase (B5 IAP calls this) and prune purchases older than 60d. */
export async function creditPurchase(entry: PurchaseEntry, now: number = Date.now()): Promise<void> {
  await updateBalance((state) => {
    state.paidMicroUSD += entry.microUSD;
    state.purchases.push(entry);
    state.purchases = state.purchases.filter((p) => now - p.at <= 2 * THIRTY_DAYS_MS);
  });
}

/** Reverse a refunded purchase by transactionId (B5 ASN clawback). */
export async function clawbackPurchase(transactionId: string): Promise<boolean> {
  return updateBalance((state) => {
    const idx = state.purchases.findIndex((p) => p.transactionId === transactionId);
    if (idx < 0) return false;
    const [gone] = state.purchases.splice(idx, 1);
    state.paidMicroUSD -= gone!.microUSD;
    return true;
  });
}
