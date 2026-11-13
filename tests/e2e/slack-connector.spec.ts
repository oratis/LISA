import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SlackReadonlyDriver } from "../../src/connectors/slack-driver.js";
import { SLACK_READ_SCOPES } from "../../src/connectors/slack-http.js";
import type { Provider } from "../../src/providers/types.js";

test.describe("Slack read-only connector", () => {
  test.use({ locale: "zh-CN" });
  let home: string, base: string, server: http.Server;
  let reads = 0,
    revokes = 0;
  const channel = { id: "CTEST1", name: "fixture", is_private: false, is_shared: false };
  test.beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-slack-browser-"));
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
    const portServer = http.createServer();
    await new Promise<void>((r) => portServer.listen(0, "127.0.0.1", r));
    const port = (portServer.address() as AddressInfo).port;
    await new Promise<void>((r) => portServer.close(() => r()));
    const driver = new SlackReadonlyDriver({
      client: async () => ({
        clientId: "12345.67890",
        appId: "ATEST1",
        redirectUri: `http://localhost:${port}/oauth/slack`,
      }),
      http: async (method, _signal, init) => {
        if (method === "oauth.v2.access") {
          expect(init?.form?.code_verifier).toBeTruthy();
          expect(init?.form?.client_secret).toBeUndefined();
          return {
            data: {
              ok: true,
              app_id: "ATEST1",
              team: { id: "TTEST1" },
              authed_user: {
                id: "UTEST1",
                scope: SLACK_READ_SCOPES.join(","),
                access_token: "fixture-access",
                refresh_token: "fixture-refresh",
                expires_in: 43200,
                token_type: "user",
              },
            },
          };
        }
        if (method === "auth.test")
          return {
            data: {
              user_id: "UTEST1",
              team_id: "TTEST1",
              user: "Fixture",
              team: "Fixture workspace",
            },
            scopes: ["identify", ...SLACK_READ_SCOPES],
          };
        if (method === "users.conversations")
          return {
            data: {
              channels: [channel, { ...channel, id: "CSHARED", name: "shared", is_shared: true }],
              response_metadata: { next_cursor: "" },
            },
          };
        if (method === "conversations.info") {
          expect(init?.form?.channel).toBe(channel.id);
          return { data: { channel: { ...channel, is_member: true } } };
        }
        if (method === "auth.revoke") {
          revokes++;
          return { data: { ok: true, revoked: true } };
        }
        expect(method).toBe("conversations.history");
        expect(init?.form?.channel).toBe(channel.id);
        reads++;
        return {
          data: {
            messages: [
              { ts: ((Date.now() - 1000) / 1000).toFixed(6), text: "SLACK-FLOW-VERIFIED" },
            ],
            has_more: false,
          },
        };
      },
    });
    const provider: Provider = {
      name: "fixture",
      runTurn: async (opts) => {
        expect(opts.tools.map((t) => t.name)).toEqual(["slack_read"]);
        const done = JSON.stringify(opts.messages).includes("SLACK-FLOW-VERIFIED");
        return {
          content: done
            ? [
                {
                  type: "text",
                  text: "Slack 原任务已自动完成：1 条消息，未截断。",
                  citations: null,
                },
              ]
            : [
                {
                  type: "tool_use",
                  id: "slack-read",
                  caller: { type: "direct" },
                  name: "slack_read",
                  input: { operation: "messages", resourceId: channel.id },
                },
              ],
          stopReason: done ? "end_turn" : "tool_use",
          usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    const { startWebServer } = await import("../../src/web/server.js");
    const { MemorySecretStore } = await import("../../src/warden/secrets.js");
    server = await startWebServer({
      port: 0,
      tools: [],
      model: "claude-sonnet-4-6",
      thinking: false,
      reflect: false,
      idleMinutes: 0,
      provider,
      connectorSecrets: new MemorySecretStore(),
      slackDriver: driver,
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function start(page: Page, prompt: string) {
    await page.goto(base);
    await page.locator("#sbNewSession").click();
    await page.locator("#input").fill(prompt);
    await page.locator("#sendBtn").click();
  }
  test("browse read-only examples, preserve a draft, and look up apps while a card waits", async ({
    page,
  }) => {
    await page.goto(base);
    await page.locator("#sbNewSession").click();
    const draft = page.locator("#input");
    await draft.fill("只返回数量。");
    await page.locator("#plusBtn").click();
    await page.getByRole("button", { name: "浏览应用连接器", exact: true }).click();
    const panel = page.locator("#modalBody");
    await expect(panel.getByRole("button")).toHaveCount(7);
    await panel.getByRole("button", { name: "Slack · 将示例加入草稿" }).click();
    await expect(draft).toHaveValue(/只返回数量。\n总结我选定的 Slack/);
    const card = page.getByRole("region", { name: "Slack 只读连接" });
    await expect(card).toHaveCount(0);
    await page.locator("#sendBtn").click();
    await expect(card.getByRole("button", { name: "登录 Slack，只读连接" })).toBeVisible();
    await draft.fill("/connectors Gmail");
    await page.locator("#sendBtn").click();
    await expect(page.locator("#log .msg").last()).toContainText("Gmail");
    await page.reload();
    await expect(page.locator("#log")).toContainText("Gmail");
    await expect(card.getByRole("button", { name: "登录 Slack，只读连接" })).toBeVisible();
    await card.getByRole("button", { name: "取消此任务" }).click();
  });
  test("PKCE callback → unchecked channel card → original task once → reload/reuse/disconnect", async ({
    page,
  }) => {
    await start(page, "只读查看 Slack 选定频道最近七天的消息，只返回数量");
    const card = page.getByRole("region", { name: "Slack 只读连接" });
    await card.getByRole("button", { name: "登录 Slack，只读连接", exact: true }).click();
    const link = card.getByRole("link", { name: "打开 Slack 授权页面" });
    await expect(link).toBeVisible();
    const login = new URL((await link.getAttribute("href"))!);
    expect(login.searchParams.get("user_scope")).toBe(SLACK_READ_SCOPES.join(","));
    expect(login.searchParams.get("scope")).toBe("");
    expect(login.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(login.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", login.searchParams.get("state")!);
    callback.searchParams.set("code", "fixture");
    expect((await fetch(callback)).status).toBe(200);
    const confirm = card.getByRole("button", { name: "只读连接并继续" });
    await expect(confirm).toBeDisabled();
    await expect(card.getByRole("checkbox")).toHaveCount(1);
    expect(reads).toBe(0);
    await page.locator("#input").fill("/connectors Gmail");
    await page.locator("#sendBtn").click();
    await expect(page.locator("#log .msg").last()).toContainText("Gmail");

    await page.reload();
    await card.getByRole("checkbox", { name: "#fixture", exact: true }).check();
    await confirm.click();
    await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
    const result = page
      .locator("#log .msg")
      .filter({ hasText: "Slack 原任务已自动完成：1 条消息，未截断。" });
    await expect(result).toHaveCount(1);
    await page.reload();
    await expect(result).toHaveCount(1);
    expect(reads).toBe(1);
    await start(page, "总结 Slack 选定频道的消息");
    await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
    expect(reads).toBe(2);
    await card.getByRole("button", { name: "断开 LISA 连接" }).click();
    await expect(card.getByRole("button", { name: "断开 LISA 连接" })).toHaveCount(0);
    expect(revokes).toBe(1);
  });
  test("combined sources stay parked; cancelling authorization closes callback without reading", async ({
    page,
  }) => {
    await start(page, "查看 Slack 和 Notion 中的消息和文档");
    await expect(page.locator("#log")).toContainText("目前每条连接任务支持一个来源");
    await expect(page.getByRole("region", { name: /只读连接/ })).toHaveCount(0);
    await start(page, "查看 Slack 频道消息");
    const card = page.getByRole("region", { name: "Slack 只读连接" });
    await card.getByRole("button", { name: "登录 Slack，只读连接" }).click();
    const link = card.getByRole("link", { name: "打开 Slack 授权页面" });
    await expect(link).toBeVisible();
    const callback = new URL(
      new URL((await link.getAttribute("href"))!).searchParams.get("redirect_uri")!,
    );
    await card.getByRole("button", { name: "取消此任务" }).click();
    await expect(card.getByText("任务已取消", { exact: true })).toBeVisible();
    await expect(fetch(callback)).rejects.toThrow();
    expect(reads).toBe(2);
  });
});
