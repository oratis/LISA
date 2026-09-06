/**
 * Account admission for duration-priced media provider calls.
 */
import type { AccountRecord } from "../web/accounts.js";
import type { MediaUsage } from "./media-prices.js";
import { recordMediaUsage, type MediaUsageRecord } from "./media-meter.js";
import { preflightLimits, type LimitVerdict } from "./limits.js";
import { precheckTurn, type PrecheckResult } from "./quota.js";
import { settleUsage } from "./outbox.js";
import {
  acquireTurnLease,
  releaseTurnLease,
  startLeaseRenewal,
  type TurnLease,
} from "../cloud/turn-lease.js";
import crypto from "node:crypto";

/** Unknown models are premium in quota.ts: media never consumes free LLM credit. */
export const MEDIA_BILLING_MODEL = "media/voice-transcription";

export interface MediaPermit {
  /** Ties this turn's usage outbox event back to the admission that ran it (T-8). */
  reservationId: string;
  settle(source: string, usage: MediaUsage): Promise<MediaUsageRecord>;
  release(): Promise<void>;
}

export type MediaAdmission =
  | { ok: true; permit: MediaPermit }
  | { ok: false; status: number; body: Record<string, unknown> };

export interface MediaAdmissionDependencies {
  limits(uid: string): LimitVerdict;
  precheck(acct: AccountRecord): Promise<PrecheckResult>;
  acquire(uid: string): Promise<TurnLease | null>;
  startRenewal(lease: TurnLease): () => void;
  releaseLease(lease: TurnLease): Promise<void>;
  settle(
    acct: AccountRecord,
    source: string,
    usage: MediaUsage,
    reservationId: string,
  ): Promise<MediaUsageRecord>;
}

const DEFAULT_DEPS: MediaAdmissionDependencies = {
  limits: preflightLimits,
  precheck: (acct) => precheckTurn(acct, MEDIA_BILLING_MODEL),
  acquire: acquireTurnLease,
  startRenewal: startLeaseRenewal,
  releaseLease: releaseTurnLease,
  // T-8: voice is a metered inference like any other, so it settles through
  // the durable outbox too. Duration-priced, hence no token counts.
  settle: async (acct, source, usage, reservationId) => {
    const record = await recordMediaUsage(source, usage);
    await settleUsage({
      acct,
      kind: source,
      model: MEDIA_BILLING_MODEL,
      costMicros: record.microUSD,
      reservationId,
    });
    return record;
  },
};

function quotaRejection(
  pre: Exclude<PrecheckResult, { ok: true }>,
): MediaAdmission {
  if (pre.error === "premium_requires_balance") {
    return { ok: false, status: 402, body: { error: pre.error, tier: pre.tier } };
  }
  return {
    ok: false,
    status: 402,
    body: { error: pre.error, resetAt: pre.resetAt, tier: pre.tier },
  };
}

export async function admitMedia(
  acct: AccountRecord,
  deps: MediaAdmissionDependencies = DEFAULT_DEPS,
): Promise<MediaAdmission> {
  const limits = deps.limits(acct.uid);
  if (!limits.ok) return limits;

  const lease = await deps.acquire(acct.uid);
  if (!lease) {
    return { ok: false, status: 429, body: { error: "turn_in_progress" } };
  }

  const reservationId = crypto.randomUUID();
  let released = false;
  let settlement: Promise<MediaUsageRecord> | null = null;
  let stopRenewal: () => void = () => {};
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    stopRenewal();
    await deps.releaseLease(lease);
  };

  try {
    const precheck = await deps.precheck(acct);
    if (!precheck.ok) {
      await release();
      return quotaRejection(precheck);
    }
    stopRenewal = deps.startRenewal(lease);
    return {
      ok: true,
      permit: {
        reservationId,
        settle: (source, usage) => {
          settlement ??= deps.settle(acct, source, usage, reservationId);
          return settlement;
        },
        release,
      },
    };
  } catch (err) {
    await release();
    throw err;
  }
}
