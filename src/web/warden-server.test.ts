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
    { LISA_EDITION: "mac" },
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
  test("serve --web defaults to warden; an explicit --approval wins; the CLI stays auto", () => {
    const args = { reflect: true, thinking: false, compaction: false, approval: "auto" as const };
    const web = { ...args, subcommand: "serve", serveWeb: true };
    assert.equal(
      buildRuntimePolicy({ ...web, approvalExplicit: false }, { LISA_EDITION: "mac" }).approval,
      "warden",
    );
    assert.equal(
      buildRuntimePolicy({ ...web, approvalExplicit: false }, { LISA_EDITION: "cloud" }).approval,
      "warden",
    );
    assert.equal(
      buildRuntimePolicy({ ...web, approvalExplicit: true }, { LISA_EDITION: "mac" }).approval,
      "auto",
    );
    assert.equal(
      buildRuntimePolicy({ ...web }, { LISA_EDITION: "mac" }).approval,
      "auto",
      "hand-built policies are unchanged",
    );
    assert.equal(
      buildRuntimePolicy({ ...args, approvalExplicit: false }, { LISA_EDITION: "mac" }).approval,
      "auto",
    );
  });

  test("a side-effecting call waits on the inbox and proceeds on approve", async () => {
    const calls: unknown[] = [];
    const srv = await boot({
      approval: "default",
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

      const approved = await api(srv.port, "POST", `/api/approvals/${String(asked.id)}/approve`, {
        scope: "once",
      });
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

  test("reads are not gated; --approval auto keeps the legacy no-approval path", async () => {
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
      tool: recordingTool("deploy_widget", calls),
      provider: scriptedProvider("deploy_widget", {}),
    });
    try {
      const chat = sse(legacy.port, "POST", "/chat", { message: "ship it" });
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
