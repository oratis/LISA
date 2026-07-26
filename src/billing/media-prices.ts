/**
 * Duration-priced provider media usage. Kept separate from token prices so an
 * audit never has to reinterpret seconds as synthetic tokens.
 */
import { MARGIN } from "./prices.js";

export const MEDIA_PRICES_VERSION = 1;

export type MediaProvider = "openai" | "elevenlabs";

export interface MediaUsage {
  provider: MediaProvider;
  model: string;
  durationMs: number;
}

/** Provider list USD/hour, verified against official pricing in 2026-07. */
const HOURLY_USD: Array<{ provider: MediaProvider; prefix: string; usd: number }> = [
  { provider: "elevenlabs", prefix: "scribe_v2", usd: 0.22 },
  { provider: "openai", prefix: "whisper-1", usd: 0.36 },
];

// Conservative fallback: the more expensive supported batch transcriber.
const FALLBACK_USD_PER_HOUR = 0.36;

export function mediaHourlyUSD(provider: MediaProvider, model: string): number {
  const normalized = model.trim().toLowerCase();
  return (
    HOURLY_USD.find(
      (entry) => entry.provider === provider && normalized.startsWith(entry.prefix),
    )?.usd ?? FALLBACK_USD_PER_HOUR
  );
}

/** Face cost for a duration-priced operation, integer micro-USD. */
export function mediaCostMicroUSD(usage: MediaUsage): number {
  if (!Number.isFinite(usage.durationMs) || usage.durationMs <= 0) return 0;
  const listMicroUSDPerHour = mediaHourlyUSD(usage.provider, usage.model) * 1_000_000;
  return Math.max(
    0,
    Math.ceil((usage.durationMs / 3_600_000) * listMicroUSDPerHour * MARGIN),
  );
}
