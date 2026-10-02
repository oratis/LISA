import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { homeForUid, homeScope } from "../paths.js";
import type { Provider } from "../providers/types.js";
import { TaskRunner, type TaskEngineEvent } from "../tasks/runner.js";
import { handleTasksApi, MAX_TASKS, TASK_BODY_LIMIT } from "./tasks-api.js";

// One server, three "editions" selected per request by header:
//   x-edition: mac            → single user, global home
//   x-edition: cloud + x-uid  → hosted, per-uid home scope, flag from x-flag
let home: string;
let server: http.Server;
let origin: string;
let previousHome: string | undefined;
const emitted: TaskEngineEvent[] = [];
const runners = new Map<string, TaskRunner>();
let modelCalls = 0;

const provider: Provider = {
  name: "fake",
  async runTurn() {
    modelCalls++;
    return {
      content: [{ type: "text", text: "ran it" } as never],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

function runnerFor(key: string): TaskRunner {
  let runner = runners.get(key);
  if (!runner) {
    runner = new TaskRunner({
      tools: [],
      model: "claude-test",
      cwd: os.tmpdir(),
      provider,
      unattendedAllowed: () => true,
      log: () => {},
      onEvent: (e) => emitted.push(e),
    });
    runners.set(key, runner);
  }
  return runner;
}

before(async () => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-tasks-api-"));
  process.env.LISA_HOME = home;
  server = http.createServer((req, res) => {
    const cloud = req.headers["x-edition"] === "cloud";
    const uid = typeof req.headers["x-uid"] === "string" ? req.headers["x-uid"] : null;
    const run = () =>
      handleTasksApi(req, res, req.url ?? "/", {
        cloud,
        profile: cloud ? "cloud-chat" : "local-owner",
        uid,
        runner: req.headers["x-no-runner"] ? null : runnerFor(uid ?? "mac"),
        emit: (e) => emitted.push(e),
        cloudEnabled: req.headers["x-flag"] === "1",
      }).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end("unhandled");
        }
      });
    void (cloud && uid ? homeScope.run(homeForUid(uid), run) : run());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await Promise.all([...runners.values()].map((r) => r.stop()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  emitted.length = 0;
});

type Headers = Record<string, string>;
const MAC: Headers = { "x-edition": "mac" };
const cloudUser = (uid: string, flag = true): Headers => ({
  "x-edition": "cloud",
  "x-uid": uid,
  ...(flag ? { "x-flag": "1" } : {}),
});

async function api(
  method: string,
  pathname: string,
  body?: unknown,
  headers: Headers = MAC,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const textBody = await res.text();
  let parsed: unknown = textBody;
  try {
    parsed = JSON.parse(textBody);
  } catch {
    // not JSON — leave the text
  }
  return { status: res.status, body: parsed };
}

const routine = {
  title: "Morning brief",
  instruction: "Summarise what matters today.",
  schedule: { expr: "weekdays:08:00", tz: "UTC" },
};

describe("tasks API — CRUD", () => {
  test("create → list → get → edit → enable → disable → delete", async () => {
    const created = await api("POST", "/api/tasks", routine);
    assert.equal(created.status, 201);
    const task = created.body.task;
    assert.equal(task.kind, "routine");
    assert.equal(task.enabled, false, "created disabled unless the caller says otherwise");
    assert.equal(task.state, "draft");
    assert.equal(task.createdDisabled, true);
    assert.deepEqual(task.origin, { kind: "api" });
    assert.equal(task.owner, null);
    assert.deepEqual(emitted.map((e) => e.type), ["task_updated"]);

    const listed = await api("GET", "/api/tasks");
    assert.equal(listed.status, 200);
    assert.ok(listed.body.tasks.some((t: { id: string }) => t.id === task.id));

    assert.equal((await api("GET", `/api/tasks/${task.id}`)).body.task.title, "Morning brief");

    const edited = await api("PATCH", `/api/tasks/${task.id}`, { title: "Daily brief", notify: "silent_on_noop" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.task.title, "Daily brief");
    assert.equal(edited.body.task.notify, "silent_on_noop");
    assert.equal(edited.body.task.enabled, false);

    const enabled = await api("PATCH", `/api/tasks/${task.id}`, { enabled: true });
    assert.equal(enabled.body.task.enabled, true);
    assert.equal(enabled.body.task.state, "scheduled");
    assert.ok(enabled.body.task.nextRunAt > Date.now());
    assert.equal(typeof enabled.body.task.enabledAt, "number");

    // Changing the schedule of an enabled task re-computes its next run.
    const moved = await api("PATCH", `/api/tasks/${task.id}`, { schedule: "every:6h" });
    assert.equal(moved.body.task.schedule.expr, "every:6h");
    assert.ok(Math.abs(moved.body.task.nextRunAt - (Date.now() + 6 * 3_600_000)) < 5000);

    const disabled = await api("PATCH", `/api/tasks/${task.id}`, { enabled: false });
    assert.equal(disabled.body.task.state, "paused");
    assert.equal(disabled.body.task.nextRunAt, undefined);

    assert.deepEqual((await api("DELETE", `/api/tasks/${task.id}`)).body, { ok: true });
    assert.equal(emitted.at(-1)!.type, "task_deleted");
    assert.equal((await api("GET", `/api/tasks/${task.id}`)).status, 404);
    assert.equal((await api("DELETE", `/api/tasks/${task.id}`)).status, 404);
  });

  test("the API may create a task already enabled; a watcher starts due", async () => {
    const created = await api("POST", "/api/tasks", {
      title: "Campsite",
      instruction: "Tell me when a site opens.",
      trigger: { kind: "web", url: "https://example.com/sites", mode: "appears", contains: "Available" },
      enabled: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.task.kind, "watcher");
    assert.equal(created.body.task.enabled, true);
    assert.equal(created.body.task.notify, "on_hit");
    assert.ok(created.body.task.nextRunAt <= Date.now());
    await api("DELETE", `/api/tasks/${created.body.task.id}`);
  });

  test("run now, run history and run detail", async () => {
    const { body } = await api("POST", "/api/tasks", routine);
    const id = body.task.id as string;
    const before = modelCalls;
    const started = await api("POST", `/api/tasks/${id}/run`);
    assert.equal(started.status, 202);
    await runnerFor("mac").drain();
    assert.equal(modelCalls, before + 1);

    const runs = await api("GET", `/api/tasks/${id}/runs`);
    assert.equal(runs.status, 200);
    assert.equal(runs.body.runs.length, 1);
    const run = runs.body.runs[0];
    assert.equal(run.state, "succeeded");
    assert.equal(run.manual, true);
    assert.equal(run.summary, "ran it");
    assert.equal(run.executedDigests, undefined, "the ledger never leaves the process");
    assert.equal(run.sideEffects, 0);

    const detail = await api("GET", `/api/tasks/${id}/runs/${run.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.run.id, run.id);
    assert.ok(Array.isArray(detail.body.events));
    assert.equal(detail.body.messages, undefined, "no raw transcript");

    assert.equal((await api("GET", `/api/tasks/${id}/runs/r_0000000000000000`)).status, 404);
    assert.equal((await api("GET", `/api/tasks/${id}/runs/..%2f..%2fsecret`)).status, 404);
    // Still a draft: a test run does not enable anything.
    assert.equal((await api("GET", `/api/tasks/${id}`)).body.task.state, "draft");

    const cancel = await api("POST", `/api/tasks/${id}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.cancelled, false, "nothing was running");
    await api("DELETE", `/api/tasks/${id}`);
  });

  test("run and cancel without a runner in this process", async () => {
    const { body } = await api("POST", "/api/tasks", routine);
    const id = body.task.id as string;
    const noRunner = { ...MAC, "x-no-runner": "1" };
    assert.equal((await api("POST", `/api/tasks/${id}/run`, undefined, noRunner)).status, 503);
    assert.equal((await api("POST", `/api/tasks/${id}/cancel`, undefined, noRunner)).body.cancelled, false);
    await api("DELETE", `/api/tasks/${id}`);
  });
});

describe("tasks API — validation and limits", () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ["no title", { instruction: "x" }, /title is required/],
    ["no instruction", { title: "x" }, /instruction is required/],
    ["long title", { title: "x".repeat(201), instruction: "x" }, /title is too long/],
    ["unknown kind", { ...routine, kind: "cron" }, /kind must be one of/],
    ["routine without schedule", { title: "x", instruction: "x", kind: "routine" }, /needs a schedule/],
    ["bad schedule", { ...routine, schedule: "hourly" }, /unrecognised schedule/],
    ["too frequent", { ...routine, schedule: "every:1m" }, /at least 5 minutes/],
    ["bad tz", { ...routine, schedule: { expr: "daily:09:00", tz: "Mars/Olympus" } }, /time zone/],
    ["routine with at:", { ...routine, schedule: "at:2030-01-01T00:00:00Z" }, /use kind "oneoff"/],
    ["trigger on a routine", { ...routine, kind: "routine", trigger: { kind: "rss", url: "https://e.com/f" } }, /only a watcher/],
    ["file: url", { title: "w", instruction: "w", trigger: { kind: "web", url: "file:///etc/passwd" } }, /http\(s\)/],
    ["url with credentials", { title: "w", instruction: "w", trigger: { kind: "web", url: "https://u:p@e.com/" } }, /credentials/],
    ["bad regex", { title: "w", instruction: "w", trigger: { kind: "web", url: "https://e.com", regex: "(" } }, /regular expression/],
    ["threshold missing", { title: "w", instruction: "w", trigger: { kind: "web", url: "https://e.com", mode: "below" } }, /threshold/],
    ["fast watcher", { title: "w", instruction: "w", trigger: { kind: "rss", url: "https://e.com/f", every: "every:1m" } }, /at least 5 minutes/],
    ["empty mail trigger", { title: "w", instruction: "w", trigger: { kind: "mail" } }, /needs trigger.from or trigger.subject/],
    ["huge budget", { ...routine, budget: { tokens: 10_000_000 } }, /budget.tokens/],
    ["envelope not a list", { ...routine, envelope: { tools: "bash" } }, /envelope.tools/],
    ["bad notify", { ...routine, notify: "loudly" }, /notify must be one of/],
  ];
  for (const [name, body, pattern] of bad) {
    test(`rejects: ${name}`, async () => {
      const res = await api("POST", "/api/tasks", body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "invalid_task");
      assert.match(res.body.message, pattern);
    });
  }

  test("PATCH validates too and leaves the task untouched on failure", async () => {
    const { body } = await api("POST", "/api/tasks", routine);
    const id = body.task.id as string;
    for (const [patch, pattern] of [
      [{ schedule: "every:10s" }, /unrecognised/],
      [{ id: "t_somethingelse" }, /not an editable field/],
      [{ state: "succeeded" }, /not an editable field/],
      [{ runs: [] }, /not an editable field/],
      [{ enabled: "yes" }, /boolean/],
      [{ schedule: null }, /needs a schedule/],
    ] as Array<[unknown, RegExp]>) {
      const res = await api("PATCH", `/api/tasks/${id}`, patch);
      assert.equal(res.status, 400, JSON.stringify(patch));
      assert.match(res.body.message, pattern);
    }
    assert.deepEqual((await api("GET", `/api/tasks/${id}`)).body.task, body.task);
    assert.equal((await api("PATCH", "/api/tasks/t_doesnotexist", { title: "x" })).status, 404);
    await api("DELETE", `/api/tasks/${id}`);
  });

  test("malformed JSON, oversized bodies, bad ids and wrong methods", async () => {
    assert.equal((await api("POST", "/api/tasks", "{ nope")).status, 400);
    assert.equal((await api("POST", "/api/tasks", "[1,2]")).status, 400);
    const big = await api("POST", "/api/tasks", { ...routine, instruction: "x".repeat(TASK_BODY_LIMIT + 10) });
    assert.equal(big.status, 413);
    assert.equal(big.body.error, "body_too_large");
    assert.equal((await api("GET", "/api/tasks/..%2F..%2Fetc")).status, 404);
    assert.equal((await api("GET", "/api/tasks/UPPER")).status, 404);
    assert.equal((await api("PUT", "/api/tasks")).status, 405);
    assert.equal((await api("GET", "/api/tasks/t_0123456789ab/run")).status, 405);
    assert.equal((await api("POST", "/api/tasks/t_0123456789ab/run")).status, 404);
    assert.equal((await api("GET", "/api/tasks/t_0123456789ab/nope")).status, 404);
    assert.equal((await api("GET", "/api/tasksx")).body, "unhandled");
  });

  test("the number of tasks per tenant is capped", async () => {
    const uid = "capuser";
    const headers = cloudUser(uid);
    const dir = path.join(homeForUid(uid), "tasks");
    fs.mkdirSync(dir, { recursive: true });
    const first = await api("POST", "/api/tasks", routine, headers);
    assert.equal(first.status, 201);
    for (let i = 1; i < MAX_TASKS; i++) {
      const id = `t_fill${String(i).padStart(8, "0")}`;
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ...first.body.task, id }));
    }
    const over = await api("POST", "/api/tasks", routine, headers);
    assert.equal(over.status, 409);
    assert.equal(over.body.error, "task_limit");
  });
});

describe("tasks API — tenancy and the cloud flag", () => {
  test("hosted edition without LISA_CLOUD_TASKS answers 403 capability_denied on every route", async () => {
    const headers = cloudUser("alice", false);
    for (const [method, pathname] of [
      ["GET", "/api/tasks"],
      ["POST", "/api/tasks"],
      ["GET", "/api/tasks/t_0123456789ab"],
      ["PATCH", "/api/tasks/t_0123456789ab"],
      ["DELETE", "/api/tasks/t_0123456789ab"],
      ["POST", "/api/tasks/t_0123456789ab/run"],
      ["POST", "/api/tasks/t_0123456789ab/cancel"],
      ["GET", "/api/tasks/t_0123456789ab/runs"],
      ["GET", "/api/tasks/t_0123456789ab/runs/r_0123456789abcdef"],
    ] as const) {
      const res = await api(method, pathname, method === "GET" || method === "DELETE" ? undefined : routine, headers);
      assert.equal(res.status, 403, `${method} ${pathname}`);
      assert.deepEqual(res.body, { error: "capability_denied", profile: "cloud-chat" });
    }
    assert.equal(fs.existsSync(path.join(homeForUid("alice"), "tasks")), false, "nothing was written");
  });

  test("a hosted request with no account is refused even with the flag on", async () => {
    const res = await api("GET", "/api/tasks", undefined, { "x-edition": "cloud", "x-flag": "1" });
    assert.equal(res.status, 401);
  });

  test("tenants cannot see, edit, run or delete each other's tasks", async () => {
    const alice = cloudUser("alice");
    const bob = cloudUser("bob");
    const created = await api("POST", "/api/tasks", routine, alice);
    assert.equal(created.status, 201);
    const id = created.body.task.id as string;
    assert.equal(created.body.task.owner, "alice");

    assert.deepEqual((await api("GET", "/api/tasks", undefined, bob)).body, { tasks: [] });
    assert.equal((await api("GET", `/api/tasks/${id}`, undefined, bob)).status, 404);
    assert.equal((await api("PATCH", `/api/tasks/${id}`, { title: "mine now" }, bob)).status, 404);
    assert.equal((await api("POST", `/api/tasks/${id}/run`, undefined, bob)).status, 404);
    assert.equal((await api("POST", `/api/tasks/${id}/cancel`, undefined, bob)).status, 404);
    assert.equal((await api("GET", `/api/tasks/${id}/runs`, undefined, bob)).status, 404);
    assert.equal((await api("DELETE", `/api/tasks/${id}`, undefined, bob)).status, 404);
    // The single-user (global) scope does not see tenant tasks either.
    assert.ok(!(await api("GET", "/api/tasks")).body.tasks.some((t: { id: string }) => t.id === id));

    const still = await api("GET", `/api/tasks/${id}`, undefined, alice);
    assert.equal(still.status, 200);
    assert.equal(still.body.task.title, "Morning brief");
  });

  test("the hosted edition applies its own floors: 30-minute schedules, smaller budgets, no watchers", async () => {
    const alice = cloudUser("alice");
    const fast = await api("POST", "/api/tasks", { ...routine, schedule: "every:10m" }, alice);
    assert.equal(fast.status, 400);
    assert.match(fast.body.message, /at least 30 minutes/);
    const pricey = await api("POST", "/api/tasks", { ...routine, budget: { tokens: 1_000_000 } }, alice);
    assert.match(pricey.body.message, /between 1000 and 400000/);
    const watch = await api(
      "POST",
      "/api/tasks",
      { title: "w", instruction: "w", trigger: { kind: "web", url: "https://example.com" } },
      alice,
    );
    assert.equal(watch.status, 400);
    assert.match(watch.body.message, /not available in the hosted edition/);
    const ok = await api("POST", "/api/tasks", { ...routine, schedule: "every:30m" }, alice);
    assert.equal(ok.status, 201);
    assert.ok(ok.body.task.budget.wallclockMs <= 15 * 60_000);
  });
});

// ── contract: what the server sends matches contracts/lisa-api-v1.openapi.json ──

interface Schema {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean;
}
const contract = JSON.parse(
  fs.readFileSync(new URL("../../contracts/lisa-api-v1.openapi.json", import.meta.url), "utf8"),
) as { paths: Record<string, unknown>; components: { schemas: Record<string, Schema> } };

function violations(input: Schema, value: unknown, at = "$"): string[] {
  const schema = input.$ref
    ? contract.components.schemas[input.$ref.replace("#/components/schemas/", "")]
    : input;
  if (!schema) return [`${at}: unresolved ${input.$ref}`];
  const out: string[] = [];
  if (schema.const !== undefined && value !== schema.const) out.push(`${at} must equal ${String(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at} not in enum`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual =
    value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
    return [`${at} expected ${types.join("|")}, got ${actual}`];
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => out.push(...violations(schema.items!, item, `${at}[${i}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) out.push(`${at}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) out.push(...violations(child, record[key], `${at}.${key}`));
    }
  }
  return out;
}
const conforms = (name: string, value: unknown) =>
  assert.deepEqual(violations({ $ref: `#/components/schemas/${name}` }, value), [], name);

describe("tasks API — contract", () => {
  test("every task route is in the OpenAPI document", () => {
    for (const route of [
      "/api/tasks",
      "/api/tasks/{id}",
      "/api/tasks/{id}/run",
      "/api/tasks/{id}/cancel",
      "/api/tasks/{id}/runs",
      "/api/tasks/{id}/runs/{runId}",
    ]) {
      assert.ok(contract.paths[route], route);
    }
  });

  test("responses and SSE events conform to their schemas", async () => {
    const created = await api("POST", "/api/tasks", {
      ...routine,
      envelope: { tools: ["web_fetch"], categories: ["web"] },
      budget: { tokens: 50_000 },
    });
    conforms("TaskResponse", created.body);
    const id = created.body.task.id as string;
    conforms("TaskListResponse", (await api("GET", "/api/tasks")).body);
    conforms("TaskResponse", (await api("PATCH", `/api/tasks/${id}`, { enabled: true })).body);

    emitted.length = 0;
    const queued = await api("POST", `/api/tasks/${id}/run`);
    conforms("TaskRunQueuedResponse", queued.body);
    await runnerFor("mac").drain();
    const runs = (await api("GET", `/api/tasks/${id}/runs`)).body;
    conforms("TaskRunListResponse", runs);
    conforms("TaskRunDetailResponse", (await api("GET", `/api/tasks/${id}/runs/${runs.runs[0].id}`)).body);
    conforms("TaskCancelResponse", (await api("POST", `/api/tasks/${id}/cancel`)).body);
    conforms("ErrorResponse", (await api("GET", "/api/tasks/t_doesnotexist")).body);
    conforms("ErrorResponse", (await api("POST", "/api/tasks", {})).body);
    conforms("TaskOkResponse", (await api("DELETE", `/api/tasks/${id}`)).body);

    const byType = (type: string) => emitted.find((e) => e.type === type);
    conforms("TaskUpdatedEvent", byType("task_updated"));
    conforms("TaskRunStartedEvent", byType("task_run_started"));
    conforms("TaskRunFinishedEvent", byType("task_run_finished"));
    conforms("TaskDeletedEvent", byType("task_deleted"));
  });

  test("a delivered task card conforms to TaskResultEvent", async () => {
    const { createTaskCardDeliver } = await import("../tasks/delivery.js");
    const events: unknown[] = [];
    const deliver = createTaskCardDeliver({
      withConversation: (fn) => fn({ history: [], append: async () => {} }),
      broadcast: (e) => events.push(e),
    });
    await deliver({
      id: "r_0123456789abcdef-task-result",
      uid: null,
      taskId: "t_0123456789ab",
      runId: "r_0123456789abcdef",
      title: "Morning brief",
      summary: "ok",
      status: "succeeded",
      priority: "normal",
      kind: "task_result",
    });
    conforms("TaskResultEvent", events[0]);
  });
});
