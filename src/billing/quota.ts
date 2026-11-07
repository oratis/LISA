/**
 * Quota engine — the daily free allowance, paid tiers, and debit order
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §5.2/§6.3, milestone B4; resized for the
 * 2026-11 commercialization plan, M0).
 *
 * Model:
 *  - A signed-in account's first request opens a 24h WINDOW carrying a free
 *    face-value allowance. The window expires, the allowance resets — no
 *    carry-over. (2026-07–11 this was a 12h window of $5; at that size the
 *    allowance covered any personal use and nothing ever reached a paywall.)
 *  - The allowance depends on account standing: Apple / Google / verified
 *    email $0.30; unverified email $0.10. PAYING raises it by tier — 30-day
 *    cumulative purchases ≥ $4.99 → $0.60, ≥ $19.99 → $1.20 (the tier is a
 *    perk that decays 30 days after the purchases stop; the PAID BALANCE itself
 *    never expires — App Store 3.1.1).
 *  - A verified account gets a one-time WELCOME GRANT ($2 face) the first time
 *    it is admitted. It is promotional: standard models only, never refunded,
 *    and not counted toward tiers. It is claimed under the account's sign-in
 *    identities (grant-claims.ts), so deleting the account and signing in
 *    again does not issue it a second time.
 *  - Debit order: free window, then welcome grant, then paid balance. PREMIUM
 *    models (prices.ts tier — every model but the standard rows such as
 *    Gemini 2.5 Flash, Claude Haiku 5.5, GPT-6 Luna and GLM) touch neither the
 *    free window nor the grant: paid only.
 *  - A refund clawback (B5) may push the paid balance negative; standard-model
 *    free-window use keeps working, premium stays locked until topped up.
 *
 * Storage: `<active home>/billing/balance.json` — the fast path beside the
 * usage.jsonl audit ledger; atomic writes under the billing lock.
 *
 * T-8: the balance is also the idempotency boundary for the usage OUTBOX
 * (outbox.ts). A metered turn is debited under its outbox event id, and the
 * ids of recently applied events ride along in `settled` — so a replay of the
 * same event (reconciler after a crash between "balance written" and "event
 * marked committed") is refused here, by the ledger itself, not by a caller
 * remembering to check.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { scopedUid } from "../paths.js";
import { atomicWrite, ensureDir } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import type { AccountRecord } from "../web/accounts.js";
import { modelTier } from "./prices.js";
import { billingDir } from "./meter.js";
import { firestoreEnabled, getDoc, casUpdate } from "../cloud/firestore.js";
import { claimWelcomeGrant, welcomeGrantClaimed } from "./grant-claims.js";
import { logError } from "../log.js";

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Face-value allowances, micro-USD.
export const FREE_WINDOW_FULL = 300_000; // Apple / Google / verified email
export const FREE_WINDOW_UNVERIFIED = 100_000; // email before verification
export const TIER1_WINDOW = 600_000;
export const TIER2_WINDOW = 1_200_000;
/** One-time welcome grant for a verified account, standard models only. */
export const SIGNUP_GRANT = 2_000_000;
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

/** One applied outbox event — the ledger-side idempotency key (T-8). */
export interface SettledEntry {
  /** Outbox event id. */
  id: string;
  /** ms since epoch when the debit was applied. */
  at: number;
}

export interface BalanceState {
  /** Paid balance, micro-USD. Never expires; may go negative after a refund. */
  paidMicroUSD: number;
  /** Purchases for tiering + durable transaction idempotency and refunds. */
  purchases: PurchaseEntry[];
  /** The active free window, if one has been opened. */
  window?: { start: number; spentMicroUSD: number };
  /** Unspent welcome grant, micro-USD (standard models only; never negative). */
  grantMicroUSD?: number;
  /** When the welcome grant was issued; set once, so it is never issued twice. */
  signupGrantAt?: number;
  /**
   * Recently applied outbox event ids, oldest first. Bounded by SETTLED_MAX
   * and SETTLED_TTL_MS because this document is read on every turn; the
   * reconciler refuses to replay anything that could have aged out of it.
   */
  settled?: SettledEntry[];
}

/** How many applied event ids the balance remembers (see SettledEntry). */
export const SETTLED_MAX = 1000;
/** How long an applied event id is remembered. Older replays are escalated, never re-applied. */
export const SETTLED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function balanceFile(): string {
  return path.join(billingDir(), "balance.json");
}
function balanceLock(): string {
  return path.join(billingDir(), "balance.lock");
}

const EMPTY: BalanceState = { paidMicroUSD: 0, purchases: [] };

export class BillingStateError extends Error {
  constructor(
    public readonly code:
      "balance_unavailable" | "balance_corrupt" | "purchase_conflict" | "outbox_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "BillingStateError";
  }
}

function emptyBalance(): BalanceState {
  return { ...EMPTY, purchases: [] };
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseBalance(parsed: unknown): BalanceState {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BillingStateError("balance_corrupt", "balance store must contain an object");
  }
  const raw = parsed as Partial<BalanceState>;
  if (!safeInteger(raw.paidMicroUSD) || !Array.isArray(raw.purchases)) {
    throw new BillingStateError("balance_corrupt", "balance store has invalid totals");
  }
  const purchases: PurchaseEntry[] = [];
  for (const item of raw.purchases) {
    if (
      !item ||
      typeof item !== "object" ||
      !safeInteger(item.at) ||
      !safeInteger(item.microUSD) ||
      (item.transactionId !== undefined && typeof item.transactionId !== "string")
    ) {
      throw new BillingStateError("balance_corrupt", "balance store has an invalid purchase");
    }
    purchases.push({ ...item });
  }
  let window: BalanceState["window"];
  if (raw.window !== undefined) {
    if (
      !raw.window ||
      !safeInteger(raw.window.start) ||
      !safeInteger(raw.window.spentMicroUSD) ||
      raw.window.spentMicroUSD < 0
    ) {
      throw new BillingStateError("balance_corrupt", "balance store has an invalid window");
    }
    window = { ...raw.window };
  }
  if (
    (raw.grantMicroUSD !== undefined &&
      (!safeInteger(raw.grantMicroUSD) || raw.grantMicroUSD < 0)) ||
    (raw.signupGrantAt !== undefined && !safeInteger(raw.signupGrantAt))
  ) {
    throw new BillingStateError("balance_corrupt", "balance store has an invalid welcome grant");
  }
  let settled: SettledEntry[] | undefined;
  if (raw.settled !== undefined) {
    // Fail closed on a malformed ring: dropping it silently would let the
    // reconciler double-charge a replay it can no longer recognise.
    if (!Array.isArray(raw.settled)) {
      throw new BillingStateError(
        "balance_corrupt",
        "balance store has an invalid settlement ring",
      );
    }
    settled = [];
    for (const item of raw.settled) {
      const entry = item as Partial<SettledEntry> | null;
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.id !== "string" ||
        !entry.id ||
        !safeInteger(entry.at)
      ) {
        throw new BillingStateError(
          "balance_corrupt",
          "balance store has an invalid settlement entry",
        );
      }
      settled.push({ id: entry.id, at: entry.at });
    }
  }
  return {
    paidMicroUSD: raw.paidMicroUSD,
    purchases,
    ...(window ? { window } : {}),
    ...(raw.grantMicroUSD !== undefined ? { grantMicroUSD: raw.grantMicroUSD } : {}),
    ...(raw.signupGrantAt !== undefined ? { signupGrantAt: raw.signupGrantAt } : {}),
    ...(settled && settled.length ? { settled } : {}),
  };
}

/** Has this outbox event already been applied to the balance? */
export function settledContains(state: BalanceState, eventId: string): boolean {
  return !!state.settled?.some((entry) => entry.id === eventId);
}

/** Remember an applied event id, keeping the ring within its size/age bounds. */
function noteSettled(state: BalanceState, eventId: string, now: number): void {
  const ring = state.settled ?? [];
  ring.push({ id: eventId, at: now });
  let kept = ring.filter((entry) => now - entry.at <= SETTLED_TTL_MS);
  if (kept.length > SETTLED_MAX) kept = kept.slice(kept.length - SETTLED_MAX);
  state.settled = kept;
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
      return d ? parseBalance(d.data) : emptyBalance();
    } catch (err) {
      if (err instanceof BillingStateError) throw err;
      throw new BillingStateError(
        "balance_unavailable",
        `balance store is unavailable: ${(err as Error).message}`,
      );
    }
  }
  let text: string;
  try {
    text = await fs.readFile(balanceFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyBalance();
    throw new BillingStateError(
      "balance_unavailable",
      `balance store is unavailable: ${(err as Error).message}`,
    );
  }
  try {
    return parseBalance(JSON.parse(text));
  } catch (err) {
    if (err instanceof BillingStateError) throw err;
    throw new BillingStateError(
      "balance_corrupt",
      `balance store is corrupt: ${(err as Error).message}`,
    );
  }
}

async function writeBalance(state: BalanceState): Promise<void> {
  await ensureDir(billingDir());
  await atomicWrite(balanceFile(), JSON.stringify(state, null, 2));
}

/** Mutate the balance atomically (Firestore CAS or the file lock). */
export async function updateBalance<T>(fn: (state: BalanceState) => T): Promise<T> {
  const doc = balanceDocPath();
  if (doc) {
    return casUpdate(doc, (current) => {
      const state = current ? parseBalance(current) : emptyBalance();
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
    case "tier2":
      return TIER2_WINDOW;
    case "tier1":
      return TIER1_WINDOW;
    case "free":
      return FREE_WINDOW_FULL;
    case "free-unverified":
      return FREE_WINDOW_UNVERIFIED;
  }
}

/** Has this account earned a welcome grant it has not been given yet? */
function grantPending(acct: AccountRecord, state: BalanceState): boolean {
  return acct.verified && state.signupGrantAt === undefined;
}

/**
 * The outcome of claiming the welcome grant under the account's sign-in
 * identities (grant-claims.ts): won, already claimed by an earlier account of
 * the same person, or not known (the claim store could not be reached — the
 * grant stays pending and is tried again on a later turn).
 */
type GrantClaim = "won" | "taken" | "unknown";

/**
 * Settle a pending welcome grant from its claim (mutates state); returns the
 * unspent grant. A grant is recorded as issued — `signupGrantAt` — whether or
 * not it was won, so the claim is made once per balance.
 */
function liveGrant(
  acct: AccountRecord,
  state: BalanceState,
  now: number,
  claim: GrantClaim,
): number {
  if (grantPending(acct, state) && claim !== "unknown") {
    if (claim === "won") state.grantMicroUSD = (state.grantMicroUSD ?? 0) + SIGNUP_GRANT;
    state.signupGrantAt = now;
  }
  return state.grantMicroUSD ?? 0;
}

async function claimGrant(acct: AccountRecord, now: number): Promise<GrantClaim> {
  try {
    return (await claimWelcomeGrant(acct, now)) ? "won" : "taken";
  } catch (err) {
    logError(`[billing] welcome-grant claim unavailable: ${(err as Error).message}`);
    return "unknown";
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
  /** Unspent welcome grant, including one that will be issued on first use. */
  grantMicroUSD: number;
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

export async function quotaStatus(
  acct: AccountRecord,
  now: number = Date.now(),
): Promise<QuotaStatus> {
  const state = await readBalance();
  const tier = tierFor(acct, state, now);
  const allowance = windowAllowance(tier);
  // A pending grant is shown only if this person has not had one already.
  let pendingGrant = 0;
  if (grantPending(acct, state)) {
    try {
      pendingGrant = (await welcomeGrantClaimed(acct)) ? 0 : SIGNUP_GRANT;
    } catch {
      pendingGrant = 0;
    }
  }
  // Read-only view: an expired window shows as fresh (it WILL reset on use).
  const w = state.window && now - state.window.start < WINDOW_MS ? state.window : null;
  const spent = w?.spentMicroUSD ?? 0;
  return {
    tier,
    windowMicroUSD: allowance,
    spentMicroUSD: spent,
    remainingMicroUSD: Math.max(0, allowance - spent),
    paidMicroUSD: state.paidMicroUSD,
    grantMicroUSD: grantPending(acct, state) ? pendingGrant : (state.grantMicroUSD ?? 0),
    resetAt: w ? w.start + WINDOW_MS : null,
  };
}

export type PrecheckResult =
  | { ok: true; /** budget hint for the agent's token breaker, micro-USD */ budgetMicroUSD: number }
  | { ok: false; error: "quota_exhausted"; resetAt: number; tier: QuotaTier }
  | { ok: false; error: "premium_requires_balance"; tier: QuotaTier };

/**
 * Gate one turn BEFORE it runs. Opens/rolls the window as a side effect (the
 * window starts at first use, Claude Code-style).
 */
export async function precheckTurn(
  acct: AccountRecord,
  model: string,
  now: number = Date.now(),
): Promise<PrecheckResult> {
  // A pending welcome grant is claimed under the sign-in identities first,
  // outside the balance update (it is another document). Only the first turn
  // of a verified balance takes this path.
  let claim: GrantClaim | null = null;
  for (;;) {
    const out = await precheckOnce(acct, model, now, claim);
    if (out !== NEEDS_GRANT_CLAIM) return out;
    claim = await claimGrant(acct, now);
  }
}

const NEEDS_GRANT_CLAIM = Symbol("needs-grant-claim");

function precheckOnce(
  acct: AccountRecord,
  model: string,
  now: number,
  claim: GrantClaim | null,
): Promise<PrecheckResult | typeof NEEDS_GRANT_CLAIM> {
  return updateBalance((state): PrecheckResult | typeof NEEDS_GRANT_CLAIM => {
    if (claim === null && grantPending(acct, state)) return NEEDS_GRANT_CLAIM;
    const tier = tierFor(acct, state, now);
    const grant = liveGrant(acct, state, now, claim ?? "unknown");
    if (modelTier(model) === "premium") {
      // Premium never draws on the free window or the welcome grant.
      if (state.paidMicroUSD > 0) return { ok: true, budgetMicroUSD: state.paidMicroUSD };
      return { ok: false, error: "premium_requires_balance", tier };
    }
    const w = liveWindow(state, now);
    const allowance = windowAllowance(tier);
    const freeLeft = allowance - w.spentMicroUSD;
    const paid = Math.max(0, state.paidMicroUSD);
    if (freeLeft <= 0 && grant <= 0 && paid <= 0) {
      return { ok: false, error: "quota_exhausted", resetAt: w.start + WINDOW_MS, tier };
    }
    return { ok: true, budgetMicroUSD: Math.max(0, freeLeft) + grant + paid };
  });
}

/**
 * Debit one metered turn AFTER it ran: free window first (standard models),
 * then the welcome grant, then paid balance. Premium models bill paid only. A concurrent overshoot may
 * push paid slightly negative — absorbed by the next purchase.
 *
 * With `opts.eventId` (the outbox event, T-8) the debit is idempotent: the id
 * is checked against and recorded in the balance's `settled` ring inside the
 * same atomic update, so the reconciler can replay a torn settlement without
 * ever charging twice. Returns true when this call changed the balance, false
 * for a replay (or nothing to charge).
 */
export async function debitTurn(
  acct: AccountRecord,
  model: string,
  microUSD: number,
  now: number = Date.now(),
  opts: { eventId?: string } = {},
): Promise<boolean> {
  if (microUSD <= 0) return false;
  const eventId = opts.eventId;
  return updateBalance((state) => {
    if (eventId && settledContains(state, eventId)) return false;
    if (modelTier(model) === "premium") {
      state.paidMicroUSD -= microUSD;
    } else {
      const tier = tierFor(acct, state, now);
      const w = liveWindow(state, now);
      const allowance = windowAllowance(tier);
      const freeLeft = Math.max(0, allowance - w.spentMicroUSD);
      const fromFree = Math.min(freeLeft, microUSD);
      w.spentMicroUSD += fromFree;
      const grantLeft = state.grantMicroUSD ?? 0;
      const fromGrant = Math.min(grantLeft, microUSD - fromFree);
      if (fromGrant > 0) state.grantMicroUSD = grantLeft - fromGrant;
      const rest = microUSD - fromFree - fromGrant;
      if (rest > 0) state.paidMicroUSD -= rest;
    }
    if (eventId) noteSettled(state, eventId, now);
    return true;
  });
}

/**
 * Credit a purchase and prune only anonymous tier-history entries older than
 * 60d. Entries with a transactionId are a durable idempotency/refund ledger and
 * must never be aged out merely because their tier contribution expired.
 *
 * transactionId is an idempotency key at the balance boundary, not only in the
 * global transaction index. This closes the crash window where the balance was
 * credited but the transaction state had not yet advanced to `credited`.
 * Returns true when this call added funds and false for an identical replay.
 */
export async function creditPurchase(
  entry: PurchaseEntry,
  now: number = Date.now(),
): Promise<boolean> {
  return updateBalance((state) => {
    if (entry.transactionId) {
      const existing = state.purchases.find(
        (purchase) => purchase.transactionId === entry.transactionId,
      );
      if (existing) {
        if (existing.microUSD !== entry.microUSD) {
          throw new BillingStateError(
            "purchase_conflict",
            `transaction ${entry.transactionId} has conflicting credit amounts`,
          );
        }
        return false;
      }
    }
    state.paidMicroUSD += entry.microUSD;
    state.purchases.push(entry);
    state.purchases = state.purchases.filter(
      (purchase) => purchase.transactionId || now - purchase.at <= 2 * THIRTY_DAYS_MS,
    );
    return true;
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
