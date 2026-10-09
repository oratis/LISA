/**
 * The Task Engine as the web server hosts it — kept out of server.ts so the
 * server's own diff is a construction, a route hook and a shutdown line.
 *
 *  Mac edition     one runner for the single user, ticked every 30 s; the
 *                  first tick resumes whatever a previous process left behind.
 *  Hosted edition  nothing unless LISA_CLOUD_TASKS=1. With it: one runner per
 *                  tenant, created on demand inside that tenant's home scope,
 *                  concurrency 1, every model call through billing admission,
 *                  driven by the sweep endpoint rather than a timer.
 */
import type http from "node:http";
import { scopedUid } from "../paths.js";
import { createReachOutTransports, type PushSink } from "../reachout/deliver.js";
import {
  createTaskCardDeliver,
  type CardDeliverDeps,
  type TaskReachOut,
} from "../tasks/delivery.js";
import type { ModelGate, TaskEngineEvent, TaskRunner, WatchCheck } from "../tasks/runner.js";
import {
  createTaskRunner,
  startTaskScheduler,
  type TaskSchedulerHandle,
} from "../tasks/scheduler.js";
import {
  getDefaultTaskDeliver,
  getTaskEventSink,
  setDefaultTaskDeliver,
  setTaskEventSink,
} from "../tasks/wiring.js";
import type { TaskApprovalFactory } from "../tasks/types.js";
import type { ToolDefinition } from "../types.js";
import { cloudTasksEnabled, handleTasksApi } from "./tasks-api.js";

export interface TaskHostOptions {
  cloud: boolean;
  /** Capability profile name for 403 bodies. */
  profile: string;
  /** Tools of the surface's autonomy profile (already cloud-filtered when hosted). */
  tools: ToolDefinition[];
  model: string | (() => string);
  cwd: string;
  /** Tenant-aware SSE broadcast (origin defaults to the current home scope). */
  broadcast: (event: Record<string, unknown>, origin?: string | null) => void;
  /** Access to the current tenant's conversation, serialised with its chat turns. */
  withConversation: CardDeliverDeps["withConversation"];
  /**
   * The server's reach-out gate (reachout-wiring.ts `makeServerReachOut`).
   * Every task result is delivered through it — never around it.
   */
  reachOut: TaskReachOut;
  /** The machine-level push channel (PushBridge). The gate decides if and when it fires. */
  pushSink?: PushSink;
  /** Keep a delivered note as the current tenant's "latest note" (the island's unread state). */
  rememberNote?: (note: { text: string; at: string }) => void | Promise<void>;
  /**
   * Hosted edition: the server's account-work registry (the one account
   * deletion stops and waits on). Every tenant run registers through it.
   */
  trackWork?: (uid: string, stop: () => void) => (() => void) | null;
  /** Hosted edition: billing admission for the tenant's model calls. Required to run cloud tasks. */
  modelGateFor?: (uid: string) => ModelGate;
  checkWatch?: WatchCheck;
  /**
   * The approval gate for unattended runs: Warden's task factory when the
   * server runs in Warden mode, otherwise unset — and then a run may make only
   * the verified read-only calls of src/tasks/policy.ts.
   */
  approvalFactory?: TaskApprovalFactory;
  log?: (msg: string) => void;
  /** Start the 30 s scheduler (Mac edition). Default: true when not hosted. */
  schedule?: boolean;
  /** Test override for LISA_CLOUD_TASKS. */
  cloudEnabled?: boolean;
}

export interface TaskHost {
  /**
   * Route hook: resolves true when the request was a `/api/tasks*` one.
   * `trust` is who the caller is (warden-api.ts `wardenTrust`): only a caller
   * who may approve can confirm what a task does without asking.
   */
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    uid: string | null,
    trust?: { allowApproval: boolean; loopbackTrust: boolean },
  ): Promise<boolean>;
  /** The runner for a tenant (null uid = the Mac edition's single user). */
  runnerFor(uid: string | null): TaskRunner | null;
  /** Account deletion: stop the tenant's runs and drop its runner. Resolves when they have ended. */
  forgetTenant(uid: string): Promise<void>;
  stop(): Promise<void>;
}

export function createTaskHost(opts: TaskHostOptions): TaskHost {
  const cloudOn = opts.cloud && (opts.cloudEnabled ?? cloudTasksEnabled());
  const onEvent = (event: TaskEngineEvent): void => opts.broadcast({ ...event });

  const cardDeliver = createTaskCardDeliver({
    reachOut: opts.reachOut,
    withConversation: opts.withConversation,
    broadcast: (event) => opts.broadcast(event),
    // The gate's generic transports: the standard in-app note event (+ the
    // tenant's latest-note memory) and the push. Which of them fire, and when,
    // is the gate's decision.
    transports: createReachOutTransports({
      inapp: {
        emit: (event, uid) => opts.broadcast(event, uid),
        ...(opts.rememberNote ? { remember: (note) => opts.rememberNote!(note) } : {}),
      },
      ...(opts.pushSink ? { push: opts.pushSink } : {}),
    }),
  });
  // The default delivery. A deliver installed with setTaskDeliver takes
  // precedence (and may call this one to pass a notice through).
  setDefaultTaskDeliver(cardDeliver);
  // Changes the model makes through its task tools reach open clients too.
  setTaskEventSink(onEvent);

  const make = (uid: string | null): TaskRunner =>
    createTaskRunner({
      tools: opts.tools,
      model: opts.model,
      cwd: opts.cwd,
      host: opts.cloud ? "cloud" : "home",
      onEvent,
      ...(opts.checkWatch ? { checkWatch: opts.checkWatch } : {}),
      ...(opts.approvalFactory ? { approvalFactory: opts.approvalFactory } : {}),
      ...(opts.log ? { log: opts.log } : {}),
      ...(uid && opts.modelGateFor ? { modelGate: opts.modelGateFor(uid) } : {}),
      ...(uid && opts.trackWork
        ? { trackRun: (stop: () => void) => opts.trackWork!(uid, stop) }
        : {}),
    });

  let local: TaskRunner | null = null;
  let scheduler: TaskSchedulerHandle | null = null;
  if (!opts.cloud) {
    local = make(null);
    if (opts.schedule ?? true) {
      scheduler = startTaskScheduler(local, { ...(opts.log ? { log: opts.log } : {}) });
    }
  }

  // Hosted: one runner per tenant, kept while the process lives so cancel can
  // reach a run started by an earlier request or sweep.
  const tenants = new Map<string, TaskRunner>();
  // Bounded (INVARIANTS 身份 2): past the cap, the longest-idle runner with
  // nothing in flight is dropped. A runner holds no state that is not on disk.
  const MAX_TENANT_RUNNERS = 256;
  const runnerFor = (uid: string | null): TaskRunner | null => {
    if (!opts.cloud) return local;
    // No admission wired ⇒ no cloud runs. Never an unmetered model call.
    if (!cloudOn || !uid || !opts.modelGateFor) return null;
    // A runner only ever works inside its tenant's home scope.
    if (scopedUid() !== uid) return null;
    let runner = tenants.get(uid);
    if (runner) {
      tenants.delete(uid); // re-insert: Map order doubles as recency
    } else {
      runner = make(uid);
      if (tenants.size >= MAX_TENANT_RUNNERS) {
        for (const [other, idle] of tenants) {
          if (idle.activeCount === 0) {
            tenants.delete(other);
            break;
          }
        }
        // Every cached runner is busy: never grow beyond the tenant cap.
        // The caller gets no runner and may retry after one becomes idle.
        if (tenants.size >= MAX_TENANT_RUNNERS) return null;
      }
    }
    tenants.set(uid, runner);
    return runner;
  };

  return {
    handle: async (req, res, url, uid, trust) => {
      // Cheap exit for the other few hundred routes this hook sits in front of.
      if (!url.startsWith("/api/tasks")) return false;
      return await handleTasksApi(req, res, url, {
        cloud: opts.cloud,
        profile: opts.profile,
        uid,
        runner: runnerFor(uid),
        emit: onEvent,
        allowConfirm: trust?.allowApproval === true,
        loopbackTrust: trust?.loopbackTrust === true,
        ...(opts.cloudEnabled !== undefined ? { cloudEnabled: opts.cloudEnabled } : {}),
      });
    },
    runnerFor,
    forgetTenant: async (uid) => {
      const runner = tenants.get(uid);
      if (!runner) return;
      tenants.delete(uid);
      await runner.stop();
    },
    stop: async () => {
      if (getDefaultTaskDeliver() === cardDeliver) setDefaultTaskDeliver(undefined);
      if (getTaskEventSink() === onEvent) setTaskEventSink(undefined);
      await scheduler?.stop();
      await local?.stop();
      await Promise.all([...tenants.values()].map((r) => r.stop()));
      tenants.clear();
    },
  };
}
