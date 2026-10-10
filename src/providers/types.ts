import type Anthropic from "@anthropic-ai/sdk";
import type { StoredMessage, ToolDefinition } from "../types.js";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderResult {
  content: Anthropic.ContentBlock[];
  stopReason: string;
  usage: ProviderUsage;
  /**
   * The model that actually served the call, when it can differ from the one
   * requested (a fallback chain sets it). Unset ⇒ the requested model.
   */
  model?: string;
}

export interface ProviderStreamHandlers {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
}

export interface ProviderRunOpts {
  model: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  messages: StoredMessage[];
  maxTokens?: number;
  thinking?: boolean;
  compaction?: boolean;
  /** Thinking-depth / token-spend lever (Anthropic `output_config.effort`).
   *  Omitted ⇒ API default ("high"). Subagents use "low" for cheap work. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  handlers?: ProviderStreamHandlers;
  signal?: AbortSignal;
  /**
   * Called by a layer that makes more than one attempt within this call — a
   * stream retry, the next link of a fallback chain — when an attempt has
   * FAILED after it was sent (so it may have been billed), before it makes
   * another. Return false to make no further attempt: the error surfaces.
   *
   * The agent loop's per-run cost cap counts each failed attempt here at what
   * the call was admitted with, and refuses one more it cannot afford. Each
   * failed attempt such a layer makes is reported here at most once, except
   * the one the call finally throws (the caller counts that one itself).
   * Retries made INSIDE a provider SDK (its own `maxRetries`) are invisible to
   * these layers and are never reported — part of the cap's residual bound
   * (docs/PROVIDERS.md).
   */
  onAttemptFailed?: (attempt: { model: string; error: unknown }) => boolean;
}

const NOT_SENT = Symbol.for("lisa.provider.notSent");

/**
 * Mark an error thrown BEFORE anything was sent to a model — a wrapper that
 * refused the call (a cancelled run, a spent budget, a busy admission). A cost
 * cap does not count such a call; every other error out of `runTurn` is
 * counted as a call that may have been billed.
 */
export function notSent<E extends Error>(err: E): E {
  Object.defineProperty(err, NOT_SENT, { value: true });
  return err;
}

export function wasNotSent(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as Record<symbol, unknown>)[NOT_SENT] === true
  );
}

/** Connection failures that happen before a request is on the wire. */
const UNSENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * Did this failed call certainly cost nothing? True only when nothing reached
 * a model: the call was refused before it was sent (`notSent`), the host could
 * not be reached at all, or the provider refused the request with an HTTP
 * status that means it did no work — a 4xx (bad request, auth, quota, rate
 * limit) or 503 / 529 (unavailable, overloaded). The SDKs' API errors carry
 * the status; providers do not bill a refused request.
 *
 * Everything else may have been billed, prompt and output, and a cost cap
 * counts it as such: a cut stream, a timeout, a reset connection, an error
 * raised after the response began, an abort, a 500 / 502 / 504 (a proxy or
 * gateway can fail after the model did the work — LISA's own gateway bills a
 * failed upstream read at its byte floor), an error of unknown shape.
 */
export function failedWithoutSpend(err: unknown): boolean {
  if (wasNotSent(err)) return true;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; code?: unknown; cause?: { code?: unknown } };
  if (typeof e.status === "number") {
    if ((e.status >= 400 && e.status <= 499) || e.status === 503 || e.status === 529) return true;
  }
  const code = typeof e.cause?.code === "string" ? e.cause.code : e.code;
  return typeof code === "string" && UNSENT_CODES.has(code);
}

export interface Provider {
  readonly name: string;
  /**
   * Every model a call may be served by, for a provider that can answer with
   * a model other than the requested one (a fallback chain). Unset ⇒ only the
   * requested model. The cost cap reserves for the dearest of them.
   */
  readonly models?: readonly string[];
  runTurn(opts: ProviderRunOpts): Promise<ProviderResult>;
}
