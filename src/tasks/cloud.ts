/**
 * Cloud tasks — the engine per tenant on the hosted edition.
 *
 * OFF by default. Everything here is reachable only when the operator sets
 * LISA_CLOUD_TASKS=1 (web/tasks-api.ts answers 403 without it, and the web
 * host builds no runner).
 *
 * Two pieces:
 *
 *   cloudModelGate   the ModelGate a tenant's runner uses. Every model call of
 *                    a run goes through billing/admission.ts — the same
 *                    boundary a chat turn uses: abuse limits, the per-uid turn
 *                    lease, the quota precheck, then settlement of that call's
 *                    usage through the durable usage outbox. No allowance ⇒ the
 *                    call is refused and the run stops. There is no unmetered
 *                    path (INVARIANTS 计费 4).
 *
 *   sweepUserTasks   what the existing sweep endpoint calls: walk accounts
 *                    that have tasks, and inside each one's home scope run what
 *                    is due — one tenant at a time, one run at a time per
 *                    tenant, bounded per sweep.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { admitInference, type AdmissionDependencies } from "../billing/admission.js";
import { globalSpendExceeded, killSwitchOn } from "../billing/limits.js";
import { acquireLease, firestoreEnabled, releaseLease, type LeaseHandle } from "../cloud/firestore.js";
import { homeForUid, homeScope } from "../paths.js";
import { getAccount, loadAccounts, type AccountRecord } from "../web/accounts.js";
import type { ModelGate, TaskRunner } from "./runner.js";
import { runDueTasksOnce } from "./scheduler.js";

/** The usage-ledger source for task inference (alongside "chat", "gw", "autonomy"). */
export const TASK_USAGE_SOURCE = "task";

/**
 * Billing admission for one tenant's task runs. The account is re-read on
 * every call so a balance that ran out, a tier change or a deleted account is
 * honoured mid-run rather than at the next sweep.
 */
export function cloudModelGate(
  uid: string,
  opts: {
    deps?: AdmissionDependencies;
    lookup?: (uid: string) => Promise<AccountRecord | null>;
  } = {},
): ModelGate {
  const lookup = opts.lookup ?? getAccount;
  return {
    admit: async (model) => {
      const acct = await lookup(uid);
      if (!acct) return { ok: false, reason: "account_not_found" };
      const admission = opts.deps
        ? await admitInference(acct, model, opts.deps)
        : await admitInference(acct, model);
      if (!admission.ok) {
        const reason = typeof admission.body.error === "string" ? admission.body.error : `http_${admission.status}`;
        // 429 = this tenant is mid-turn or rate-limited: worth retrying later.
        // Anything else (402 quota / service paused) needs the user or operator.
        return { ok: false, reason, transient: admission.status === 429 };
      }
      const { permit } = admission;
      return {
        ok: true,
        settle: async (usage) => {
          await permit.settle(TASK_USAGE_SOURCE, usage);
        },
        release: () => permit.release(),
      };
    },
  };
}

// ── sweep ──

export interface TaskSweepOutcome {
  uid: string;
  started: number;
  skipped?: string;
}

export interface TaskSweepReport {
  scanned: number;
  ran: number;
  outcomes: TaskSweepOutcome[];
}

const SWEEP_LEASE_TTL_MS = 30 * 60_000;
const MAX_SWEEP_RUNS = 50;
const inFlight = new Set<string>();

async function hasTasks(uid: string): Promise<boolean> {
  try {
    const names = await fsp.readdir(path.join(homeForUid(uid), "tasks"));
    return names.some((n) => n.endsWith(".json"));
  } catch {
    return false;
  }
}

/**
 * Run due tasks for every tenant that has any. Never throws for one tenant's
 * failure; a billing kill switch or the daily spend cap stops the sweep.
 */
export async function sweepUserTasks(opts: {
  /** The tenant's runner (web/tasks-host.ts). Called inside the tenant's home scope. */
  runnerFor: (uid: string) => TaskRunner | null;
  /** Coordinate with account deletion. Null skips a deleting account. */
  beginAccountWork?: (uid: string) => (() => void) | null;
  /** Upper bound on runs started across the whole sweep. */
  maxRuns?: number;
  /** Wall-clock bound per tenant. */
  maxMsPerTenant?: number;
  now?: () => number;
  /** Test seams. */
  accounts?: () => Promise<Array<Pick<AccountRecord, "uid">>>;
  accountExists?: (uid: string) => Promise<boolean>;
  paused?: () => boolean;
}): Promise<TaskSweepReport> {
  const now = opts.now ?? Date.now;
  const requested = Number.isFinite(opts.maxRuns) ? (opts.maxRuns as number) : 20;
  const maxRuns = Math.max(0, Math.min(requested, MAX_SWEEP_RUNS));
  const paused = opts.paused ?? (() => killSwitchOn() || globalSpendExceeded(now()));
  const accounts = await (opts.accounts ?? loadAccounts)();
  const exists = opts.accountExists ?? (async (uid: string) => (await getAccount(uid)) !== null);
  const outcomes: TaskSweepOutcome[] = [];
  let ran = 0;
  let scanned = 0;

  for (const { uid } of accounts) {
    if (!(await hasTasks(uid))) continue;
    scanned++;
    if (ran >= maxRuns) {
      outcomes.push({ uid, started: 0, skipped: "sweep_budget" });
      continue;
    }
    if (paused()) {
      outcomes.push({ uid, started: 0, skipped: "service_paused" });
      break;
    }
    const finish = opts.beginAccountWork?.(uid);
    if (finish === null) {
      outcomes.push({ uid, started: 0, skipped: "account_deleting" });
      continue;
    }
    try {
      if (!(await exists(uid))) {
        outcomes.push({ uid, started: 0, skipped: "account_deleted" });
        continue;
      }
      // One sweep per tenant at a time: in this process, and — with Firestore —
      // across instances. The per-task file lease still guards each run.
      if (inFlight.has(uid)) {
        outcomes.push({ uid, started: 0, skipped: "in_flight" });
        continue;
      }
      inFlight.add(uid);
      let remote: LeaseHandle | null = null;
      try {
        if (firestoreEnabled()) {
          remote = await acquireLease(`tasks-${uid}`, `${process.pid}`, SWEEP_LEASE_TTL_MS);
          if (!remote) {
            outcomes.push({ uid, started: 0, skipped: "in_flight" });
            continue;
          }
        }
        const started = await homeScope.run(homeForUid(uid), async () => {
          const runner = opts.runnerFor(uid);
          if (!runner) return -1;
          const pass = await runDueTasksOnce(runner, {
            maxMs: opts.maxMsPerTenant ?? 10 * 60_000,
            now,
          });
          return pass.started.length;
        });
        if (started < 0) outcomes.push({ uid, started: 0, skipped: "no_runner" });
        else {
          outcomes.push({ uid, started });
          ran += started;
        }
      } catch (err) {
        outcomes.push({ uid, started: 0, skipped: `error: ${(err as Error).message.slice(0, 120)}` });
      } finally {
        if (remote) await releaseLease(remote).catch(() => {});
        inFlight.delete(uid);
      }
    } finally {
      finish?.();
    }
  }
  return { scanned, ran, outcomes };
}
