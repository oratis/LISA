/**
 * Per-uid autonomy sweep (S4) — the cloud edition's heartbeat substitute.
 *
 * On a Mac, Lisa's idle/reflect schedulers run because the process lives next
 * to its one user. On the cloud those schedulers only ever ticked the GLOBAL
 * scope — signed-in tenants' souls never reflected, never grew: the biggest
 * honest gap in "the full LISA on the web" (PLAN_WEB_SIGNUP §4.4/D5).
 *
 * This module walks recently-active accounts and, inside each uid's home
 * scope, runs one reflection over the user's latest session — the REVE-lite
 * tick. Cost is gated per account tier: autonomy cadence is a paid perk and
 * the cap on what a sweep may spend.
 *
 *   free / free-unverified   at most one reflection per 24h
 *   tier1 (≥$4.99/30d)       every 6h
 *   tier2 (≥$19.99/30d)      every 1h
 *
 * Driven by Cloud Scheduler → POST /internal/autonomy/sweep with the bearer
 * token in LISA_SWEEP_TOKEN (default-OFF without it). `maxRuns` bounds one
 * sweep's LLM spend; skipped users simply catch the next tick.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { homeScope, homeForUid, lisaHome } from "../paths.js";
import { loadAccounts, type AccountRecord } from "./accounts.js";
import { readBalance, tierFor, type QuotaTier } from "../billing/quota.js";
import { killSwitchOn, globalSpendExceeded } from "../billing/limits.js";
import { recordUsage } from "../billing/meter.js";
import { listSessionsOnDisk, loadSessionMessages } from "../sessions/list.js";
import { reflectOnSession } from "../reflect.js";
import { DEFAULT_MODEL } from "../llm.js";
import { isBorn } from "../soul/store.js";

const HOUR_MS = 60 * 60 * 1000;
export const SWEEP_INTERVALS_MS: Record<QuotaTier, number> = {
  free: 24 * HOUR_MS,
  "free-unverified": 24 * HOUR_MS,
  tier1: 6 * HOUR_MS,
  tier2: 1 * HOUR_MS,
};
const ACTIVE_WINDOW_MS = 7 * 24 * HOUR_MS;
// Hard ceiling on reflections per sweep — the caller's maxRuns is clamped to
// this so one tick can't spend the day's inference even if Cloud Scheduler is
// misconfigured with a huge value. (S4 review)
const MAX_SWEEP_RUNS = 100;

export interface SweepOutcome {
  uid: string;
  action: "reflected" | "skipped";
  reason?: string;
}

export interface SweepReport {
  scanned: number;
  ran: number;
  outcomes: SweepOutcome[];
}

/** The sweep endpoint's bearer secret. Null ⇒ the endpoint is off. */
export function sweepToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.LISA_SWEEP_TOKEN?.trim() || null;
}

function stampFile(): string {
  return path.join(lisaHome(), "autonomy", "last-cloud-sweep.json");
}

async function readStamp(): Promise<number> {
  try {
    const parsed = JSON.parse(await fs.readFile(stampFile(), "utf8")) as { at?: number };
    return typeof parsed.at === "number" ? parsed.at : 0;
  } catch {
    return 0;
  }
}

async function writeStamp(at: number): Promise<void> {
  await fs.mkdir(path.dirname(stampFile()), { recursive: true });
  await fs.writeFile(stampFile(), JSON.stringify({ at }));
}

/**
 * Walk recently-active accounts and give each due soul one reflection tick.
 * Every per-uid step runs inside that uid's home scope; one user's failure
 * never blocks the rest.
 */
export async function sweepUserAutonomy(
  opts: { model?: string; now?: number; maxRuns?: number } = {},
): Promise<SweepReport> {
  const now = opts.now ?? Date.now();
  // Clamp to a hard ceiling; NaN/negative collapse to the default. (S4 review)
  const requested = Number.isFinite(opts.maxRuns) ? (opts.maxRuns as number) : 20;
  const maxRuns = Math.max(0, Math.min(requested, MAX_SWEEP_RUNS));
  const accounts = await loadAccounts();
  const active = accounts.filter((a) => now - a.lastLoginAt <= ACTIVE_WINDOW_MS);
  const outcomes: SweepOutcome[] = [];
  let ran = 0;
  for (const acct of active) {
    if (ran >= maxRuns) {
      outcomes.push({ uid: acct.uid, action: "skipped", reason: "sweep_budget" });
      continue;
    }
    // Billing floor (S4 review): autonomy is a FREE perk, but it still bows to
    // the global kill switch (LISA_BILLING_KILL) and the $200/day cap. When
    // either trips, stop spending inference immediately — the next scheduled
    // tick resumes where this one left off.
    if (killSwitchOn() || globalSpendExceeded(now)) {
      outcomes.push({ uid: acct.uid, action: "skipped", reason: "service_paused" });
      break;
    }
    const outcome = await homeScope.run(homeForUid(acct.uid), () =>
      sweepOne(acct, now, opts.model),
    );
    outcomes.push(outcome);
    if (outcome.action === "reflected") ran++;
  }
  return { scanned: active.length, ran, outcomes };
}

async function sweepOne(acct: AccountRecord, now: number, model?: string): Promise<SweepOutcome> {
  try {
    if (!(await isBorn())) return { uid: acct.uid, action: "skipped", reason: "unborn" };
    const tier = tierFor(acct, await readBalance(), now);
    const interval = SWEEP_INTERVALS_MS[tier];
    const last = await readStamp();
    if (last && now - last < interval) {
      return { uid: acct.uid, action: "skipped", reason: "not_due" };
    }
    const sessions = await listSessionsOnDisk(); // newest first
    const latest = sessions[0];
    if (!latest) return { uid: acct.uid, action: "skipped", reason: "no_sessions" };
    const { messages } = await loadSessionMessages(latest.id);
    if (messages.length < 2) return { uid: acct.uid, action: "skipped", reason: "too_short" };
    const result = await reflectOnSession({ history: messages, sessionId: latest.id, ...(model ? { model } : {}) });
    // Stamp AFTER success so a failed reflection retries on the next tick.
    await writeStamp(now);
    // Meter the spend (S4 review): autonomy costs the USER nothing (no debit),
    // but the face cost is still audited (usage.jsonl) and counted against the
    // global daily cap so a large active cohort can't quietly run the bill away.
    // recordUsage runs inside this uid's home scope and never throws.
    if (result.usage) {
      await recordUsage("autonomy", model ?? DEFAULT_MODEL, result.usage);
    }
    return { uid: acct.uid, action: "reflected" };
  } catch (e) {
    return { uid: acct.uid, action: "skipped", reason: `error: ${(e as Error).message.slice(0, 120)}` };
  }
}
