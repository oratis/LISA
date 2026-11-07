import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Provider } from "../providers/types.js";
import type { GitHubDriver } from "../connectors/github-driver.js";
import { MemorySecretStore } from "../warden/secrets.js";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-github-web-"));
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
const { startWebServer } = await import("./server.js");
const repo = { id: 42, fullName: "octocat/project", private: true };
const account = { id: 12, login: "octocat" };
let calls = 0,
  reads = 0,
  auths = 0;
const driver: GitHubDriver = {
  authorize: async () => {
    auths++;
    return { token: "never-show-this-token", account };
  },
  account: async () => account,
  repositories: async () => [repo],
  repository: async () => repo,
  read: async () => {
    reads++;
    return { commits: ["Fix connector recovery"] };
  },
};
const provider: Provider = {
  name: "fixture",
  runTurn: async (opts) => {
    calls++;
    assert.deepEqual(
      opts.tools.map((t) => t.name),
      ["github_read"],
    );
    assert.ok(opts.systemPrompt.includes("总结 GitHub 最近工作"));
    const gotResult = JSON.stringify(opts.messages).includes("Fix connector recovery");
    return {
      content: gotResult
        ? [{ type: "text", text: "GitHub 工作总结：最近修复了连接恢复。", citations: null }]
        : [
            {
              type: "tool_use",
              id: "gh-read-1",
              name: "github_read",
              caller: { type: "direct" },
              input: { operation: "commits", repository: repo.fullName },
            },
          ],
      stopReason: gotResult ? "end_turn" : "tool_use",
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};
const secrets = new MemorySecretStore();
async function boot(selectedProvider: Provider = provider) {
  const server = await startWebServer({
    port: 0,
    tools: [],
    model: "fixture",
    thinking: false,
    reflect: false,
    idleMinutes: 0,
    githubDriver: driver,
    githubSecrets: secrets,
    provider: selectedProvider,
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    base,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function waitFor(fn: () => Promise<boolean>) {
  const end = Date.now() + 8000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const post = (base: string, route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
after(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("real HTTP chat/card/auth/selection/automatic resume/reload/restart and connection reuse", async () => {
  const first = await boot();
  const session = (await (await fetch(first.base + "/session")).json()) as { id: string };
  const route = "/api/connectors/github/requests?sessionId=" + session.id;
  const list = async (base = first.base) =>
    (
      (await (await fetch(base + route)).json()) as {
        requests: Array<{ id: string; status: string }>;
      }
    ).requests;
  try {
    const chat = await post(first.base, "/chat", {
      message: "总结 GitHub 最近工作",
      sessionId: session.id,
    });
    assert.equal(chat.status, 200);
    assert.ok((await chat.text()).includes("自动继续"));
    const r = (await list())[0]!;
    assert.equal(r.status, "waiting");
    assert.equal(calls, 0);
    assert.equal(auths, 0);
    const action = `/api/connectors/github/requests/${r.id}/`;
    for (const headers of [
      { origin: "https://hostile.example" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      const denied = await post(first.base, action + "authorize", { mode: "existing" }, headers);
      assert.equal(denied.status, 403, JSON.stringify(headers));
    }
    const rebound = await new Promise<number>((resolve) => {
      http.get(first.base + route, { headers: { host: "hostile.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
    });
    assert.equal(rebound, 403);
    assert.equal(auths, 0);
    const badType = await fetch(first.base + action + "authorize", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(badType.status, 415);
    assert.equal((await post(first.base, action + "authorize", { mode: "existing" })).status, 200);
    await waitFor(async () => (await list())[0]?.status === "selecting");
    const repos = await (await fetch(first.base + action + "repositories")).json();
    assert.deepEqual(repos, { repositories: [repo] });
    assert.equal(calls, 0);
    assert.equal(
      (await post(first.base, action + "confirm", { repositories: [repo.fullName] })).status,
      200,
    );
    await waitFor(async () => (await list())[0]?.status === "completed");
    assert.equal(reads, 1);
    assert.equal(calls, 2);
    assert.equal(
      (await post(first.base, action + "confirm", { repositories: ["other/not-allowed"] })).status,
      200,
    );
    const history = await (await fetch(first.base + "/api/history?sessionId=" + session.id)).text();
    assert.equal(history.split("GitHub 工作总结").length - 1, 1);
    assert.ok(!history.includes("never-show-this-token"));
    await first.close();
    const second = await boot();
    try {
      assert.equal((await list(second.base))[0]?.status, "completed");
      assert.equal(calls, 2);
      const again = await post(second.base, "/chat", {
        message: "总结 GitHub 最近工作",
        sessionId: session.id,
      });
      await again.text();
      await waitFor(async () => (await list(second.base))[1]?.status === "completed");
      assert.equal(auths, 1);
      assert.equal(reads, 2);
      assert.equal((await post(second.base, "/api/connectors/github/disconnect", {})).status, 200);
      assert.equal((await secrets.list()).length, 0);
    } finally {
      await second.close();
    }
  } finally {
    if (first.server.listening) await first.close();
  }
});

test("cloud edition denies connector metadata and authorization before touching local credentials", async () => {
  process.env.LISA_EDITION = "cloud";
  process.env.LISA_PUBLIC_ORIGIN = "https://lisa.example";
  process.env.LISA_WEB_TOKEN = "fixture-cloud-gate";
  const server = await boot();
  try {
    const before = auths;
    const response = await fetch(server.base + "/api/connectors/github/requests?sessionId=test", {
      headers: { authorization: "Bearer fixture-cloud-gate" },
    });
    assert.equal(response.status, 403);
    const authorize = await post(
      server.base,
      "/api/connectors/github/requests/test/authorize",
      { mode: "existing" },
      { authorization: "Bearer fixture-cloud-gate" },
    );
    assert.equal(authorize.status, 403);
    for (const route of [
      "/api/connectors",
      "/api/connectors/google-calendar/requests?sessionId=test",
      "/api/connectors/gmail/requests?sessionId=test",
      "/api/connectors/linear/requests?sessionId=test",
    ]) {
      assert.equal(
        (
          await fetch(server.base + route, {
            headers: { authorization: "Bearer fixture-cloud-gate" },
          })
        ).status,
        403,
      );
    }
    assert.equal(auths, before);
  } finally {
    await server.close();
    delete process.env.LISA_EDITION;
    delete process.env.LISA_PUBLIC_ORIGIN;
    delete process.env.LISA_WEB_TOKEN;
  }
});

test("a corrupt connector store blocks GitHub continuation but leaves ordinary chat usable", async () => {
  const file = path.join(home, "connectors/github/state.json");
  const previous = await fs.readFile(file, "utf8");
  await fs.writeFile(file, "{corrupt");
  let normalCalls = 0;
  const instance = await boot({
    name: "fixture",
    runTurn: async (opts) => {
      normalCalls++;
      opts.handlers?.onTextDelta?.("ordinary chat still works");
      return {
        content: [{ type: "text", text: "ordinary chat still works", citations: null }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  });
  try {
    const normal = await post(instance.base, "/chat", { message: "你好" });
    assert.ok((await normal.text()).includes("ordinary chat still works"));
    const github = await post(instance.base, "/chat", { message: "总结 GitHub 最近工作" });
    assert.ok((await github.text()).includes("connector_state_unavailable"));
    assert.equal(normalCalls, 1);
    assert.equal(await fs.readFile(file, "utf8"), "{corrupt");
  } finally {
    await instance.close();
    await fs.writeFile(file, previous);
  }
});
