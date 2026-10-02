/**
 * Cost estimates and the per-run USD cap (plan W12, "预算与熔断").
 *
 * Everything here is derived from the one price table in
 * src/billing/prices.ts, so an estimate shown to a user and the debit that
 * later lands in their ledger are computed from the same numbers.
 *
 * Amounts are micro-USD integers (1e-6 USD), rounded UP: an estimate or a cap
 * check that rounds in the user's favour is one that can be exceeded.
 */
import {
  MARGIN,
  costMicroUSD,
  explicitPriceForModel,
  priceForModel,
} from "../billing/prices.js";
import type { ProviderUsage } from "../providers/types.js";

/**
 * Whose price an estimate quotes.
 *  - "billed":   the face price LISA debits for managed/cloud inference
 *                (provider list price × margin). The default — it is what the
 *                ledger will say.
 *  - "provider": the provider's own list price, for a user running on their
 *                own API key, who pays the provider directly.
 */
export type CostBasis = "billed" | "provider";

export interface RunCostEstimate {
  model: string;
  /** Estimated cost, micro-USD, rounded up. */
  microUSD: number;
  basis: CostBasis;
  /**
   * False when the model has no row in the price table: the conservative
   * fallback rate was used, so the figure is an upper bound, not a quote.
   */
  priced: boolean;
  /** True for a model served by a local runtime — no per-token charge at all. */
  local: boolean;
}

function assertCount(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number (got ${value})`);
  }
}

function isLocalModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("local://");
}

/**
 * Cost of one run from token counts.
 *
 * `inputTokens` is the uncached prompt, `cachedTokens` the part of the prompt
 * served from the provider's cache (priced at the cache-read rate) — the same
 * split the providers report and the meter bills.
 */
export function estimateRunCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number = 0,
  options: { basis?: CostBasis } = {},
): RunCostEstimate {
  assertCount("inputTokens", inputTokens);
  assertCount("outputTokens", outputTokens);
  assertCount("cachedTokens", cachedTokens);
  const basis = options.basis ?? "billed";
  if (isLocalModel(model)) {
    return { model, microUSD: 0, basis, priced: true, local: true };
  }
  const billed = costMicroUSD(model, {
    inputTokens,
    outputTokens,
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: 0,
  });
  return {
    model,
    microUSD: basis === "provider" ? Math.ceil(billed / MARGIN) : billed,
    basis,
    priced: explicitPriceForModel(model) !== null,
    local: false,
  };
}

function dollars(microUSD: number): string {
  return `$${(microUSD / 1_000_000).toFixed(2)}`;
}

/**
 * A short, honest label for a UI: "~$0.02", "<$0.01", "≤$0.42" when the model
 * is unpriced and the figure is only an upper bound, "$0.00 (local model)".
 * Accepts a bare micro-USD amount as well.
 */
export function formatCostEstimate(estimate: RunCostEstimate | number): string {
  const est: Pick<RunCostEstimate, "microUSD" | "priced" | "local"> =
    typeof estimate === "number"
      ? { microUSD: estimate, priced: true, local: false }
      : estimate;
  if (est.local) return "$0.00 (local model)";
  if (!Number.isFinite(est.microUSD) || est.microUSD < 0) return "unknown";
  if (est.microUSD === 0) return "$0.00";
  // Round UP to the cent so the label never understates.
  const cents = Math.ceil(est.microUSD / 10_000) * 10_000;
  if (est.microUSD < 10_000) return est.priced ? "<$0.01" : "≤$0.01";
  return `${est.priced ? "~" : "≤"}${dollars(cents)}`;
}

/** Average tokens of one routine run: a split, or a bare total. */
export type RoutineTokens =
  number | { inputTokens: number; outputTokens: number; cachedTokens?: number };

export interface RoutineCostEstimate {
  model: string;
  runsPerMonth: number;
  perRun: RunCostEstimate;
  /** perRun × runsPerMonth, micro-USD, rounded up. */
  monthlyMicroUSD: number;
}

/**
 * What a recurring routine costs per run and per month — the figure shown when
 * a routine is created ("~$0.02/run · ~$0.60/month").
 *
 * A bare token total is priced entirely at the OUTPUT rate: without a split
 * the only safe assumption is the expensive one (the same convention as
 * `tokensAffordable`). Pass a split for a tighter figure.
 */
export function estimateRoutineMonthlyCost(
  avgTokens: RoutineTokens,
  runsPerMonth: number,
  model: string,
  options: { basis?: CostBasis } = {},
): RoutineCostEstimate {
  assertCount("runsPerMonth", runsPerMonth);
  const perRun =
    typeof avgTokens === "number"
      ? estimateRunCost(model, 0, avgTokens, 0, options)
      : estimateRunCost(
          model,
          avgTokens.inputTokens,
          avgTokens.outputTokens,
          avgTokens.cachedTokens ?? 0,
          options,
        );
  return {
    model,
    runsPerMonth,
    perRun,
    monthlyMicroUSD: Math.ceil(perRun.microUSD * runsPerMonth),
  };
}

export function formatRoutineEstimate(estimate: RoutineCostEstimate): string {
  if (estimate.perRun.local) return "$0.00 (local model)";
  const monthly: RunCostEstimate = { ...estimate.perRun, microUSD: estimate.monthlyMicroUSD };
  return `${formatCostEstimate(estimate.perRun)}/run · ${formatCostEstimate(monthly)}/month`;
}

// ── Per-run hard cap ────────────────────────────────────────────────────────

/** Below this, a turn cannot say anything useful; stop instead of paying for a stub. */
export const MIN_USEFUL_OUTPUT_TOKENS = 256;

/**
 * Bytes per prompt token used for the pre-call reservation. Real tokenizers
 * average about 4 bytes per token on English and about 3 on CJK; assuming 3
 * over-reserves on most prompts, which is the direction a cap should err in.
 */
const RESERVE_BYTES_PER_TOKEN = 3;

/** Conservative token count for a prompt of `bytes` UTF-8 bytes. */
export function reservePromptTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / RESERVE_BYTES_PER_TOKEN);
}

export interface CostCapInput {
  model: string;
  /** The run's ceiling, micro-USD. */
  capMicroUSD: number;
  /** Usage already reported by the provider for this run. */
  spent: ProviderUsage;
  /** Conservative size of the NEXT request's prompt, in tokens. */
  nextPromptTokens: number;
  /** The output ceiling the caller would use without a cap. */
  maxTokens: number;
}

export type CostCapVerdict =
  | {
      proceed: true;
      /** Output ceiling for the next call — never above what the cap can still pay for. */
      maxTokens: number;
      spentMicroUSD: number;
    }
  | {
      proceed: false;
      reason: "invalid_cap" | "usage_unreadable" | "cap_reached" | "next_turn_unaffordable";
      spentMicroUSD: number;
      message: string;
    };

/**
 * Decide, BEFORE a provider call, whether a capped run may make it.
 *
 * The next call is admitted only if its whole worst case fits under the cap:
 * the prompt at the dearer of the input and cache-write rates, plus as many
 * output tokens as the remainder buys — and the caller must pass the returned
 * `maxTokens` to the provider so the output side cannot exceed what was
 * reserved. With both in place a run cannot cross its cap by more than the
 * error of the prompt-size estimate.
 *
 * Fails closed: a cap that is not a positive finite number stops the run. An
 * unpriced model is reserved at the conservative fallback rate.
 */
export function checkCostCap(input: CostCapInput): CostCapVerdict {
  // costMicroUSD maps a non-finite token count to 0 (right for a ledger line,
  // wrong for a cap: it would read as "nothing spent"). Check first.
  const counts = [
    input.spent.inputTokens,
    input.spent.outputTokens,
    input.spent.cacheReadTokens,
    input.spent.cacheWriteTokens,
  ];
  if (counts.some((count) => typeof count !== "number" || !Number.isFinite(count) || count < 0)) {
    return {
      proceed: false,
      reason: "usage_unreadable",
      spentMicroUSD: 0,
      message: "cost cap: the run's token usage is not a readable number — stopping",
    };
  }
  const spentMicroUSD = costMicroUSD(input.model, input.spent);
  const cap = input.capMicroUSD;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
    return {
      proceed: false,
      reason: "invalid_cap",
      spentMicroUSD,
      message: `cost cap ${String(cap)} is not a positive amount — refusing to run uncapped`,
    };
  }
  if (spentMicroUSD >= cap) {
    return {
      proceed: false,
      reason: "cap_reached",
      spentMicroUSD,
      message: `cost cap ${dollars(cap)} reached (spent ${dollars(spentMicroUSD)})`,
    };
  }
  const price = priceForModel(input.model);
  const promptTokens = Number.isFinite(input.nextPromptTokens)
    ? Math.max(0, input.nextPromptTokens)
    : Number.POSITIVE_INFINITY;
  const promptReserve = Math.ceil(
    (promptTokens * Math.max(price.inPerM, price.cacheWritePerM)) / 1_000_000,
  );
  const remaining = cap - spentMicroUSD - promptReserve;
  const affordableOutput =
    remaining > 0 ? Math.floor((remaining * 1_000_000) / price.outPerM) : 0;
  if (!Number.isFinite(affordableOutput) || affordableOutput < MIN_USEFUL_OUTPUT_TOKENS) {
    return {
      proceed: false,
      reason: "next_turn_unaffordable",
      spentMicroUSD,
      message:
        `cost cap ${dollars(cap)}: spent ${dollars(spentMicroUSD)}, and the next turn ` +
        `(about ${Number.isFinite(promptTokens) ? promptTokens : "an unknown number of"} prompt ` +
        `tokens) does not fit in what is left`,
    };
  }
  const ceiling =
    Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? Math.floor(input.maxTokens)
      : affordableOutput;
  return { proceed: true, maxTokens: Math.min(ceiling, affordableOutput), spentMicroUSD };
}
