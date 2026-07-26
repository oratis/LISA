/**
 * Append-only audit ledger for duration-priced media operations.
 */
import path from "node:path";
import { appendLine, atomicWrite, readTextOrEmpty } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import { billingDir } from "./meter.js";
import { globalSpendAdd } from "./limits.js";
import {
  MEDIA_PRICES_VERSION,
  mediaCostMicroUSD,
  type MediaUsage,
} from "./media-prices.js";

export interface MediaUsageRecord extends MediaUsage {
  at: string;
  source: string;
  microUSD: number;
  pricesVersion: number;
}

function mediaUsageFile(): string {
  return path.join(billingDir(), "media-usage.jsonl");
}

function mediaUsageLock(): string {
  return path.join(billingDir(), "media-usage.lock");
}

const MAX_LINES = 5000;

/**
 * Pricing and debit remain independent of the best-effort audit append, matching
 * the token meter's fail-closed economics.
 */
export async function recordMediaUsage(
  source: string,
  usage: MediaUsage,
  now: Date = new Date(),
): Promise<MediaUsageRecord> {
  const record: MediaUsageRecord = {
    at: now.toISOString(),
    source,
    ...usage,
    microUSD: mediaCostMicroUSD(usage),
    pricesVersion: MEDIA_PRICES_VERSION,
  };
  try {
    await appendLine(mediaUsageFile(), JSON.stringify(record));
    void trimIfNeeded();
  } catch (err) {
    console.error(
      `[billing] media usage audit append failed (operation still priced + debited): ${(err as Error).message}`,
    );
  }
  globalSpendAdd(record.microUSD, now.getTime());
  return record;
}

async function trimIfNeeded(): Promise<void> {
  try {
    const lines = (await readTextOrEmpty(mediaUsageFile())).split("\n").filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    await withFileLock(mediaUsageLock(), async () => {
      const current = (await readTextOrEmpty(mediaUsageFile())).split("\n").filter(Boolean);
      if (current.length <= MAX_LINES) return;
      await atomicWrite(mediaUsageFile(), current.slice(-MAX_LINES).join("\n") + "\n");
    });
  } catch {
    // Audit compaction is best-effort.
  }
}

export async function readMediaUsage(): Promise<MediaUsageRecord[]> {
  const text = await readTextOrEmpty(mediaUsageFile());
  const records: MediaUsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as MediaUsageRecord;
      if (
        typeof value.at === "string" &&
        typeof value.durationMs === "number" &&
        typeof value.microUSD === "number"
      ) {
        records.push(value);
      }
    } catch {
      // A corrupt audit line does not hide the rest of the ledger.
    }
  }
  return records;
}

export interface MediaUsageSummary {
  microUSD: number;
  durationMs: number;
  operations: number;
}

export async function summarizeMediaUsage(sinceMs: number): Promise<MediaUsageSummary> {
  const records = await readMediaUsage();
  const summary: MediaUsageSummary = { microUSD: 0, durationMs: 0, operations: 0 };
  for (const record of records) {
    const timestamp = Date.parse(record.at);
    if (!Number.isFinite(timestamp) || timestamp < sinceMs) continue;
    summary.microUSD += record.microUSD;
    summary.durationMs += record.durationMs;
    summary.operations += 1;
  }
  return summary;
}
