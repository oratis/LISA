/**
 * Model price table — FACE-VALUE pricing for LISA-billed usage
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.3/§7, milestone B3; repriced for the
 * 2026-11 commercialization plan, M0).
 *
 * Face price = provider list price × MARGIN. The margin (2.0×) covers Apple's
 * commission on credit packs (15–30%), infra, refunds and the free allowance;
 * at 1.4× a fully spent credit pack lost money under Apple's standard 30%.
 * All amounts are micro-USD (1e-6 USD, integers) per MILLION tokens, so
 * arithmetic stays exact.
 *
 * Keep this table in sync with the providers' official price pages when
 * onboarding a model — it is versioned with the code on purpose (an audit can
 * pin any ledger line to the table that priced it via `PRICES_VERSION`).
 *
 * Tiers: "standard" models are eligible for the free allowance; "premium"
 * models only ever draw from paid balance (the one hard product constraint —
 * see §7 of the plan).
 */
import type { ProviderUsage } from "../providers/types.js";

export const PRICES_VERSION = 3;
export const MARGIN = 2.0;

export type ModelTier = "standard" | "premium";

/** Face rates, micro-USD per 1M tokens. */
export interface TokenRates {
  /** Face price, micro-USD per 1M input tokens. */
  inPerM: number;
  /** Face price, micro-USD per 1M output tokens. */
  outPerM: number;
  /** Face price, micro-USD per 1M cache-write tokens. */
  cacheWritePerM: number;
  /** Face price, micro-USD per 1M cache-read tokens. */
  cacheReadPerM: number;
  /**
   * Face price, micro-USD per 1M cache-write tokens written with a 1-hour TTL
   * (Anthropic: 2× input, against 1.25× for the 5-minute default). Absent ⇒
   * the provider has one write rate, `cacheWritePerM`.
   */
  cacheWrite1hPerM?: number;
}

export interface ModelPrice extends TokenRates {
  tier: ModelTier;
  /**
   * Prompt-size pricing (e.g. Claude Haiku 5.5 above 100K prompt tokens). When
   * one request's prompt — input + cache read + cache write — exceeds
   * `aboveInputTokens`, every token of that request is priced at `rates`.
   */
  longContext?: { aboveInputTokens: number; rates: TokenRates };
}

/** $/M → micro-USD/M at face value (list × margin). */
function face(usdPerM: number): number {
  return Math.round(usdPerM * MARGIN * 1_000_000);
}

/** Face rates from list $/M: input, output, cache write, cache read. */
function rates(input: number, output: number, cacheWrite: number, cacheRead: number): TokenRates {
  return {
    inPerM: face(input),
    outPerM: face(output),
    cacheWritePerM: face(cacheWrite),
    cacheReadPerM: face(cacheRead),
  };
}

/**
 * Anthropic face rates from list input, output and cache-read $/M. Anthropic
 * prices a 5-minute cache write at 1.25× input and a 1-hour write at 2× input
 * (https://claude.com/pricing); LISA's own Anthropic provider writes its system
 * prompt with the 1-hour TTL.
 */
function anthropicRates(input: number, output: number, cacheRead: number): TokenRates {
  return { ...rates(input, output, input * 1.25, cacheRead), cacheWrite1hPerM: face(input * 2) };
}

/** OpenAI's long-context rule: a prompt above 272K tokens is priced at the long rates. */
const OPENAI_LONG_CONTEXT = 272_000;

/** OpenAI long-context rates (input, output, cached input $/M) for prompts above 272K. */
function openaiLong(
  input: number,
  output: number,
  cacheRead: number,
): NonNullable<ModelPrice["longContext"]> {
  return {
    aboveInputTokens: OPENAI_LONG_CONTEXT,
    rates: rates(input, output, input, cacheRead),
  };
}

/** GPT-5.5 Pro / GPT-5.4 Pro, the dearest OpenAI models ($30 / $180, $60 / $270 long). */
const PRO_PRICE: ModelPrice = {
  ...rates(30, 180, 30, 30),
  tier: "premium",
  longContext: { aboveInputTokens: OPENAI_LONG_CONTEXT, rates: rates(60, 270, 60, 60) },
};
const PRO_SUFFIX = /-pro(-\d{4}-\d{2}-\d{2})?$/;

/**
 * First-match table: exact ids first, then family prefixes, then the generic
 * vendor prefixes. A generic prefix is priced at the vendor's MOST expensive
 * known model of that kind (OpenAI `-pro` ids have their own catch-all), so a
 * new id can never be undercharged while it waits for its row.
 *
 * Sources, list prices verified 2026-11-07 unless noted:
 *  - Anthropic: https://claude.com/pricing (5-minute and 1-hour cache writes, cache read)
 *  - OpenAI: https://developers.openai.com/api/docs/pricing
 *  - Google: https://ai.google.dev/gemini-api/docs/pricing (Gemini 2.5 Flash verified 2026-09-27)
 *  - Zhipu: https://docs.z.ai/guides/overview/pricing
 */
interface TableRow {
  prefix: string;
  exact?: boolean;
  /** Also required to match, after the prefix (e.g. a `-pro` suffix). */
  pattern?: RegExp;
  price: ModelPrice;
}

const TABLE: TableRow[] = [
  // ── Standard tier (free allowance) ─────────────────────────────────────────
  // Exact match: Flash-Lite, image, audio and preview variants have other rates.
  {
    prefix: "gemini-2.5-flash",
    exact: true,
    price: { ...rates(0.3, 2.5, 0.3, 0.03), tier: "standard" },
  },
  {
    prefix: "claude-haiku-5-5",
    exact: true,
    price: {
      ...anthropicRates(0.1, 0.5, 0.01),
      tier: "standard",
      longContext: { aboveInputTokens: 100_000, rates: anthropicRates(0.5, 2.5, 0.05) },
    },
  },
  {
    prefix: "gpt-6-luna",
    exact: true,
    price: {
      ...rates(0.1, 0.5, 0.1, 0.01),
      tier: "standard",
      longContext: openaiLong(0.2, 0.75, 0.02),
    },
  },
  {
    prefix: "glm-5.3-flash",
    exact: true,
    price: { ...rates(0.15, 0.5, 0.15, 0.03), tier: "standard" },
  },
  // GLM-4.6, the original free-window model (open.bigmodel.cn, 2026-07).
  { prefix: "glm-4.6", exact: true, price: { ...rates(0.6, 2.2, 0.6, 0.11), tier: "standard" } },
  { prefix: "chatglm-", price: { ...rates(0.6, 2.2, 0.6, 0.11), tier: "standard" } },
  // Any other GLM id is priced like the flagship GLM-5.3 and kept off the free allowance.
  { prefix: "glm-", price: { ...rates(1.4, 4.4, 1.4, 0.26), tier: "premium" } },

  // ── Anthropic — premium (paid balance only) ────────────────────────────────
  // Sonnet 5.5 and Opus 5.5 both read cache at $0.20/M.
  {
    prefix: "claude-sonnet-5-5",
    exact: true,
    price: { ...anthropicRates(2, 10, 0.2), tier: "premium" },
  },
  {
    prefix: "claude-opus-5-5",
    exact: true,
    price: { ...anthropicRates(4, 20, 0.2), tier: "premium" },
  },
  {
    prefix: "claude-fable-5-1",
    exact: true,
    price: { ...anthropicRates(10, 50, 0.25), tier: "premium" },
  },
  // Earlier generations (Haiku 4.5, Sonnet 4.x, Opus 4.x) at their own list prices.
  { prefix: "claude-haiku", price: { ...anthropicRates(1, 5, 0.1), tier: "premium" } },
  { prefix: "claude-sonnet", price: { ...anthropicRates(3, 15, 0.3), tier: "premium" } },
  { prefix: "claude-opus", price: { ...anthropicRates(5, 25, 0.5), tier: "premium" } },
  { prefix: "claude-", price: { ...anthropicRates(10, 50, 1), tier: "premium" } },

  // ── OpenAI — premium ───────────────────────────────────────────────────────
  // Each of these has a long-context rate above 272K prompt tokens.
  {
    prefix: "gpt-6.1-sol",
    exact: true,
    price: { ...rates(2, 10, 2, 0.1), tier: "premium", longContext: openaiLong(4, 15, 0.2) },
  },
  {
    prefix: "gpt-6.1-terra",
    exact: true,
    price: { ...rates(1, 5, 1, 0.05), tier: "premium", longContext: openaiLong(2, 7.5, 0.1) },
  },
  {
    prefix: "gpt-6-astra",
    exact: true,
    price: { ...rates(10, 50, 10, 1), tier: "premium", longContext: openaiLong(20, 75, 2) },
  },
  {
    prefix: "gpt-5.5",
    exact: true,
    price: { ...rates(5, 30, 5, 0.5), tier: "premium", longContext: openaiLong(10, 45, 1) },
  },
  // Pro models list no cached-input rate, so a cache read is priced as input.
  { prefix: "gpt-5.5-pro", exact: true, price: PRO_PRICE },
  { prefix: "gpt-5.4-pro", exact: true, price: PRO_PRICE },
  { prefix: "gpt-5.2-pro", exact: true, price: { ...rates(21, 168, 21, 21), tier: "premium" } },
  { prefix: "gpt-5-pro", exact: true, price: { ...rates(15, 120, 15, 15), tier: "premium" } },
  { prefix: "o3-pro", exact: true, price: { ...rates(20, 80, 20, 20), tier: "premium" } },
  // Any other OpenAI `-pro` id (a dated snapshot, a new release) at the dearest pro rate.
  { prefix: "gpt-", pattern: PRO_SUFFIX, price: PRO_PRICE },
  { prefix: "o", pattern: /^o\d.*-pro(-\d{4}-\d{2}-\d{2})?$/, price: PRO_PRICE },
  {
    prefix: "gpt-5.4-mini",
    exact: true,
    price: { ...rates(0.75, 4.5, 0.75, 0.075), tier: "premium" },
  },
  {
    prefix: "gpt-5.4-nano",
    exact: true,
    price: { ...rates(0.2, 1.25, 0.2, 0.02), tier: "premium" },
  },
  { prefix: "gpt-5-mini", exact: true, price: { ...rates(0.25, 2, 0.25, 0.025), tier: "premium" } },
  {
    prefix: "gpt-5-nano",
    exact: true,
    price: { ...rates(0.05, 0.4, 0.05, 0.005), tier: "premium" },
  },
  { prefix: "gpt-4o-mini", price: { ...rates(0.15, 0.6, 0.15, 0.075), tier: "premium" } },
  { prefix: "gpt-4o", price: { ...rates(2.5, 10, 2.5, 1.25), tier: "premium" } },
  // Any other GPT id: the dearest non-pro model (GPT-6 Astra), long context included.
  {
    prefix: "gpt-",
    price: { ...rates(10, 50, 10, 1), tier: "premium", longContext: openaiLong(20, 75, 2) },
  },
];

/**
 * Conservative fallback for unknown models: priced like the most expensive
 * non-pro model in the table (an OpenAI `-pro` id is caught by its own row) so
 * a gap can never hand out cheap inference; tier "premium" keeps it off the
 * free allowance.
 */
const FALLBACK: ModelPrice = {
  ...anthropicRates(10, 50, 1),
  tier: "premium",
  longContext: openaiLong(20, 75, 2),
};

/**
 * A model id in the one form the price table, the managed-key gate and the
 * gateway's Gemini route all use: trimmed, lower-case. A client sends this
 * form, so the model it checked is the model the gateway serves.
 */
export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * The table row that prices `model`, or null when no row matches and it would
 * be charged at the conservative fallback. Callers that must not serve or
 * route to a model LISA has no verified rate for (the gateway's Gemini face,
 * the model router in the hosted edition) check this instead of guessing.
 */
export function explicitPriceForModel(model: string): ModelPrice | null {
  const m = normalizeModelId(model);
  for (const { prefix, exact, pattern, price } of TABLE) {
    if ((exact ? m === prefix : m.startsWith(prefix)) && (!pattern || pattern.test(m)))
      return price;
  }
  return null;
}

/**
 * Model ids whose bill is not text tokens at the table's rates: audio,
 * realtime, transcription and speech models (audio tokens cost several times
 * text), and search models (which add a per-call search fee). The gateway
 * refuses them, and managed mode does not route to them.
 */
export function billsBeyondTextTokens(model: string): boolean {
  return /(^|[-_.])(audio|realtime|search|transcribe|tts)([-_.]|$)/.test(normalizeModelId(model));
}

export function priceForModel(model: string): ModelPrice {
  return explicitPriceForModel(model) ?? FALLBACK;
}

export function modelTier(model: string): ModelTier {
  return priceForModel(model).tier;
}

/** The rates that apply to one request's usage (prompt-size pricing included). */
export function ratesFor(price: ModelPrice, usage: ProviderUsage): TokenRates {
  const long = price.longContext;
  if (!long) return price;
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return prompt > long.aboveInputTokens ? long.rates : price;
}

/** Face cost of one usage sample, micro-USD (integer, rounded up ≥ 0). */
export function costMicroUSD(model: string, usage: ProviderUsage): number {
  const p = ratesFor(priceForModel(model), usage);
  // The 1-hour part of the cache writes (never more than all of them).
  const reported1h = usage.cacheWrite1hTokens;
  const write1h =
    typeof reported1h === "number" && Number.isFinite(reported1h) && reported1h > 0
      ? Math.min(reported1h, usage.cacheWriteTokens)
      : 0;
  const cost =
    (usage.inputTokens * p.inPerM +
      usage.outputTokens * p.outPerM +
      (usage.cacheWriteTokens - write1h) * p.cacheWritePerM +
      write1h * (p.cacheWrite1hPerM ?? p.cacheWritePerM) +
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
 * output, at the higher of the normal and long-context rates). Clamped to a
 * sane ceiling so a huge paid balance doesn't disable the breaker entirely.
 */
export function tokensAffordable(model: string, microUSD: number): number {
  const p = priceForModel(model);
  const outPerM = Math.max(p.outPerM, p.longContext?.rates.outPerM ?? 0);
  const tokens = Math.floor((microUSD / outPerM) * 1_000_000);
  return Math.max(1000, Math.min(tokens, 5_000_000));
}
