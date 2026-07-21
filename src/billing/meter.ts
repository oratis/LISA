/**
 * Usage meter — the per-user token/cost ledger
 * (docs/PLAN_ACCOUNTS_BILLING_v1.0.md §6.3, milestone B3).
 *
 * Every LLM turn appends one line to `<active home>/billing/usage.jsonl` —
 * inside a signed-in cloud request that's the user's subtree (B2 home scope),
 * on the Mac edition it's the local home. The JSONL is the AUDIT SOURCE; the
 * quota engine (B4) keeps a fast-path `balance.json` beside it that can always
 * be rebuilt from here.
 *
 * Same storage discipline as autonomy/runs.ts: append-only, bounded to
 * MAX_LINES with an opportunistic trim under a cross-process lock, and
 * recording NEVER throws (metering must not take chat down).
 */
import path from "node:path";
import { lisaHome } from "../paths.js";
import { appendLine, readTextOrEmpty, atomicWrite } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import type { ProviderUsage } from "../providers/types.js";
import { costMicroUSD, PRICES_VERSION } from "./prices.js";

export function billingDir(): string {
  return path.join(lisaHome(), "billing");
}
function usageFile(): string {
  return path.join(billingDir(), "usage.jsonl");
}
function usageLock(): string {
  return path.join(billingDir(), "usage.lock");
}

const MAX_LINES = 5000;

/** One metered LLM turn. */
export interface UsageRecord {
  /** ISO 8601. */
  at: string;
  /** What drove the turn ("chat" today; "gw" for the B6 gateway, etc.). */
  source: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Face cost, micro-USD, priced by prices.ts at PRICES_VERSION. */
  microUSD: number;
  pricesVersion: number;
}

/**
 * Append one usage line for the ACTIVE home (call inside the request's home
 * scope). Returns the priced record (or null when recording failed) — the
 * quota engine consumes the returned cost.
 */
export async function recordUsage(
  source: string,
  model: string,
  usage: ProviderUsage,
  now: Date = new Date(),
): Promise<UsageRecord | null> {
  const rec: UsageRecord = {
    at: now.toISOString(),
    source,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    microUSD: costMicroUSD(model, usage),
    pricesVersion: PRICES_VERSION,
  };
  try {
    await appendLine(usageFile(), JSON.stringify(rec));
    void trimIfNeeded();
    return rec;
  } catch (err) {
    console.error(`[billing] usage record failed: ${(err as Error).message}`);
    return null;
  }
}

async function trimIfNeeded(): Promise<void> {
  try {
    const text = await readTextOrEmpty(usageFile());
    const lines = text.split("\n").filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    await withFileLock(usageLock(), async () => {
      const fresh = (await readTextOrEmpty(usageFile())).split("\n").filter(Boolean);
      if (fresh.length <= MAX_LINES) return;
      await atomicWrite(usageFile(), fresh.slice(-MAX_LINES).join("\n") + "\n");
    });
  } catch {
    // trim is best-effort
  }
}

/** Read the ledger (oldest → newest). Tolerates a corrupt line. */
export async function readUsage(): Promise<UsageRecord[]> {
  const text = await readTextOrEmpty(usageFile());
  const out: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as UsageRecord;
      if (typeof rec.at === "string" && typeof rec.microUSD === "number") out.push(rec);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export interface UsageSummary {
  /** Face micro-USD spent inside the window. */
  microUSD: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/** Aggregate the ledger over [since, now]. */
export async function summarizeUsage(sinceMs: number): Promise<UsageSummary> {
  const rows = await readUsage();
  const out: UsageSummary = { microUSD: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
  for (const r of rows) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    out.microUSD += r.microUSD;
    out.inputTokens += r.inputTokens;
    out.outputTokens += r.outputTokens;
    out.turns += 1;
  }
  return out;
}
