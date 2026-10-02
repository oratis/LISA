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
import { createTaskCardDeliver, type CardDeliverDeps } from "../tasks/delivery.js";
import type { ModelGate, TaskEngineEvent, TaskRunner, WatchCheck } from "../tasks/runner.js";
import { createTaskRunner, startTaskScheduler, type TaskSchedulerHandle } from "../tasks/scheduler.js";
import type { TaskNotice } from "../tasks/types.js";
import {
  getDefaultTaskDeliver,
  getTaskEventSink,
  setDefaultTaskDeliver,
  setTaskEventSink,
} from "../tasks/wiring.js";
import type { ToolDefinition } from "../types.js";
import { cloudTasksEnabled, handleTasksApi } from "./tasks-api.js";

export interface TaskHostOptions {
  cloud: boolean;
  /** Capability profile name for 403 bodies. */
  profile: string;
  /** Tools of the surface's autonomy profile (already cloud-filtered when hosted). */
  tools: ToolDefinition[];
  model: string;
  cwd: string;
  /** Tenant-aware SSE broadcast (origin defaults to the current home scope). */
  broadcast: (event: Record<string, unknown>) => void;
  /** Access to the current tenant's conversation, serialised with its chat turns. */
  withConversation: CardDeliverDeps["withConversation"];
  /** Optional push for delivered cards (Mac edition: the PushBridge idle path). */
  push?: (notice: TaskNotice, card: string) => void;
  /** Hosted edition: billing admission for the tenant's model calls. Required to run cloud tasks. */
  modelGateFor?: (uid: string) => ModelGate;
  checkWatch?: WatchCheck;
  log?: (msg: string) => void;
  /** Start the 30 s scheduler (Mac edition). Default: true when not hosted. */
  schedule?: boolean;
  /** Test override for LISA_CLOUD_TASKS. */
  cloudEnabled?: boolean;
}

export interface TaskHost {
  /** Route hook: resolves true when the request was a `/api/tasks*` one. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: string, uid: string | null): Promise<boolean>;
  /** The runner for a tenant (null uid = the Mac edition's single user). */
  runnerFor(uid: string | null): TaskRunner | null;
  stop(): Promise<void>;
}

export function createTaskHost(opts: TaskHostOptions): TaskHost {
  const cloudOn = opts.cloud && (opts.cloudEnabled ?? cloudTasksEnabled());
  const onEvent = (event: TaskEngineEvent): void => opts.broadcast({ ...event });

  const cardDeliver = createTaskCardDeliver({
    withConversation: opts.withConversation,
    broadcast: opts.broadcast,
    ...(opts.push ? { push: opts.push } : {}),
  });
  // The channel of last resort; a Reach-out gate installed with setTaskDeliver
  // takes precedence and may call this one to pass a notice through.
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
      ...(opts.log ? { log: opts.log } : {}),
      ...(uid && opts.modelGateFor ? { modelGate: opts.modelGateFor(uid) } : {}),
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
  const runnerFor = (uid: string | null): TaskRunner | null => {
    if (!opts.cloud) return local;
    // No admission wired ⇒ no cloud runs. Never an unmetered model call.
    if (!cloudOn || !uid || !opts.modelGateFor) return null;
    // A runner only ever works inside its tenant's home scope.
    if (scopedUid() !== uid) return null;
    let runner = tenants.get(uid);
    if (!runner) {
      runner = make(uid);
      tenants.set(uid, runner);
    }
    return runner;
  };

  return {
    handle: async (req, res, url, uid) => {
      // Cheap exit for the other few hundred routes this hook sits in front of.
      if (!url.startsWith("/api/tasks")) return false;
      return await handleTasksApi(req, res, url, {
        cloud: opts.cloud,
        profile: opts.profile,
        uid,
        runner: runnerFor(uid),
        emit: onEvent,
        ...(opts.cloudEnabled !== undefined ? { cloudEnabled: opts.cloudEnabled } : {}),
      });
    },
    runnerFor,
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
