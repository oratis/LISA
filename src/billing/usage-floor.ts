/**
 * The byte-estimate usage floor (#264).
 *
 * A provider that answered but reported no usage would otherwise be billed —
 * or counted against a cap — as free. Both the inference gateway (debit) and
 * the per-run USD cap (src/model/cost.ts) fall back to this estimate.
 */
import type { ProviderUsage } from "../providers/types.js";

/** Bytes per token used only for the missing-usage floor. */
export const FLOOR_BYTES_PER_TOKEN = 4;

/**
 * Usage estimated from the bytes sent and received. A coarse bytes/4 estimate
 * is wrong in the user's favour on cache-heavy turns and in ours on nothing,
 * which is the right direction to be wrong in.
 */
export function estimateUsageFromBytes(requestBytes: number, responseBytes: number): ProviderUsage {
  return {
    inputTokens: Math.ceil(Math.max(0, requestBytes) / FLOOR_BYTES_PER_TOKEN),
    outputTokens: Math.ceil(Math.max(0, responseBytes) / FLOOR_BYTES_PER_TOKEN),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}
