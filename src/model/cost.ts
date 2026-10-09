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
  type ModelPrice,
} from "../billing/prices.js";
import type { ProviderUsage } from "../providers/types.js";
import { estimateUsageFromBytes } from "../billing/usage-floor.js";

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
   * fallback rate was used. It is an estimate, not a ceiling on provider charges.
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
 * A short UI label: "~$0.02", "<$0.01", or "$0.00 (local model)".
 * Unknown prices are explicitly marked as fallback estimates, never ceilings.
 * Accepts a bare micro-USD amount as well.
 */
export function formatCostEstimate(estimate: RunCostEstimate | number): string {
  const est: Pick<RunCostEstimate, "microUSD" | "priced" | "local"> =
    typeof estimate === "number" ? { microUSD: estimate, priced: true, local: false } : estimate;
  if (est.local) return "$0.00 (local model)";
  if (!Number.isFinite(est.microUSD) || est.microUSD < 0) return "unknown";
  if (!est.priced) return `${formatCostEstimate(est.microUSD)} (fallback rate; price unknown)`;
  if (est.microUSD === 0) return "$0.00";
  // Round UP to the cent so the label never understates.
  const cents = Math.ceil(est.microUSD / 10_000) * 10_000;
  if (est.microUSD < 10_000) return "<$0.01";
  return `~${dollars(cents)}`;
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

// ── Per-run estimated cost cap ────────────────────────────────────────────────────────

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

/**
 * Tokens a provider adds to every request that are not in its bytes: role and
 * turn markers, and the tool-use preamble (Anthropic documents 313–346 tokens
 * for it on current Claude models).
 */
export const PROMPT_FRAMING_TOKENS = 512;

function asciiDigits(text: string): number {
  let digits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 48 && code <= 57) digits++;
  }
  return digits;
}

/**
 * Conservative token count for prompt text, before framing. Every ASCII digit
 * counts as a token of its own: tokenizers split long numbers into one- to
 * three-digit tokens (Gemini's into single digits), and no token covers less
 * than a byte, so a digit-heavy tool result — logs, tables, IDs — can never be
 * under-counted. Every other three UTF-8 bytes count as one token.
 */
export function reservePromptTokensForText(parts: readonly string[]): number {
  let digits = 0;
  let bytes = 0;
  for (const part of parts) {
    digits += asciiDigits(part);
    bytes += Buffer.byteLength(part);
  }
  return digits + reservePromptTokens(bytes - digits);
}

/**
 * The model a call runs on — or, when it may be served by any of several (a
 * fallback chain), all of them: the cap then reserves and charges at the
 * dearest.
 */
export type CapModels = string | readonly string[];

function modelList(models: CapModels): readonly string[] {
  return typeof models === "string" ? [models] : models;
}

/** Each rate at its maximum over `models`: a reservation no serving model can exceed. */
function dearestRates(models: CapModels): ModelPrice {
  const prices = modelList(models).map((m) => priceForModel(m));
  if (prices.length === 0) return priceForModel("");
  const top = (rate: (p: ModelPrice) => number): number => Math.max(...prices.map(rate));
  return {
    inPerM: top((p) => p.inPerM),
    outPerM: top((p) => p.outPerM),
    cacheWritePerM: top((p) => p.cacheWritePerM),
    cacheReadPerM: top((p) => p.cacheReadPerM),
    tier: prices.some((p) => p.tier === "premium") ? "premium" : "standard",
  };
}

export interface CostCapInput {
  /** The model the next call runs on, or every model that may serve it. */
  model: CapModels;
  /** The run's ceiling, micro-USD. */
  capMicroUSD: number;
  /**
   * What the run has spent so far, micro-USD — the sum of `capChargeMicroUSD`
   * over its calls. Anything but a non-negative finite number (NaN after a
   * call whose usage could not be read) stops the run.
   */
  spentMicroUSD: number;
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

function unreadableCount(count: unknown): boolean {
  return typeof count !== "number" || !Number.isFinite(count) || count < 0;
}

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
 * Fails closed: a cap that is not a positive finite number stops the run, and
 * so does a spend that is not a readable amount. An unpriced model is reserved
 * at the conservative fallback rate; a call that several models may serve, at
 * the dearest rate among them.
 */
export function checkCostCap(input: CostCapInput): CostCapVerdict {
  // costMicroUSD maps a non-finite token count to 0 (right for a ledger line,
  // wrong for a cap: it would read as "nothing spent"), so capChargeMicroUSD
  // reports such a call as NaN, which lands here.
  if (unreadableCount(input.spentMicroUSD)) {
    return {
      proceed: false,
      reason: "usage_unreadable",
      spentMicroUSD: 0,
      message: "cost cap: the run's token usage is not a readable number — stopping",
    };
  }
  const spentMicroUSD = input.spentMicroUSD;
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
  const price = dearestRates(input.model);
  const promptTokens = Number.isFinite(input.nextPromptTokens)
    ? Math.max(0, input.nextPromptTokens)
    : Number.POSITIVE_INFINITY;
  const promptReserve = Math.ceil(
    (promptTokens * Math.max(price.inPerM, price.cacheWritePerM)) / 1_000_000,
  );
  const remaining = cap - spentMicroUSD - promptReserve;
  const affordableOutput = remaining > 0 ? Math.floor((remaining * 1_000_000) / price.outPerM) : 0;
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

/** One provider call, as the cap counts it. */
export interface CappedCall {
  /** The model that served the call; when that is not known, every model that may have. */
  model: CapModels;
  usage: ProviderUsage;
  /** UTF-8 bytes sent as the prompt (system prompt, tool definitions, transcript). */
  promptBytes: number;
  /** UTF-8 bytes of the output returned (0 for an empty answer). */
  outputBytes: number;
  /** What the call was admitted with: its prompt reservation and its output ceiling. */
  reservedPromptTokens: number;
  maxTokens: number;
}

/**
 * What one provider call counts against a run's cap, micro-USD.
 *
 * Normally the reported usage at the price table's rates. A zero that cannot
 * be true is read as "not reported", never as "free": every call sends a
 * prompt, and a call that returned output generated it. So when the provider
 * reports no prompt tokens, or no output tokens next to non-empty output (or
 * nothing at all — an OpenAI-compatible endpoint that ignores
 * `include_usage`), that side is charged what the call was admitted with —
 * the prompt tokens reserved for it, the output ceiling it was held to — and
 * never less than the gateway's byte floor (#264) for the bytes actually sent
 * and returned. Output falls back to its ceiling rather than its bytes because
 * thinking tokens are billed as output and never show up in the bytes.
 *
 * Priced at the model that served the call; given several, at the dearest.
 *
 * NaN when a reported count is not a non-negative finite number; checkCostCap
 * stops the run on it.
 */
export function capChargeMicroUSD(call: CappedCall): number {
  const { usage } = call;
  const counts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ];
  if (counts.some(unreadableCount)) return Number.NaN;
  const floor = estimateUsageFromBytes(call.promptBytes, call.outputBytes);
  const promptReported = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0;
  // Zero output is believable only for an empty answer from a provider that
  // did report its prompt.
  const outputReported = usage.outputTokens > 0 || (call.outputBytes === 0 && promptReported);
  const charged: ProviderUsage = {
    ...usage,
    inputTokens: promptReported
      ? usage.inputTokens
      : Math.max(call.reservedPromptTokens, floor.inputTokens),
    outputTokens: outputReported
      ? usage.outputTokens
      : Math.max(call.maxTokens, floor.outputTokens),
  };
  const models = modelList(call.model);
  if (models.length === 0) return costMicroUSD("", charged);
  return Math.max(...models.map((m) => costMicroUSD(m, charged)));
}

/** A call's worst case at the dearest rates: the prompt reservation plus the output ceiling. */
function reservationMicroUSD(models: CapModels, promptTokens: number, maxTokens: number): number {
  const price = dearestRates(models);
  return (
    Math.ceil((promptTokens * Math.max(price.inPerM, price.cacheWritePerM)) / 1_000_000) +
    Math.ceil((maxTokens * price.outPerM) / 1_000_000)
  );
}

function sameModel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The per-run cap's bookkeeping for the agent loop: `admit` before each
 * provider call, `charge` after it.
 *
 * `models` is every model a call may be served by — the requested model, plus
 * a fallback chain's links. Each call is reserved at the dearest of them and
 * charged at the one the provider says served it (the dearest when it does
 * not say, or names one outside the list).
 *
 * A call or an attempt that fails after it was sent — a cut stream, a stream
 * retry, a fallback link, a subagent's last call — is counted at its worst
 * case (`failedAttempt`, `chargeFailed`), and a further attempt is made only
 * if another worst case still fits. Only failures that certainly cost nothing
 * (`failedWithoutSpend`: refused before sending, unreachable host, 4xx / 503 /
 * 529) are not counted.
 *
 * This is an estimate-based circuit breaker, not a guaranteed billing ceiling.
 * Residual bound: every attempt is admitted against its worst case and every
 * failed one is counted at it, so a run's real spend exceeds the cap by at
 * most the amount by which its calls' real prompts exceed their reservations
 * (prompt tokenization — text denser than the 3-bytes-a-token estimate —
 * provider framing beyond PROMPT_FRAMING_TOKENS, images that cost more than
 * their per-image estimate), plus any output a provider produces beyond the
 * maxTokens it was given, plus any difference between the provider's prices
 * and the local table (unknown models use a fallback rate). Reconcile actual
 * usage in the billing layer.
 */
export class RunCostCap {
  private spent = 0;
  /**
   * The prompt size the provider last reported, and this cap's own estimate
   * of that same prompt: the next reservation is the reported size plus the
   * estimate for what was added since, so only new content is ever estimated.
   */
  private lastPromptTokens = 0;
  private lastPromptEstimate = 0;
  private admitted: {
    promptBytes: number;
    promptTokens: number;
    promptEstimate: number;
    maxTokens: number;
    /** The call's worst case: its prompt reservation plus its output ceiling, at the dearest rates. */
    reservationMicroUSD: number;
  } | null = null;

  private readonly models: readonly string[];

  /**
   * `onCharge` hears every amount as it is counted — this run's own calls and
   * whatever its subagents report — so a parent run can count it against its
   * own cap even if this run later throws.
   */
  constructor(
    readonly capMicroUSD: number,
    models: CapModels,
    private readonly onCharge?: (microUSD: number) => void,
  ) {
    this.models = modelList(models);
  }

  /** Micro-USD counted against the cap so far; NaN once a call's usage could not be read. */
  get spentMicroUSD(): number {
    return this.spent;
  }

  /** What is left to spend, micro-USD; 0 once the cap is spent or the spend is unreadable. */
  get remainingMicroUSD(): number {
    const left = this.capMicroUSD - this.spent;
    return Number.isFinite(left) && left > 0 ? left : 0;
  }

  /**
   * Count spend made outside this run's own provider calls — a subagent's —
   * against the cap. An amount that is not a non-negative finite number makes
   * the spend unreadable, which stops the run.
   */
  add(microUSD: number): void {
    const amount = unreadableCount(microUSD) ? Number.NaN : microUSD;
    this.count(amount);
  }

  /**
   * May the next call be made? `prompt` is everything it will send (system
   * prompt, tool definitions, transcript). On `proceed`, pass the verdict's
   * `maxTokens` to the provider.
   *
   * The prompt is reserved at the larger of the conservative estimate of the
   * whole of it (`reservePromptTokensForText` plus `PROMPT_FRAMING_TOKENS`)
   * and, once a provider has reported a prompt size, that size plus the
   * estimate for what was added since.
   */
  admit(next: { prompt: readonly string[]; maxTokens: number }): CostCapVerdict {
    const promptEstimate = reservePromptTokensForText(next.prompt);
    const promptBytes = next.prompt.reduce((sum, part) => sum + Buffer.byteLength(part), 0);
    const promptTokens = Math.max(
      promptEstimate + PROMPT_FRAMING_TOKENS,
      this.lastPromptTokens > 0
        ? this.lastPromptTokens + Math.max(0, promptEstimate - this.lastPromptEstimate)
        : 0,
    );
    const verdict = checkCostCap({
      model: this.models,
      capMicroUSD: this.capMicroUSD,
      spentMicroUSD: this.spent,
      nextPromptTokens: promptTokens,
      maxTokens: next.maxTokens,
    });
    this.admitted = verdict.proceed
      ? {
          promptBytes,
          promptTokens,
          promptEstimate,
          maxTokens: verdict.maxTokens,
          reservationMicroUSD: reservationMicroUSD(this.models, promptTokens, verdict.maxTokens),
        }
      : null;
    return verdict;
  }

  /**
   * An attempt of the admitted call FAILED after it was sent, and another is
   * about to be made (a stream retry, the next link of a fallback chain): see
   * ProviderRunOpts.onAttemptFailed. The provider may have billed its prompt
   * and any output before it failed, so it is counted at the call's worst
   * case — what it was admitted with. True when one more attempt at that
   * worst case still fits under the cap; false ends the call (the caller
   * surfaces the error, already counted).
   */
  failedAttempt(): boolean {
    const admitted = this.admitted;
    if (!admitted) return false;
    this.count(admitted.reservationMicroUSD);
    const fits =
      Number.isFinite(this.spent) && this.spent + admitted.reservationMicroUSD <= this.capMicroUSD;
    if (!fits) this.admitted = null;
    return fits;
  }

  /**
   * The admitted call threw after it was sent — a cut stream, a fallback chain
   * whose last link failed after output. Counted at its worst case, like a
   * failed attempt, and reported to `onCharge` so a parent run's cap counts it
   * too. Nothing when the call was already counted (a refused retry).
   */
  chargeFailed(): void {
    const admitted = this.admitted;
    if (!admitted) return;
    this.admitted = null;
    this.count(admitted.reservationMicroUSD);
  }

  /** The admitted call was never sent (refused before it left): nothing to count. */
  release(): void {
    this.admitted = null;
  }

  private count(microUSD: number): void {
    this.spent += microUSD;
    this.onCharge?.(microUSD);
  }

  /** Count the call made after `admit` against the cap; `model` is the one that served it, if known. */
  charge(call: { usage: ProviderUsage; output: readonly unknown[]; model?: string }): void {
    const admitted = this.admitted ?? {
      promptBytes: 0,
      promptTokens: 0,
      promptEstimate: 0,
      maxTokens: 0,
    };
    this.admitted = null;
    const served = call.model;
    const amount = capChargeMicroUSD({
      model:
        served === undefined
          ? this.models
          : this.models.some((m) => sameModel(m, served))
            ? served
            : [...this.models, served],
      usage: call.usage,
      promptBytes: admitted.promptBytes,
      outputBytes: call.output.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(call.output)),
      reservedPromptTokens: admitted.promptTokens,
      maxTokens: admitted.maxTokens,
    });
    this.count(amount);
    const { inputTokens, cacheReadTokens, cacheWriteTokens } = call.usage;
    const prompt = inputTokens + cacheReadTokens + cacheWriteTokens;
    if (Number.isFinite(prompt) && prompt > 0) {
      this.lastPromptTokens = prompt;
      this.lastPromptEstimate = admitted.promptEstimate;
    }
  }
}
