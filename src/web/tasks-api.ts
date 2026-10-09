/**
 * `/api/tasks*` — the Task Engine's HTTP surface (web shell, iOS, CLI-over-HTTP).
 *
 * The caller (server.ts) has already authenticated the request and entered the
 * account's home scope, so every store call below reads and writes that
 * tenant's `tasks/` directory and nothing else. There is no cross-tenant id
 * lookup to get wrong: a task id that belongs to someone else simply does not
 * exist in this scope.
 *
 * Hosted edition: the whole surface answers 403 `capability_denied` unless the
 * operator turned cloud tasks on (LISA_CLOUD_TASKS=1).
 *
 * Confirming an envelope (`PATCH {enabled: true, confirmEnvelope: <digest>}`)
 * is the step that lets a task act without asking, so it takes what answering
 * an approval takes: a caller who may approve and a same-origin request.
 * `GET /api/tasks/{id}` returns the digest and the plain-words summary a
 * client shows before asking the user.
 */
import type http from "node:http";
import { confirmationView, confirmTask, taskDigest } from "../tasks/confirmation.js";
import { disableTask, enableTask } from "../tasks/lifecycle.js";
import type { TaskEngineEvent, TaskRunner } from "../tasks/runner.js";
import { removeTask } from "../tasks/removal.js";
import { createTask, getTask, listRuns, listTasks, loadRun, updateTask } from "../tasks/store.js";
import { isSafeId, type Task, type TaskRun } from "../tasks/types.js";
import { applyTaskEdit, parseNewTask } from "../tasks/validate.js";
import { BodyTooLargeError, readCappedText } from "./http-body.js";
import { crossSiteProblem } from "./warden-api.js";

/** A task body is a title, an instruction and a few small specs — 64 KiB is generous. */
export const TASK_BODY_LIMIT = 64 * 1024;

/** Upper bound on tasks per tenant: a runaway client (or model) cannot fill the disk. */
export const MAX_TASKS = 200;

export function cloudTasksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LISA_CLOUD_TASKS === "1";
}

export interface TasksApiOptions {
  /** Hosted (multi-tenant) edition. */
  cloud: boolean;
  /** Capability profile name, echoed in the 403 body like every other denied route. */
  profile: string;
  /** The signed-in account, or null on the single-user Mac edition. */
  uid: string | null;
  /** The runner for THIS scope, used by run / cancel. Null ⇒ those answer 503. */
  runner: TaskRunner | null;
  /** Tenant-aware SSE fan-out for task_updated on API-made changes. */
  emit?: (event: TaskEngineEvent) => void;
  /** Override for tests; defaults to LISA_CLOUD_TASKS. */
  cloudEnabled?: boolean;
  /**
   * The caller may confirm what a task does without asking — the same people
   * who may answer a Warden approval (warden-api.ts `wardenTrust`): the
   * loopback owner on the Mac edition or a signed-in per-user session. Unset
   * ⇒ nobody may (a paired device can still switch a task on, unconfirmed).
   */
  allowConfirm?: boolean;
  /** The caller is trusted only because it connected from loopback (Host must then be loopback too). */
  loopbackTrust?: boolean;
  now?: () => number;
}

/**
 * A run as the API shows it. The exactly-once ledger holds the recorded
 * RESULTS of side-effecting calls — internal state, and potentially sensitive —
 * so only its size leaves the process.
 */
export function publicRun(
  run: TaskRun,
): Omit<TaskRun, "executedDigests" | "effects"> & { sideEffects: number } {
  const { executedDigests, effects, ...rest } = run;
  return {
    ...rest,
    sideEffects: effects ? effects.length : Object.keys(executedDigests ?? {}).length,
  };
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function bodyObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readCappedText(req, TASK_BODY_LIMIT);
  const parsed = JSON.parse(raw || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Handle `/api/tasks` routes. Resolves to false when the path is not ours.
 */
export async function handleTasksApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  opts: TasksApiOptions,
): Promise<boolean> {
  const pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
  if (pathname !== "/api/tasks" && !pathname.startsWith("/api/tasks/")) return false;

  if (opts.cloud && !(opts.cloudEnabled ?? cloudTasksEnabled())) {
    json(res, 403, { error: "capability_denied", profile: opts.profile });
    return true;
  }
  // A hosted request with no account has no tenant to scope to.
  if (opts.cloud && !opts.uid) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }

  const now = opts.now ?? Date.now;
  const ctx = { cloud: opts.cloud };
  const method = req.method ?? "GET";

  // CSRF guard, same rule as the server's readJsonBody: a cross-site page can
  // only send a "simple" POST (text/plain, form-encoded) without a preflight
  // this server never answers. Requiring application/json on every
  // state-changing POST/PATCH — including the body-less run / cancel — keeps a
  // web page the Mac owner happens to open from creating or starting a task on
  // the loopback API. (DELETE is never a simple request.)
  if (method === "POST" || method === "PATCH") {
    const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!ctype.includes("application/json")) {
      json(res, 415, { error: "unsupported_media_type" });
      return true;
    }
  }
  const parts = pathname.split("/").slice(3); // after /api/tasks
  const [id, sub, runId, extra] = parts;

  try {
    // ── collection ──
    if (parts.length === 0) {
      if (method === "GET") {
        json(res, 200, { tasks: await listTasks() });
        return true;
      }
      if (method === "POST") {
        const body = await bodyObject(req);
        if (body.confirmEnvelope !== undefined) {
          // The user confirms what they were shown: a task that exists, by its digest.
          json(res, 400, {
            error: "invalid_task",
            message: "confirmEnvelope is accepted by PATCH /api/tasks/{id} once the task exists",
          });
          return true;
        }
        const parsed = parseNewTask(body, { ...ctx, origin: { kind: "api" }, owner: opts.uid });
        if (!parsed.ok) {
          json(res, 400, { error: "invalid_task", message: parsed.error });
          return true;
        }
        if ((await listTasks()).length >= MAX_TASKS) {
          json(res, 409, { error: "task_limit", message: `at most ${MAX_TASKS} tasks` });
          return true;
        }
        let task = await createTask(parsed.value, now());
        // The API is the user's own hand: it may create a task already enabled
        // (unconfirmed: its envelope only restricts until a PATCH confirms it).
        if (body.enabled === true) {
          task = (await updateTask(task.id, (t) => enableTask(t, now()), now())) ?? task;
        }
        opts.emit?.({ type: "task_updated", task });
        json(res, 201, { task });
        return true;
      }
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }

    if (!isSafeId(id) || extra !== undefined) {
      json(res, 404, { error: "not_found" });
      return true;
    }

    // ── one task ──
    if (sub === undefined) {
      if (method === "GET") {
        const task = await getTask(id);
        if (task) json(res, 200, { task, confirmation: confirmationView(task) });
        else json(res, 404, { error: "not_found" });
        return true;
      }
      if (method === "PATCH") {
        const { confirmEnvelope, ...body } = await bodyObject(req);
        if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
          json(res, 400, { error: "invalid_task", message: "enabled must be a boolean" });
          return true;
        }
        if (confirmEnvelope !== undefined) {
          if (typeof confirmEnvelope !== "string" || body.enabled !== true) {
            json(res, 400, {
              error: "invalid_task",
              message: "confirmEnvelope is a digest string, sent with enabled: true",
            });
            return true;
          }
          if (!opts.allowConfirm) {
            json(res, 403, { error: "trusted_local_confirmation_required" });
            return true;
          }
          const crossSite = crossSiteProblem(req, opts.loopbackTrust === true);
          if (crossSite) {
            json(res, 403, { error: crossSite });
            return true;
          }
        }
        let problem: string | null = null;
        let mismatch = false;
        const task = await updateTask(
          id,
          (t) => {
            problem = applyTaskEdit(t, body, ctx);
            if (problem) return false;
            // The digest names the task as the user saw it — after this
            // request's own edits. Anything else confirms nothing and changes
            // nothing.
            if (confirmEnvelope !== undefined && taskDigest(t) !== confirmEnvelope) {
              mismatch = true;
              return false;
            }
            const rescheduled = body.schedule !== undefined || body.trigger !== undefined;
            if (body.enabled === true && (!t.enabled || rescheduled || t.state === "paused")) {
              enableTask(t, now());
            } else if (body.enabled === false && (t.enabled || t.pausedReason !== undefined)) {
              // Also an engine-paused task: switching it off is the user's own act now.
              disableTask(t);
            }
            // An edited schedule on an enabled task takes effect at once.
            else if (rescheduled && t.enabled) enableTask(t, now());
            if (confirmEnvelope !== undefined) confirmTask(t, now(), "api");
            return;
          },
          now(),
        );
        if (!task) json(res, 404, { error: "not_found" });
        else if (problem) json(res, 400, { error: "invalid_task", message: problem });
        else if (mismatch) {
          json(res, 409, {
            error: "confirmation_mismatch",
            message: "the task is not what that digest describes; nothing was changed",
            confirmation: confirmationView(task),
          });
        } else {
          opts.emit?.({ type: "task_updated", task });
          json(res, 200, { task, confirmation: confirmationView(task) });
        }
        return true;
      }
      if (method === "DELETE") {
        // A run in flight is cancelled and waited for before the files go.
        const { removed } = await removeTask(id, { runner: opts.runner, now });
        if (removed) {
          opts.emit?.({ type: "task_deleted", taskId: id });
          json(res, 200, { ok: true });
        } else json(res, 404, { error: "not_found" });
        return true;
      }
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }

    if (sub === "run" && runId === undefined) {
      if (method !== "POST") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      if (!opts.runner) {
        json(res, 503, { error: "task_runner_unavailable" });
        return true;
      }
      const started = await opts.runner.runNow(id);
      if (started.ok) json(res, 202, { ok: true, task: await getTask(id) });
      else if (started.reason === "not_found") json(res, 404, { error: "not_found" });
      else json(res, 409, { error: started.reason });
      return true;
    }

    if (sub === "cancel" && runId === undefined) {
      if (method !== "POST") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      const task = await getTask(id);
      if (!task) {
        json(res, 404, { error: "not_found" });
        return true;
      }
      // Without a runner in this process the flag still reaches the one that owns the run.
      const cancelled = opts.runner
        ? await opts.runner.cancel(id)
        : !!(
            await updateTask(id, (t: Task) => {
              if (!t.activeRunId) return false;
              t.cancelRequestedAt = now();
              return;
            })
          )?.cancelRequestedAt;
      json(res, 200, { ok: true, cancelled, task: await getTask(id) });
      return true;
    }

    if (sub === "runs") {
      if (method !== "GET") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      const task = await getTask(id);
      if (!task) {
        json(res, 404, { error: "not_found" });
        return true;
      }
      if (runId === undefined) {
        json(res, 200, { runs: (await listRuns(task)).map(publicRun) });
        return true;
      }
      // Only runs the task itself lists: a guessed id cannot read another file.
      const loaded = isSafeId(runId) && task.runs.includes(runId) ? await loadRun(id, runId) : null;
      if (!loaded) {
        json(res, 404, { error: "not_found" });
        return true;
      }
      // The activity trail (tool names, outcomes, short previews) — not the raw transcript.
      json(res, 200, { run: publicRun(loaded.run), events: loaded.events });
      return true;
    }

    json(res, 404, { error: "not_found" });
    return true;
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      res.writeHead(413, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "body_too_large", limitBytes: err.limitBytes }));
      return true;
    }
    if (err instanceof SyntaxError) {
      json(res, 400, { error: "invalid_json" });
      return true;
    }
    json(res, 500, { error: "task_api_failed" });
    return true;
  }
}
