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
import crypto from "node:crypto";
import { homeScope, homeForUid, lisaHome } from "../paths.js";
import { atomicWrite } from "../fs-utils.js";
import { loadAccounts, type AccountRecord } from "./accounts.js";
import { readBalance, tierFor, type QuotaTier } from "../billing/quota.js";
import { killSwitchOn, globalSpendExceeded } from "../billing/limits.js";
import { recordUsage } from "../billing/meter.js";
import {
  acquireLease,
  firestoreEnabled,
  releaseLease,
  type LeaseHandle,
} from "../cloud/firestore.js";
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
const SWEEP_LEASE_TTL_MS = 30 * 60 * 1000;
const SWEEP_OWNER = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const localSweepsInFlight = new Set<string>();

interface ReflectionCursor {
  sessionId: string;
  userMessages: number;
}

interface SweepCheckpoint {
  at: number;
  reflected?: ReflectionCursor;
  status?: "pending" | "completed";
  startedAt?: number;
  pendingAction?: "reflection" | "review";
}

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

async function readCheckpoint(): Promise<SweepCheckpoint | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(stampFile(), "utf8")) as SweepCheckpoint;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.at !== "number" ||
      !Number.isFinite(parsed.at) ||
      (parsed.reflected !== undefined &&
        (typeof parsed.reflected !== "object" ||
          typeof parsed.reflected.sessionId !== "string" ||
          !Number.isInteger(parsed.reflected.userMessages) ||
          parsed.reflected.userMessages < 0)) ||
      (parsed.status !== undefined && parsed.status !== "pending" && parsed.status !== "completed") ||
      (parsed.startedAt !== undefined &&
        (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt))) ||
      (parsed.pendingAction !== undefined &&
        parsed.pendingAction !== "reflection" &&
        parsed.pendingAction !== "review")
    ) {
      throw new Error("invalid autonomy checkpoint");
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeCheckpoint(checkpoint: SweepCheckpoint | null): Promise<void> {
  if (checkpoint) {
    await atomicWrite(stampFile(), JSON.stringify(checkpoint));
  } else {
    await fs.rm(stampFile(), { force: true });
  }
}

async function acquireSweepGuard(uid: string): Promise<{
  release: () => Promise<void>;
} | null> {
  if (localSweepsInFlight.has(uid)) return null;
  localSweepsInFlight.add(uid);
  let remote: LeaseHandle | null = null;
  try {
    if (firestoreEnabled()) {
      remote = await acquireLease(`autonomy-${uid}`, SWEEP_OWNER, SWEEP_LEASE_TTL_MS);
      if (!remote) {
        localSweepsInFlight.delete(uid);
        return null;
      }
    }
  } catch (err) {
    localSweepsInFlight.delete(uid);
    throw err;
  }
  return {
    release: async () => {
      try {
        if (remote) await releaseLease(remote);
      } finally {
        localSweepsInFlight.delete(uid);
      }
    },
  };
}

export function conversationNeedsReflection(
  cursor: ReflectionCursor | undefined,
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
    reflectFn?: typeof reflectOnSession;
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
    reflectFn?: typeof reflectOnSession;
    reviewFn?: typeof runDesireReviewOnce;
  },
): Promise<SweepOutcome> {
  const guard = await acquireSweepGuard(acct.uid);
  if (!guard) return { uid: acct.uid, action: "skipped", reason: "in_flight" };
  try {
    if (!(await isBorn())) return { uid: acct.uid, action: "skipped", reason: "unborn" };
    const tier = tierFor(acct, await readBalance(), now);
    const interval = SWEEP_INTERVALS_MS[tier];
    const checkpoint = await readCheckpoint();
    const pendingIsFresh =
      checkpoint?.status === "pending" &&
      typeof checkpoint.startedAt === "number" &&
      now - checkpoint.startedAt < SWEEP_LEASE_TTL_MS;
    if (pendingIsFresh) {
      return { uid: acct.uid, action: "skipped", reason: "in_flight" };
    }
    if (checkpoint?.status !== "pending" && checkpoint?.at && now - checkpoint.at < interval) {
      return { uid: acct.uid, action: "skipped", reason: "not_due" };
    }
    const sessions = await listSessionsOnDisk(); // newest first
    const latest = sessions[0];
    let latestMessageCount = 0;
    if (latest) {
      const { messages } = await loadSessionMessages(latest.id);
      latestMessageCount = messages.length;
      const userMessages = messages.filter((message) => message.role === "user").length;
      if (
        messages.length >= 2 &&
        conversationNeedsReflection(
          checkpoint?.reflected,
          latest.id,
          userMessages,
        )
      ) {
        await writeCheckpoint({
          at: checkpoint?.at ?? 0,
          reflected: checkpoint?.reflected,
          status: "pending",
          startedAt: now,
          pendingAction: "reflection",
        });
        let result: Awaited<ReturnType<typeof reflectOnSession>>;
        try {
          result = await (opts.reflectFn ?? reflectOnSession)({
            history: messages,
            sessionId: latest.id,
            ...(opts.model ? { model: opts.model } : {}),
          });
          await writeCheckpoint({
            at: now,
            reflected: { sessionId: latest.id, userMessages },
            status: "completed",
          });
        } catch (err) {
          // Ordinary failures retry on the next scheduler tick. A hard crash
          // leaves pending and waits for the lease TTL before recovery.
          await writeCheckpoint(checkpoint);
          throw err;
        }
        // Autonomy is free to the user, but its face cost stays audited and
        // contributes to the global daily cap.
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
      await writeCheckpoint({
        at: checkpoint?.at ?? 0,
        reflected: checkpoint?.reflected,
        status: "pending",
        startedAt: now,
        pendingAction: "review",
      });
      try {
        const review = await (opts.reviewFn ?? runDesireReviewOnce)({
          tools: opts.tools,
          cwd: opts.cwd ?? process.cwd(),
          signal: new AbortController().signal,
          model: opts.model ?? DEFAULT_MODEL,
          now: new Date(now),
        });
        if (review) {
          await writeCheckpoint({
            at: now,
            reflected: checkpoint?.reflected,
            status: "completed",
          });
          await meterReview(opts.model ?? DEFAULT_MODEL, review);
          return { uid: acct.uid, action: "reviewed" };
        }
        if (checkpoint?.status === "pending" && checkpoint.pendingAction === "review") {
          await writeCheckpoint({
            at: now,
            reflected: checkpoint.reflected,
            status: "completed",
          });
        } else {
          await writeCheckpoint(checkpoint);
        }
      } catch (err) {
        await writeCheckpoint(checkpoint);
        throw err;
      }
    }

    if (!latest) {
      return { uid: acct.uid, action: "skipped", reason: "no_sessions" };
    }
    if (latestMessageCount < 2) {
      return { uid: acct.uid, action: "skipped", reason: "too_short" };
    }
    return { uid: acct.uid, action: "skipped", reason: "unchanged" };
  } catch (e) {
    return { uid: acct.uid, action: "skipped", reason: `error: ${(e as Error).message.slice(0, 120)}` };
  } finally {
    await guard.release();
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
