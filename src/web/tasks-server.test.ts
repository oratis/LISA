/**
 * The Task Engine inside the REAL web server (startWebServer, Mac edition):
 * the route hook, the scheduler's first tick, heartbeat.json migration at
 * start, and a result travelling outbox → reach-out gate → conversation + SSE.
 *
 * No model is called: the delivered result is placed in the outbox directly,
 * exactly as a run in another process (the heartbeat CLI) would have left it.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-tasks-server-"));
process.env.LISA_HOME = TMP;
process.env.CLAUDE_HOME = path.join(TMP, "claude");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
process.env.LISA_LOG_FORMAT = "text";
for (const k of [
  "LISA_EDITION",
  "LISA_WEB_TOKEN",
  "LISA_LOG_FILE",
  "K_SERVICE",
  "LISA_MODEL_FALLBACK",
  "LISA_MANAGED_SESSION",
  "LISA_BASE_URL",
  "LISA_PROVIDER",
  "LISA_CLOUD_TASKS",
]) {
  delete process.env[k];
}

// Seeded BEFORE the server starts: a chore to migrate, and a finished run's
// notice that no process has been able to deliver yet.
fs.writeFileSync(
  path.join(TMP, "heartbeat.json"),
  JSON.stringify({
    tasks: [{ name: "disk check", prompt: "Check disk.", schedule: "daily:03:00" }],
  }),
);
const { enqueueNotice, listOutbox } = await import("../tasks/outbox.js");
const { getTask, listTasks } = await import("../tasks/store.js");
const { heartbeatTaskId } = await import("../tasks/heartbeat-migration.js");
const NOTICE_ID = "r_0123456789abcdef-task-result";
await enqueueNotice({
  id: NOTICE_ID,
  uid: null,
  taskId: "t_0123456789ab",
  runId: "r_0123456789abcdef",
  title: "Morning brief",
  summary: "Two things need you today.",
  status: "succeeded",
  priority: "normal",
  kind: "task_result",
});

const { startWebServer } = await import("./server.js");

const server = await startWebServer({
  port: 0,
  host: "127.0.0.1",
  tools: [],
  model: "claude-sonnet-4-6",
  thinking: false,
  reflect: true,
  idleMinutes: 0,
  hooks: [],
});
const port = (server.address() as AddressInfo).port;

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Give the task host's async stop a beat before the home disappears.
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(TMP, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: Record<string, unknown>;
}

function request(
  method: string,
  urlPath: string,
  body?: unknown,
  type = "application/json",
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        agent: false,
        headers: method === "GET" || method === "DELETE" ? {} : { "content-type": type },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function until(check: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function sessionText(): string {
  const dir = path.join(TMP, "sessions");
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => fs.readFileSync(path.join(dir, n), "utf8"))
    .join("\n");
}

describe("task engine in the real server", () => {
  test("/api/tasks is routed, versioned and CSRF-guarded", async () => {
    const created = await request("POST", "/api/tasks", {
      title: "Weekly review",
      instruction: "Review the week.",
      schedule: "weekly:fri@17:00",
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers["x-lisa-api-version"], "1");
    const task = created.json.task as { id: string; enabled: boolean; state: string };
    assert.equal(task.enabled, false);
    assert.equal(task.state, "draft");

    const listed = await request("GET", "/api/tasks");
    assert.equal(listed.status, 200);
    assert.ok((listed.json.tasks as Array<{ id: string }>).some((t) => t.id === task.id));

    const forged = await request("POST", `/api/tasks/${task.id}/run`, undefined, "text/plain");
    assert.equal(forged.status, 415);
    assert.deepEqual((await getTask(task.id))!.runs, []);

    const enabled = await request("PATCH", `/api/tasks/${task.id}`, { enabled: true });
    assert.equal((enabled.json.task as { state: string }).state, "scheduled");
    assert.equal((await request("DELETE", `/api/tasks/${task.id}`)).status, 200);
    assert.equal((await request("GET", `/api/tasks/${task.id}`)).status, 404);
  });

  test("heartbeat.json chores are routines after the first start", async () => {
    await until(async () => (await getTask(heartbeatTaskId("disk check"))) !== null);
    const routine = (await getTask(heartbeatTaskId("disk check")))!;
    assert.equal(routine.kind, "routine");
    assert.equal(routine.enabled, true);
    assert.deepEqual(routine.schedule, { expr: "daily:03:00" });
    assert.deepEqual(routine.origin, { kind: "heartbeat" });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(TMP, "heartbeat.json"), "utf8")).tasks,
      [],
    );
    assert.ok(fs.existsSync(path.join(TMP, "heartbeat.json.pre-tasks.bak")));
    assert.ok((await listTasks()).length >= 1);
  });

  test("a result left in the outbox is delivered once: a card in the conversation, via the reach-out gate", async () => {
    // The scheduler's first tick (≈1 s after start) drains the outbox.
    await until(async () =>
      (await listOutbox()).some((e) => e.id === NOTICE_ID && e.state === "delivered"),
    );
    const text = sessionText();
    assert.match(text, /\[task · Morning brief\]/);
    assert.match(text, /Two things need you today\./);
    assert.equal(text.split(`(ref ${NOTICE_ID})`).length - 1, 1, "exactly one card");

    // The gate saw it: one ledger line, source `task`, solicited.
    const ledger = fs
      .readFileSync(path.join(TMP, "reachout", "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "notice" && e.kind === "task_result");
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.source, "task");
    assert.equal(ledger[0]!.solicited, true);
    assert.ok((ledger[0]!.channels as string[]).includes("inapp"));
  });
});
