import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { T3ReadonlyDriver } from "../../src/connectors/t3-driver.js";
import { T3_SCOPE } from "../../src/connectors/t3-oauth.js";
import { loopbackAuthorization } from "../../src/connectors/oauth-loopback.js";
import type { Provider } from "../../src/providers/types.js";
import { MemorySecretStore } from "../../src/warden/secrets.js";

test.describe("T3 read-only connector", () => {
  test.use({ locale: "zh-CN" });
  let home: string, base: string, server: http.Server;
  let reads = 0;
  const secrets = new MemorySecretStore();
  const endpoint = "http://localhost:3773/mcp",
    origin = new URL(endpoint).origin;
  test.beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-t3-browser-"));
    Object.assign(process.env, {
      LISA_HOME: home,
      CLAUDE_HOME: path.join(home, "claude"),
      LISA_SOUL_GIT: "0",
      LISA_MAIL_POLL_MINUTES: "0",
      ANTHROPIC_API_KEY: "fixture-unused",
    });
    for (const key of [
      "LISA_EDITION",
      "K_SERVICE",
      "LISA_WEB_TOKEN",
      "LISA_BASE_URL",
      "LISA_PROVIDER",
      "LISA_MODEL_FALLBACK",
    ])
      delete process.env[key];
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "tests/e2e/helpers/make-soul.ts"],
      { env: process.env },
    );
    const driver = new T3ReadonlyDriver({
      endpoint,
      authorize: async (_endpoint, _fetcher, signal, progress) =>
        loopbackAuthorization(signal, origin, async (a) => {
          progress({
            authorizationUrl:
              origin +
              "/oauth/mcp/authorize?" +
              new URLSearchParams({
                client_id: "fixture",
                response_type: "code",
                state: a.state,
                redirect_uri: a.redirect,
                resource: endpoint,
                scope: T3_SCOPE,
                code_challenge_method: "S256",
                code_challenge: a.challenge,
              }),
          });
          await a.code;
          return {
            endpoint,
            clientId: "fixture",
            accessToken: "fixture-secret",
            scope: T3_SCOPE,
            expiry: Date.now() + 3600000,
          };
        }),
      fetch: () => async (raw) =>
        new Response(
          JSON.stringify(
            String(raw).endsWith("/session")
              ? { authenticated: true, scopes: [T3_SCOPE] }
              : { environmentId: "environment-1", label: "T3 fixture" },
          ),
        ),
      connect: async (_endpoint, _token, _fetcher, _signal, reviewed, work) => {
        expect([...reviewed]).toEqual(["t3_project_list", "t3_thread_list"]);
        return work({
          call: async (name, args) => {
            if (name === "t3_project_list")
              return {
                projects: [
                  { id: "project-1", title: "Selected project" },
                  { id: "project-2", title: "Other project" },
                ],
                nextCursor: null,
              };
            expect(name).toBe("t3_thread_list");
            expect(args).toEqual({
              projectId: "project-1",
              allProjects: false,
              includeSubagents: false,
              cursor: 0,
              limit: 30,
            });
            reads++;
            return {
              projectId: "project-1",
              total: 1,
              nextCursor: null,
              threads: [
                {
                  threadId: "thread-1",
                  projectId: "project-1",
                  title: "T3-FLOW-VERIFIED",
                  status: "idle",
                  createdAt: "2026-01-01",
                  updatedAt: "2026-01-02",
                  parentThreadId: null,
                  transcript: "NEVER_FORWARD",
                },
              ],
            };
          },
        });
      },
    });
    const provider: Provider = {
      name: "fixture",
      runTurn: async (opts) => {
        expect(opts.tools.map((t) => t.name)).toEqual(["t3_read"]);
        const messages = JSON.stringify(opts.messages);
        expect(messages).not.toContain("NEVER_FORWARD");
        const done = messages.includes("T3-FLOW-VERIFIED");
        return {
          content: done
            ? [{ type: "text", text: "T3 原任务已自动完成。", citations: null }]
            : [
                {
                  type: "tool_use",
                  id: "t3-read",
                  caller: { type: "direct" },
                  name: "t3_read",
                  input: { operation: "threads", resourceId: "project-1" },
                },
              ],
          stopReason: done ? "end_turn" : "tool_use",
          usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    const { startWebServer } = await import("../../src/web/server.js");
    server = await startWebServer({
      port: 0,
      tools: [],
      model: "claude-sonnet-4-6",
      thinking: false,
      reflect: false,
      idleMinutes: 0,
      provider,
      connectorSecrets: secrets,
      t3Driver: driver,
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function start(page: Page) {
    await page.goto(base);
    await page.locator("#sbNewSession").click();
    await page.locator("#input").fill("查看 T3 项目线程列表");
    await page.locator("#sendBtn").click();
    return page.getByRole("region", { name: "T3 Code 只读连接" });
  }
  test("explicit selected project → original task once → reload/reuse/local disconnect", async ({
    page,
  }) => {
    const card = await start(page);
    await expect(card).toContainText("Sharing & access");
    await card.getByRole("button", { name: "登录 T3（只读）", exact: true }).click();
    const link = card.getByRole("link", { name: "打开 T3 授权页面" });
    await expect(link).toBeVisible();
    const login = new URL((await link.getAttribute("href"))!);
    expect(login.searchParams.get("scope")).toBe(T3_SCOPE);
    const callback = new URL(login.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", login.searchParams.get("state")!);
    callback.searchParams.set("iss", origin);
    callback.searchParams.set("code", "fixture");
    expect((await fetch(callback)).status).toBe(200);
    const confirm = card.getByRole("button", { name: "只读连接并继续" });
    await expect(confirm).toBeDisabled();
    await expect(card.getByRole("checkbox")).toHaveCount(2);
    expect(reads).toBe(0);
    await page.reload();
    await card.getByRole("checkbox", { name: "Selected project", exact: true }).check();
    await confirm.click();
    await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
    const result = page.locator("#log .msg").filter({ hasText: "T3 原任务已自动完成。" });
    await expect(result).toHaveCount(1);
    await page.reload();
    await expect(result).toHaveCount(1);
    expect(reads).toBe(1);
    await start(page);
    await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
    expect(reads).toBe(2);
    await card.getByRole("button", { name: "断开 LISA 连接" }).click();
    await expect.poll(async () => (await secrets.list()).length).toBe(0);
  });
  test("cancelled sign-in closes the callback without reading projects", async ({ page }) => {
    const before = reads,
      card = await start(page);
    await card.getByRole("button", { name: "登录 T3（只读）", exact: true }).click();
    const link = card.getByRole("link", { name: "打开 T3 授权页面" });
    await expect(link).toBeVisible();
    const callback = new URL(
      new URL((await link.getAttribute("href"))!).searchParams.get("redirect_uri")!,
    );
    await card.getByRole("button", { name: "取消此任务" }).click();
    await expect(card.getByText("任务已取消", { exact: true })).toBeVisible();
    await expect(fetch(callback)).rejects.toThrow();
    expect(reads).toBe(before);
    expect((await secrets.list()).length).toBe(0);
  });
});
