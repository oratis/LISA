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
import { globalSpendAdd } from "./limits.js";

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
 * Price one metered turn for the ACTIVE home (call inside the request's home
 * scope) and append it to the audit ledger. ALWAYS returns the priced record —
 * the quota engine consumes `microUSD` and MUST debit it regardless of whether
 * the audit line landed.
 *
 * The price is computed independently of the append (#264): a full disk
 * (ENOSPC/EDQUOT) or fd exhaustion (EMFILE) on the local usage.jsonl must lose
 * at most the audit line, never the debit — otherwise the turn ships free and
 * the spend is unrecoverable. In the cloud the authoritative balance ledger
 * lives in Firestore, so a local-FS append failure never blocks the debit.
 * Never throws (metering must not take chat down).
 */
export async function recordUsage(
  source: string,
  model: string,
  usage: ProviderUsage,
  now: Date = new Date(),
): Promise<UsageRecord> {
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
  // Audit-log append is best-effort and DECOUPLED from pricing/debit.
  try {
    await appendLine(usageFile(), JSON.stringify(rec));
    void trimIfNeeded();
  } catch (err) {
    console.error(`[billing] usage audit append failed (turn still priced + debited): ${(err as Error).message}`);
  }
  // Global daily cap accounting + anomaly alert (B7). Best-effort, and run
  // whether or not the audit line landed.
  globalSpendAdd(rec.microUSD, now.getTime());
  void alertIfAnomalous(now);
  return rec;
}

// One alert per home per process-day: a single account burning > $10 face in a
// day is worth an operator's eyes (PLAN §6.5).
const ALERT_THRESHOLD_MICRO = 10_000_000;
const alerted = new Set<string>();

/** Where anomaly alerts go besides the log (B8d: the server wires the push bridge). */
let anomalySink: ((text: string) => void) | null = null;
export function setAnomalySink(sink: ((text: string) => void) | null): void {
  anomalySink = sink;
}

async function alertIfAnomalous(now: Date): Promise<void> {
  try {
    const key = `${lisaHome()}:${now.toISOString().slice(0, 10)}`;
    if (alerted.has(key)) return;
    const today = await summarizeUsage(new Date(now).setUTCHours(0, 0, 0, 0));
    if (today.microUSD > ALERT_THRESHOLD_MICRO) {
      alerted.add(key);
      const text = `${lisaHome()} spent ${(today.microUSD / 1e6).toFixed(2)} USD face today (${today.turns} turns)`;
      console.error(`[billing] ⚠ anomaly: ${text}`);
      try {
        anomalySink?.(text);
      } catch {
        /* alerting must never break metering */
      }
    }
  } catch {
    /* observability only */
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
