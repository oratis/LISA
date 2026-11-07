/**
 * Server wiring for an applied forget: the transcripts are redacted on disk,
 * and the chat histories the server keeps in memory must be reloaded from
 * them — otherwise the next turn of an open chat sends the forgotten text to
 * the model again. A real `startWebServer` with a provider that records what
 * each turn was sent.
 *
 * Environment is pinned before the dynamic import (see server.test.ts).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Provider, ProviderResult, ProviderRunOpts } from "../providers/types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-forget-server-"));
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
  "LISA_APPROVAL",
]) {
  delete process.env[k];
}

const { startWebServer } = await import("./server.js");
const { buildRuntimePolicy } = await import("../runtime-policy.js");
const { FORGOTTEN } = await import("../sovereignty/forget.js");

const USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Answers "noted" and keeps the messages of every turn it was asked. */
function recordingProvider(turns: ProviderRunOpts["messages"][]): Provider {
  return {
    name: "fake",
    async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
      turns.push(structuredClone(opts.messages));
      return {
        content: [{ type: "text", text: "noted", citations: null }],
        stopReason: "end_turn",
        usage: USAGE,
      };
    },
  };
}

async function chat(port: number, message: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  assert.equal(res.status, 200);
  const body = await res.text(); // the SSE stream ends with the turn
  assert.match(body, /"type":"done"/);
}

async function api(
  port: number,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("applied forget and the server's open chats", () => {
  test("the next turn of an open chat no longer carries the forgotten text", async () => {
    const turns: ProviderRunOpts["messages"][] = [];
    const policy = buildRuntimePolicy(
      {
        subcommand: "serve",
        serveWeb: true,
        reflect: false,
        thinking: false,
        compaction: false,
        approval: "auto",
        approvalExplicit: false,
      },
      { LISA_EDITION: "mac" },
    );
    const server = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      tools: [],
      model: "claude-sonnet-4-6",
      thinking: false,
      reflect: false,
      idleMinutes: 0,
      hooks: [],
      policy,
      provider: recordingProvider(turns),
    });
    const port = (server.address() as AddressInfo).port;
    try {
      await chat(port, "Remember:\nAnn's number is 555-0100");
      assert.ok(JSON.stringify(turns[0]).includes("555-0100"));

      const preview = await api(port, "/api/memory/forget", { query: "Ann", dryRun: true });
      assert.equal(preview.status, 200);
      const report = preview.json.report as { digest: string; counts: Record<string, number> };
      assert.equal(report.counts.sessions, 1);
      const applied = await api(port, "/api/memory/forget", {
        query: "Ann",
        digest: report.digest,
      });
      assert.equal(applied.status, 200);

      await chat(port, "what was the number?");
      const sent = JSON.stringify(turns[1]);
      assert.ok(!sent.includes("555-0100"), "the forgotten message is not sent again");
      assert.ok(sent.includes(FORGOTTEN), "the chat continues from the redacted transcript");
      assert.ok(sent.includes("what was the number?"));
      assert.ok(sent.includes("noted"), "the rest of the history is kept");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
