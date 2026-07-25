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
import {
  runDesireReviewOnce,
  type DesireReviewRunResult,
} from "../heartbeat/runner.js";
import type { ToolDefinition } from "../types.js";

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
  action: "reflected" | "reviewed" | "skipped";
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

interface CloudSweepStamp {
  at: number;
  reflected?: {
    sessionId: string;
    userMessages: number;
  };
}

async function readStamp(): Promise<CloudSweepStamp> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(stampFile(), "utf8"),
    ) as Partial<CloudSweepStamp>;
    return {
      at: typeof parsed.at === "number" ? parsed.at : 0,
      reflected:
        parsed.reflected &&
        typeof parsed.reflected.sessionId === "string" &&
        typeof parsed.reflected.userMessages === "number"
          ? parsed.reflected
          : undefined,
    };
  } catch {
    return { at: 0 };
  }
}

async function writeStamp(stamp: CloudSweepStamp): Promise<void> {
  await fs.mkdir(path.dirname(stampFile()), { recursive: true });
  await fs.writeFile(stampFile(), JSON.stringify(stamp));
}

export function conversationNeedsReflection(
  cursor: CloudSweepStamp["reflected"],
  sessionId: string,
  userMessages: number,
): boolean {
  return (
    userMessages > 0 &&
    (!cursor ||
      cursor.sessionId !== sessionId ||
      userMessages > cursor.userMessages)
  );
}

/**
 * Walk recently-active accounts and give each due soul one reflection tick.
 * Every per-uid step runs inside that uid's home scope; one user's failure
 * never blocks the rest.
 */
export async function sweepUserAutonomy(
  opts: {
    model?: string;
    now?: number;
    maxRuns?: number;
    tools?: ToolDefinition[];
    cwd?: string;
    /** Test seam; production uses the bounded heartbeat implementation. */
    reviewFn?: typeof runDesireReviewOnce;
  } = {},
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
      sweepOne(acct, now, opts),
    );
    outcomes.push(outcome);
    if (outcome.action !== "skipped") ran++;
  }
  return { scanned: active.length, ran, outcomes };
}

async function sweepOne(
  acct: AccountRecord,
  now: number,
  opts: {
    model?: string;
    tools?: ToolDefinition[];
    cwd?: string;
    reviewFn?: typeof runDesireReviewOnce;
  },
): Promise<SweepOutcome> {
  try {
    if (!(await isBorn())) return { uid: acct.uid, action: "skipped", reason: "unborn" };
    const tier = tierFor(acct, await readBalance(), now);
    const interval = SWEEP_INTERVALS_MS[tier];
    const stamp = await readStamp();
    if (stamp.at && now - stamp.at < interval) {
      return { uid: acct.uid, action: "skipped", reason: "not_due" };
    }
    const sessions = await listSessionsOnDisk(); // newest first
    const latest = sessions[0];
    if (latest) {
      const { messages } = await loadSessionMessages(latest.id);
      const userMessages = messages.filter((message) => message.role === "user").length;
      if (
        messages.length >= 2 &&
        conversationNeedsReflection(
          stamp.reflected,
          latest.id,
          userMessages,
        )
      ) {
        const result = await reflectOnSession({
          history: messages,
          sessionId: latest.id,
          ...(opts.model ? { model: opts.model } : {}),
        });
        // Stamp AFTER success so a failed reflection retries on the next tick.
        await writeStamp({
          at: now,
          reflected: { sessionId: latest.id, userMessages },
        });
        // Meter the spend (S4 review): autonomy costs the USER nothing (no
        // debit), but face cost is audited and counted against the daily cap.
        if (result.usage) {
          await recordUsage(
            "autonomy",
            opts.model ?? DEFAULT_MODEL,
            result.usage,
          );
        }
        return { uid: acct.uid, action: "reflected" };
      }
    }

    // At most ONE inference action per account per sweep: new conversation
    // reflection wins; only an otherwise-idle cadence slot may review a desire.
    if (opts.tools) {
      const review = await (opts.reviewFn ?? runDesireReviewOnce)({
        tools: opts.tools,
        cwd: opts.cwd ?? process.cwd(),
        signal: new AbortController().signal,
        model: opts.model ?? DEFAULT_MODEL,
        now: new Date(now),
      });
      if (review) {
        await writeStamp({ at: now, reflected: stamp.reflected });
        await meterReview(opts.model ?? DEFAULT_MODEL, review);
        return { uid: acct.uid, action: "reviewed" };
      }
    }

    if (!latest) {
      return { uid: acct.uid, action: "skipped", reason: "no_sessions" };
    }
    if (latest.messageCount < 2) {
      return { uid: acct.uid, action: "skipped", reason: "too_short" };
    }
    return { uid: acct.uid, action: "skipped", reason: "no_new_content" };
  } catch (e) {
    return { uid: acct.uid, action: "skipped", reason: `error: ${(e as Error).message.slice(0, 120)}` };
  }
}

async function meterReview(
  model: string,
  review: DesireReviewRunResult,
): Promise<void> {
  await recordUsage("autonomy", model, {
    inputTokens: review.inputTokens,
    outputTokens: review.outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}
