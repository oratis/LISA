import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Provider } from "../providers/types.js";
import { MemorySecretStore } from "../warden/secrets.js";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-workspace-web-"));
process.env.LISA_HOME = home;
process.env.CLAUDE_HOME = path.join(home, "claude");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
for (const key of [
  "LISA_EDITION",
  "LISA_WEB_TOKEN",
  "K_SERVICE",
  "LISA_MODEL_FALLBACK",
  "LISA_BASE_URL",
  "LISA_PROVIDER",
])
  delete process.env[key];
// Only the Microsoft sources have an OAuth client on this install.
const clients = path.join(home, "clients.json");
await fs.writeFile(
  clients,
  JSON.stringify({
    microsoft: { clientId: "client", tenant: "12345678-1234-1234-1234-123456789012" },
  }),
  { mode: 0o600 },
);
process.env.LISA_WORKSPACE_CLIENTS_FILE = clients;
const { startWebServer } = await import("./server.js");
after(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("unconfigured workspace sources neither register nor take over ordinary chat", async () => {
  let calls = 0;
  const provider: Provider = {
    name: "fixture",
    runTurn: async () => {
      calls++;
      return {
        content: [{ type: "text", text: "Plain answer.", citations: null }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const server = await startWebServer({
    port: 0,
    tools: [],
    model: "fixture",
    thinking: false,
    reflect: false,
    idleMinutes: 0,
    provider,
    connectorSecrets: new MemorySecretStore(),
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chat = async (message: string, sessionId: string) => {
    const response = await fetch(base + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, sessionId }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  // Ordinary chat reaches the model; a parked connector task does not.
  try {
    const catalog = (await (await fetch(base + "/api/connectors")).json()) as {
      connectors: Array<{ id: string; available: boolean }>;
    };
    const available = new Map(catalog.connectors.map((c) => [c.id, c.available]));
    for (const id of ["figma", "dropbox", "jira", "confluence"])
      assert.equal(available.get(id), false, id);
    for (const id of ["todoist", "outlook-mail", "sharepoint"])
      assert.equal(available.get(id), true, id);
    const session = (await (await fetch(base + "/session")).json()) as { id: string };
    const cards = async () =>
      (
        (await (await fetch(base + "/api/connectors?sessionId=" + session.id)).json()) as {
          requests: Array<{ provider: string }>;
        }
      ).requests;
    for (const message of [
      "What is Figma?",
      "I already use Dropbox",
      "what's the difference between Jira and Confluence",
      // A real read request for a source without a client is still an ordinary chat.
      "Read the Figma design for the login screen",
    ]) {
      const before = calls;
      await chat(message, session.id);
      assert.equal(calls, before + 1, message);
    }
    assert.deepEqual(await cards(), []);
    // A configured source still parks the task behind its card before any model call.
    assert.match(await chat("Summarize my Outlook inbox", session.id), /Outlook Mail/);
    assert.deepEqual(
      (await cards()).map((c) => c.provider),
      ["outlook-mail"],
    );
    assert.equal(calls, 4);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
