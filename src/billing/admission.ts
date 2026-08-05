/**
 * One admission boundary for every account-funded inference request.
 *
 * The caller parses and validates the protocol body first, then this module
 * applies abuse limits, serializes the tenant across instances, checks quota,
 * and returns an idempotently releasable permit for the lifetime of the turn.
 */
import type { AccountRecord } from "../web/accounts.js";
import { preflightLimits, type LimitVerdict } from "./limits.js";
import { debitTurn, precheckTurn, type PrecheckResult } from "./quota.js";
import { recordUsage, type UsageRecord } from "./meter.js";
import type { ProviderUsage } from "../providers/types.js";
import {
  acquireTurnLease,
  releaseTurnLease,
  startLeaseRenewal,
  type TurnLease,
} from "../cloud/turn-lease.js";

export interface InferencePermit {
  budgetMicroUSD: number;
  /** Price, audit and debit this permit's aggregated provider usage once. */
  settle(source: string, usage: ProviderUsage): Promise<UsageRecord>;
  release(): Promise<void>;
}

export type InferenceAdmission =
  | { ok: true; permit: InferencePermit }
  | { ok: false; status: number; body: Record<string, unknown> };

export interface AdmissionDependencies {
  preflight(uid: string): LimitVerdict;
  precheck(acct: AccountRecord, model: string): Promise<PrecheckResult>;
  acquire(uid: string): Promise<TurnLease | null>;
  startRenewal(lease: TurnLease): () => void;
  releaseLease(lease: TurnLease): Promise<void>;
  settle(
    acct: AccountRecord,
    source: string,
    model: string,
    usage: ProviderUsage,
  ): Promise<UsageRecord>;
}

const DEFAULT_DEPS: AdmissionDependencies = {
  preflight: preflightLimits,
  precheck: precheckTurn,
  acquire: acquireTurnLease,
  startRenewal: startLeaseRenewal,
  releaseLease: releaseTurnLease,
  settle: async (acct, source, model, usage) => {
    const record = await recordUsage(source, model, usage);
    await debitTurn(acct, model, record.microUSD);
    return record;
  },
};

function quotaRejection(pre: Exclude<PrecheckResult, { ok: true }>): InferenceAdmission {
  return {
    ok: false,
    status: 402,
    body:
      pre.error === "quota_exhausted"
        ? { error: pre.error, resetAt: pre.resetAt, tier: pre.tier }
        : { error: pre.error, tier: pre.tier },
  };
}

/**
 * Admit one account-funded turn. A successful caller MUST release the returned
 * permit in a finally block; release is safe to call more than once.
 */
export async function admitInference(
  acct: AccountRecord,
  model: string,
  deps: AdmissionDependencies = DEFAULT_DEPS,
): Promise<InferenceAdmission> {
  const limits = deps.preflight(acct.uid);
  if (!limits.ok) return limits;

  const lease = await deps.acquire(acct.uid);
  if (lease === null) {
    return {
      ok: false,
      status: 429,
      body: { error: "turn_in_progress", retryAfterSec: 15 },
    };
  }

  let released = false;
  let settlement: Promise<UsageRecord> | null = null;
  let stopRenewal: () => void = () => {};
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    stopRenewal();
    await deps.releaseLease(lease);
  };

  try {
    const pre = await deps.precheck(acct, model);
    if (!pre.ok) {
      await release();
      return quotaRejection(pre);
    }
    stopRenewal = deps.startRenewal(lease);
    return {
      ok: true,
      permit: {
        budgetMicroUSD: pre.budgetMicroUSD,
        settle: (source, usage) => {
          settlement ??= deps.settle(acct, source, model, usage);
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
