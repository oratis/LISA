/**
 * Upstream usage blocks → `ProviderUsage`, in ONE place per wire format.
 *
 * `ProviderUsage` follows Anthropic's split: `inputTokens` is the UNCACHED
 * prompt and `cacheReadTokens` is counted beside it, never inside it. Pricing
 * (`costMicroUSD`) adds the two at their own rates, so a mapper that leaves the
 * cached prefix inside `inputTokens` bills it twice — once at the input rate
 * and again at the cache-read rate.
 *
 * OpenAI-compatible APIs report it the other way round: `prompt_tokens` is the
 * whole prompt and `prompt_tokens_details.cached_tokens` is the part of it that
 * was served from cache. The chat provider and the hosted gateway each had
 * their own copy of this conversion and only the gateway's subtracted, which is
 * why this is a shared function and not two more inline lines.
 */
import type { ProviderUsage } from "./types.js";

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** An OpenAI-compatible `usage` object (chat completions, streamed or not). */
export function openaiUsage(usage: unknown): ProviderUsage {
  const u = record(usage);
  const prompt = count(u.prompt_tokens);
  // Never more than the prompt it is part of: a provider that misreports must
  // not be able to drive the uncached count negative.
  const cached = Math.min(count(record(u.prompt_tokens_details).cached_tokens), prompt);
  return {
    inputTokens: prompt - cached,
    outputTokens: count(u.completion_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}
