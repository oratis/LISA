/**
 * Model price table — FACE-VALUE pricing for LISA-billed usage
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.3/§7, milestone B3).
 *
 * Face price = provider list price × MARGIN. The margin (1.4×) covers Apple's
 * commission on credit packs, infra, and refund slippage. All amounts are
 * micro-USD (1e-6 USD, integers) per MILLION tokens, so arithmetic stays exact.
 *
 * Keep this table in sync with the providers' official price pages when
 * onboarding a model — it is versioned with the code on purpose (an audit can
 * pin any ledger line to the table that priced it via `PRICES_VERSION`).
 *
 * Tiers: "standard" models are eligible for the free session window; "premium"
 * models only ever draw from paid balance (the one hard product constraint —
 * see §7 of the plan).
 */
import type { ProviderUsage } from "../providers/types.js";

export const PRICES_VERSION = 1;
export const MARGIN = 1.4;

export type ModelTier = "standard" | "premium";

export interface ModelPrice {
  /** Face price, micro-USD per 1M input tokens. */
  inPerM: number;
  /** Face price, micro-USD per 1M output tokens. */
  outPerM: number;
  /** Face price, micro-USD per 1M cache-write tokens. */
  cacheWritePerM: number;
  /** Face price, micro-USD per 1M cache-read tokens. */
  cacheReadPerM: number;
  tier: ModelTier;
}

/** $/M → micro-USD/M at face value (list × margin). */
function face(usdPerM: number): number {
  return Math.round(usdPerM * MARGIN * 1_000_000);
}

/**
 * Longest-prefix match table. List prices as of 2026-07 — re-check the
 * provider price pages before onboarding a new model.
 */
const TABLE: Array<{ prefix: string; price: ModelPrice }> = [
  // GLM (Zhipu, open.bigmodel.cn) — the standard/free-window family.
  { prefix: "glm-", price: { inPerM: face(0.6), outPerM: face(2.2), cacheWritePerM: face(0.6), cacheReadPerM: face(0.11), tier: "standard" } },
  { prefix: "chatglm-", price: { inPerM: face(0.6), outPerM: face(2.2), cacheWritePerM: face(0.6), cacheReadPerM: face(0.11), tier: "standard" } },
  // Anthropic — premium (paid balance only).
  { prefix: "claude-haiku", price: { inPerM: face(1), outPerM: face(5), cacheWritePerM: face(1.25), cacheReadPerM: face(0.1), tier: "premium" } },
  { prefix: "claude-sonnet", price: { inPerM: face(3), outPerM: face(15), cacheWritePerM: face(3.75), cacheReadPerM: face(0.3), tier: "premium" } },
  { prefix: "claude-opus", price: { inPerM: face(5), outPerM: face(25), cacheWritePerM: face(6.25), cacheReadPerM: face(0.5), tier: "premium" } },
  { prefix: "claude-", price: { inPerM: face(3), outPerM: face(15), cacheWritePerM: face(3.75), cacheReadPerM: face(0.3), tier: "premium" } },
  // OpenAI — premium.
  { prefix: "gpt-4o-mini", price: { inPerM: face(0.15), outPerM: face(0.6), cacheWritePerM: face(0.15), cacheReadPerM: face(0.075), tier: "premium" } },
  { prefix: "gpt-", price: { inPerM: face(2.5), outPerM: face(10), cacheWritePerM: face(2.5), cacheReadPerM: face(1.25), tier: "premium" } },
];

/**
 * Conservative fallback for unknown models: priced like a mid premium model so
 * a table gap can never hand out free inference; tier "premium" keeps it off
 * the free window.
 */
const FALLBACK: ModelPrice = { inPerM: face(3), outPerM: face(15), cacheWritePerM: face(3.75), cacheReadPerM: face(0.3), tier: "premium" };

export function priceForModel(model: string): ModelPrice {
  const m = model.trim().toLowerCase();
  for (const { prefix, price } of TABLE) {
    if (m.startsWith(prefix)) return price;
  }
  return FALLBACK;
}

export function modelTier(model: string): ModelTier {
  return priceForModel(model).tier;
}

/** Face cost of one usage sample, micro-USD (integer, rounded up ≥ 0). */
export function costMicroUSD(model: string, usage: ProviderUsage): number {
  const p = priceForModel(model);
  const cost =
    (usage.inputTokens * p.inPerM +
      usage.outputTokens * p.outPerM +
      usage.cacheWriteTokens * p.cacheWritePerM +
      usage.cacheReadTokens * p.cacheReadPerM) /
    1_000_000;
  // [B3 hardening] Guard against a non-finite token count (NaN/Infinity), which
  // would otherwise propagate NaN into the ledger, balance.json, and the budget
  // breaker (Math.max(0, NaN) === NaN).
  const micro = Math.ceil(cost);
  return Number.isFinite(micro) ? Math.max(0, micro) : 0;
}

/** Render micro-USD as a human dollar string ("$1.23"). */
export function formatMicroUSD(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

/**
 * How many tokens `microUSD` can buy at this model's OUTPUT rate — the
 * conservative per-turn breaker for the agent loop (every token priced as
 * output). Clamped to a sane ceiling so a huge paid balance doesn't disable
 * the breaker entirely.
 */
export function tokensAffordable(model: string, microUSD: number): number {
  const p = priceForModel(model);
  const tokens = Math.floor((microUSD / p.outPerM) * 1_000_000);
  return Math.max(1000, Math.min(tokens, 5_000_000));
}
