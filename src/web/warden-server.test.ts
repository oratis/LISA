/**
 * Server wiring for approval mode "warden": a real `startWebServer`, a scripted
 * provider, and a tool whose execution we can observe. Asserts the one thing
 * the whole feature exists for — a side-effecting call on the web surface
 * WAITS for the inbox, runs on approve, and does not run otherwise.
 *
 * Environment is pinned before the dynamic import (see server.test.ts).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderResult } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-warden-server-"));
process.env.LISA_HOME = TMP;
process.env.CLAUDE_HOME = path.join(TMP, "claude");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
process.env.LISA_LOG_FORMAT = "text";
process.env.LISA_WARDEN_APPROVAL_TIMEOUT_MS = "1200";
for (const k of [
  "LISA_EDITION",
  "LISA_WEB_TOKEN",
  "LISA_LOG_FILE",
  "K_SERVICE",
  "LISA_MODEL_FALLBACK",
  "LISA_MANAGED_SESSION",
  "LISA_BASE_URL",
  "LISA_PROVIDER",
]) {
  delete process.env[k];
}

const { startWebServer } = await import("./server.js");
const { buildRuntimePolicy } = await import("../runtime-policy.js");

const USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** First turn calls `tool`; every later turn just says "done". */
function scriptedProvider(tool: string, input: unknown): Provider {
  let turns = 0;
  return {
    name: "fake",
    async runTurn(): Promise<ProviderResult> {
      turns++;
      if (turns === 1) {
        return {
          content: [{ type: "tool_use", id: "tu_1", name: tool, input } as Anthropic.ToolUseBlock],
          stopReason: "tool_use",
          usage: USAGE,
        };
      }
      return {
        content: [{ type: "text", text: "done", citations: null }],
        stopReason: "end_turn",
        usage: USAGE,
      };
    },
  };
}

function recordingTool(name: string, calls: unknown[]): ToolDefinition {
  return {
    name,
    description: "test tool with an observable side effect",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    async execute(input: unknown) {
      calls.push(input);
      return "side effect performed";
    },
  };
}

interface Booted {
  port: number;
  close: () => Promise<void>;
}

async function boot(opts: {
  approval: "warden" | "auto" | "default";
  tool: ToolDefinition;
  provider: Provider;
  env?: Record<string, string>;
}): Promise<Booted> {
  const policy = buildRuntimePolicy(
    {
      subcommand: "serve",
      serveWeb: true,
      reflect: false,
      thinking: false,
      compaction: false,
      approval: opts.approval === "default" ? "auto" : opts.approval,
      approvalExplicit: opts.approval !== "default",
    },
    { LISA_EDITION: "mac", ...(opts.env ?? {}) },
  );
  const server = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    tools: [opts.tool],
    model: "claude-sonnet-4-6",
    thinking: false,
    reflect: false,
    idleMinutes: 0,
    hooks: [],
    policy,
    provider: opts.provider,
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Sse {
  events: Array<Record<string, unknown>>;
  done: Promise<void>;
  close: () => void;
  waitFor: (
    pred: (e: Record<string, unknown>) => boolean,
    ms?: number,
  ) => Promise<Record<string, unknown>>;
}

/** Open an SSE request (GET /events or POST /chat) and collect its `data:` frames. */
function sse(port: number, method: string, urlPath: string, body?: unknown): Sse {
  const events: Array<Record<string, unknown>> = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: urlPath,
      method,
      agent: false,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    },
    (res) => {
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
            } catch {
              /* heartbeat or partial frame */
            }
          }
        }
      });
      res.on("end", finish);
      res.on("close", finish);
    },
  );
  req.on("error", finish);
  if (body !== undefined) req.write(JSON.stringify(body));
  req.end();
  return {
    events,
    done,
    close: () => req.destroy(),
    waitFor: async (pred, ms = 5000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = events.find(pred);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(`SSE event not seen; got ${JSON.stringify(events.map((e) => e.type))}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

async function api(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("web chat under approval mode warden", () => {
  test("default local web chat blocks executable extensions without a human answer", async () => {
    const calls: unknown[] = [];
    const srv = await boot({
      approval: "default",
      tool: recordingTool("deploy_widget", calls),
      provider: scriptedProvider("deploy_widget", {}),
    });
    try {
      const chat = sse(srv.port, "POST", "/chat", { message: "ship it" });
      const end = await chat.waitFor((e) => e.type === "tool_end");
      assert.equal(end.isError, true);
      await chat.done;
      assert.equal(calls.length, 0);
      assert.deepEqual((await api(srv.port, "GET", "/api/approvals")).body.approvals, []);
    } finally {
      await srv.close();
    }
  });

  test("a side-effecting call waits on the inbox and proceeds on approve", async () => {
    const calls: unknown[] = [];
    // Opted in through the environment, the way an app-launched backend would.
    const srv = await boot({
      approval: "default",
      env: { LISA_APPROVAL: "warden" },
      tool: recordingTool("deploy_widget", calls),
      provider: scriptedProvider("deploy_widget", {
        target: "prod",
        token: "sk-ant-api03-SECRETSECRETSECRET1234",
      }),
    });
    const stream = sse(srv.port, "GET", "/events");
    try {
      await stream.waitFor((e) => e.type === "hello");
      const chat = sse(srv.port, "POST", "/chat", { message: "ship it" });

      const asked = await stream.waitFor((e) => e.type === "approval_requested");
      assert.equal(asked.tool, "deploy_widget");
      assert.equal(asked.category, "write");
      assert.equal(asked.kind, "approval");
      assert.equal(
        JSON.stringify(asked).includes("SECRETSECRET"),
        false,
        "the card carries no secret",
      );

      // The turn is parked: the tool has not run, the chat stream is still open.
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(calls.length, 0, "not executed before approval");
      assert.equal(
        chat.events.some((e) => e.type === "tool_end"),
        false,
      );
      const pending = await api(srv.port, "GET", "/api/approvals");
      assert.equal((pending.body.approvals as unknown[]).length, 1);

      // The approver reads the whole payload (secret masked), then approves its digest.
      const route = `/api/approvals/${String(asked.id)}`;
      const detail = await api(srv.port, "GET", route);
      assert.equal(detail.status, 200);
      const fields = detail.body.fields as Array<{ key: string; value: string }>;
      assert.deepEqual(fields.map((f) => f.key).sort(), ["target", "token"]);
      assert.equal(JSON.stringify(detail.body).includes("SECRETSECRET"), false);
      const digest = (detail.body.approval as { digest: string }).digest;
      assert.equal(digest, asked.digest);

      const blind = await api(srv.port, "POST", `${route}/approve`, { scope: "once" });
      assert.equal(blind.status, 400, "no digest, no approval");
      assert.equal(calls.length, 0);
      const approved = await api(srv.port, "POST", `${route}/approve`, { scope: "once", digest });
      assert.equal(approved.status, 200);

      const end = await chat.waitFor((e) => e.type === "tool_end");
      assert.equal(end.isError, false);
      assert.equal(calls.length, 1, "executed exactly once after approval");
      await chat.waitFor((e) => e.type === "done");
      await stream.waitFor((e) => e.type === "approval_resolved" && e.verdict === "approved");
      await chat.done;

      const audit = (await api(srv.port, "GET", "/api/warden/audit")).body.entries as Array<
        Record<string, unknown>
      >;
      assert.ok(
        audit.some(
          (e) => e.kind === "decision" && e.verdict === "ask" && e.tool === "deploy_widget",
        ),
      );
      assert.ok(audit.some((e) => e.kind === "resolution" && e.resolution === "approved"));
      assert.equal(JSON.stringify(audit).includes("SECRETSECRET"), false);
      assert.deepEqual((await api(srv.port, "GET", "/api/approvals")).body.approvals, []);
    } finally {
      stream.close();
      await srv.close();
    }
  });

  test("deny: the tool does not run and the model is told why", async () => {
    const calls: unknown[] = [];
    const srv = await boot({
      approval: "warden",
      tool: recordingTool("deploy_widget", calls),
      provider: scriptedProvider("deploy_widget", { target: "prod" }),
    });
    const stream = sse(srv.port, "GET", "/events");
    try {
      await stream.waitFor((e) => e.type === "hello");
      const chat = sse(srv.port, "POST", "/chat", { message: "ship it" });
      const asked = await stream.waitFor((e) => e.type === "approval_requested");
      const denied = await api(srv.port, "POST", `/api/approvals/${String(asked.id)}/deny`, {
        reason: "not today",
      });
      assert.equal(denied.status, 200);
      const end = await chat.waitFor((e) => e.type === "tool_end");
      assert.equal(end.isError, true);
      assert.match(String(end.resultPreview), /did not approve/);
      await chat.done;
      assert.equal(calls.length, 0);
    } finally {
      stream.close();
      await srv.close();
    }
  });

  test("no answer: the approval expires and the tool does not run", async () => {
    const calls: unknown[] = [];
    const srv = await boot({
      approval: "warden",
      tool: recordingTool("deploy_widget", calls),
      provider: scriptedProvider("deploy_widget", {}),
    });
    const stream = sse(srv.port, "GET", "/events");
    try {
      await stream.waitFor((e) => e.type === "hello");
      const chat = sse(srv.port, "POST", "/chat", { message: "ship it" });
      const asked = await stream.waitFor((e) => e.type === "approval_requested");
      const resolved = await stream.waitFor(
        (e) => e.type === "approval_resolved" && e.id === asked.id,
        6000,
      );
      assert.equal(resolved.verdict, "expired");
      const end = await chat.waitFor((e) => e.type === "tool_end");
      assert.equal(end.isError, true);
      assert.match(String(end.resultPreview), /expired/);
      await chat.done;
      assert.equal(calls.length, 0);
      // Too late to approve.
      assert.equal(
        (await api(srv.port, "POST", `/api/approvals/${String(asked.id)}/approve`, {})).status,
        404,
      );
      assert.equal(calls.length, 0);
    } finally {
      stream.close();
      await srv.close();
    }
  });

  test("client disconnect cancels the pending approval; nothing runs later", async () => {
    const calls: unknown[] = [];
    const srv = await boot({
      approval: "warden",
      tool: recordingTool("deploy_widget", calls),
      provider: scriptedProvider("deploy_widget", {}),
    });
    const stream = sse(srv.port, "GET", "/events");
    try {
      await stream.waitFor((e) => e.type === "hello");
      const chat = sse(srv.port, "POST", "/chat", { message: "ship it" });
      const asked = await stream.waitFor((e) => e.type === "approval_requested");
      chat.close();
      await stream.waitFor((e) => e.type === "approval_resolved" && e.id === asked.id);
      assert.equal(
        (await api(srv.port, "POST", `/api/approvals/${String(asked.id)}/approve`, {})).status,
        404,
      );
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(calls.length, 0);
    } finally {
      stream.close();
      await srv.close();
    }
  });

  test("reads run directly; full access allows ordinary writes", async () => {
    const readCalls: unknown[] = [];
    const warden = await boot({
      approval: "warden",
      tool: recordingTool("read", readCalls),
      provider: scriptedProvider("read", { path: "a.txt" }),
    });
    try {
      const chat = sse(warden.port, "POST", "/chat", { message: "look" });
      const end = await chat.waitFor((e) => e.type === "tool_end");
      assert.equal(end.isError, false);
      await chat.done;
      assert.equal(readCalls.length, 1);
    } finally {
      await warden.close();
    }

    const calls: unknown[] = [];
    const legacy = await boot({
      approval: "auto",
      tool: recordingTool("write", calls),
      provider: scriptedProvider("write", {
        path: path.join(os.tmpdir(), "ordinary-note.txt"),
        content: "note",
      }),
    });
    try {
      // Earlier tests deliberately taint the active chat by running an
      // extension. Even full access keeps Warden's tainted-run floor.
      await api(legacy.port, "POST", "/api/sessions", {});
      const chat = sse(legacy.port, "POST", "/chat", {
        message: "save note",
        controls: { permission: "full" },
      });
      const end = await chat.waitFor((e) => e.type === "tool_end");
      assert.equal(end.isError, false);
      await chat.done;
      assert.equal(calls.length, 1);
      assert.deepEqual((await api(legacy.port, "GET", "/api/approvals")).body.approvals, []);
    } finally {
      await legacy.close();
    }
  });
});

test("full access still needs a one-use, payload-bound approval to edit Lisa via a symlink", async () => {
  const { writeTool } = await import("../tools/write.js");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-protected-source-"));
  const link = path.join(TMP, "checkout");
  fs.symlinkSync(source, link, "dir");
  const filename = path.join(source, "..example.ts");
  fs.writeFileSync(filename, "original");
  const previous = process.env.LISA_SOURCE_ROOT;
  process.env.LISA_SOURCE_ROOT = source;
  const srv = await boot({
    approval: "auto",
    tool: writeTool,
    provider: scriptedProvider("write", {
      path: path.join(link, "..example.ts"),
      content: "reviewed",
    }),
  });
  const stream = sse(srv.port, "GET", "/events");
  try {
    await stream.waitFor((e) => e.type === "hello");
    const turn = sse(srv.port, "POST", "/chat", {
      message: "update Lisa",
      controls: { permission: "full" },
    });
    const asked = await stream.waitFor((e) => e.type === "approval_requested");
    assert.deepEqual(asked.scopes, ["once"]);
    assert.match(String(asked.reason), /Lisa’s own files/);
    const route = `/api/approvals/${asked.id}/approve`;
    assert.notEqual(
      (await api(srv.port, "POST", route, { scope: "always", digest: asked.digest })).status,
      200,
    );
    assert.notEqual(
      (await api(srv.port, "POST", route, { scope: "once", digest: "wrong" })).status,
      200,
    );
    assert.equal(fs.readFileSync(filename, "utf8"), "original");
    assert.equal(
      (await api(srv.port, "POST", route, { scope: "once", digest: asked.digest })).status,
      200,
    );
    await turn.done;
    assert.equal(fs.readFileSync(filename, "utf8"), "reviewed");
    assert.notEqual(
      (await api(srv.port, "POST", route, { scope: "once", digest: asked.digest })).status,
      200,
    );
  } finally {
    stream.close();
    await srv.close();
    if (previous === undefined) delete process.env.LISA_SOURCE_ROOT;
    else process.env.LISA_SOURCE_ROOT = previous;
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("model and effort reach the provider for just the chosen turn; the server rejects elevation", async () => {
  const seen: Array<[string, string | undefined]> = [];
  const model = "claude-opus-4-6";
  const oldList = process.env.LISA_CHAT_MODELS;
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.LISA_CHAT_MODELS = model;
  process.env.ANTHROPIC_API_KEY = "test-only";
  const srv = await boot({
    approval: "warden",
    tool: recordingTool("read", []),
    provider: {
      name: "fake",
      async runTurn(opts) {
        seen.push([opts.model, opts.effort]);
        return {
          content: [{ type: "text", text: "ok", citations: null }],
          stopReason: "end_turn",
          usage: USAGE,
        };
      },
    },
  });
  try {
    const options = await api(srv.port, "GET", "/api/chat-controls");
    assert.deepEqual(options.body.permissions, ["smart", "ask"]);
    for (const controls of [
      { permission: "full" },
      { permission: "smart", model: "unknown" },
      { permission: "ask", effort: "bogus" },
    ]) {
      assert.equal((await api(srv.port, "POST", "/chat", { message: "hi", controls })).status, 400);
    }
    const csrf = await fetch(`http://127.0.0.1:${srv.port}/chat`, {
      method: "POST",
      headers: { origin: "https://other.test", "content-type": "application/json" },
      body: JSON.stringify({ message: "hi", controls: { permission: "ask" } }),
    });
    assert.equal(csrf.status, 403);
    assert.deepEqual(seen, []);
    await sse(srv.port, "POST", "/chat", {
      message: "use opus",
      controls: { permission: "ask", model, effort: "low" },
    }).done;
    await sse(srv.port, "POST", "/chat", { message: "default" }).done;
    assert.deepEqual(seen, [
      [model, "low"],
      ["claude-sonnet-4-6", process.env.LISA_EFFORT],
    ]);
  } finally {
    await srv.close();
    if (oldList === undefined) delete process.env.LISA_CHAT_MODELS;
    else process.env.LISA_CHAT_MODELS = oldList;
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldKey;
  }
});
