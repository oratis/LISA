import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { FeishuReadonlyDriver } from "../../src/connectors/feishu-driver.js";
import { FEISHU_SCOPES } from "../../src/connectors/feishu-http.js";
import type { Provider } from "../../src/providers/types.js";

test.describe("Feishu read-only connector", () => {
  test.use({ locale: "zh-CN" });
  let home: string, base: string, server: http.Server;
  let reads = 0,
    revokes = 0;
  const doc = { id: "doxbcmEtbFrbbq10nPNu8gabcef", name: "Fixture document" };
  test.beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-feishu-browser-"));
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
    const driver = new FeishuReadonlyDriver({
      client: async () => ({
        clientId: "cli_test12345678",
        clientSecret: "fixture-secret",
        redirectUri: `http://localhost:${port}/oauth/feishu`,
      }),
      http: async (url, _signal, init) => {
        if (url.endsWith("/token")) {
          expect(init?.form?.code_verifier).toBeTruthy();
          expect(init?.form?.scope).toBe(FEISHU_SCOPES.join(" "));
          return {
            code: 0,
            access_token: "fixture-access",
            refresh_token: "fixture-refresh",
            expires_in: 7200,
            refresh_token_expires_in: 86400,
            token_type: "Bearer",
            scope: FEISHU_SCOPES.join(" "),
          };
        }
        if (url.endsWith("/user_info"))
          return { data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", name: "Fixture" } };
        if (url.endsWith("/" + doc.id))
          return { data: { document: { document_id: doc.id, title: doc.name, revision_id: 1 } } };
        if (url.endsWith("/revoke")) {
          revokes++;
          return {};
        }
        expect(url).toBe(
          "https://open.feishu.cn/open-apis/docx/v1/documents/" + doc.id + "/raw_content",
        );
        reads++;
        return { data: { content: "FEISHU-FLOW-VERIFIED" } };
      },
    });
    const provider: Provider = {
      name: "fixture",
      runTurn: async (opts) => {
        expect(opts.tools.map((t) => t.name)).toEqual(["feishu_read"]);
        const done = JSON.stringify(opts.messages).includes("FEISHU-FLOW-VERIFIED");
        return {
          content: done
            ? [
                {
                  type: "text",
                  text: "飞书原任务已自动完成：19 字符，未截断。",
                  citations: null,
                },
              ]
            : [
                {
                  type: "tool_use",
                  id: "feishu-read",
                  caller: { type: "direct" },
                  name: "feishu_read",
                  input: { operation: "content", resourceId: doc.id },
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
      feishuDriver: driver,
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
  test("PKCE callback → explicit document card → original task once → reload/reuse/disconnect", async ({
    page,
  }) => {
    await start(page, "只读查看飞书选定文档，只返回字符数");
    const card = page.getByRole("region", { name: "飞书 只读连接" });
    await card.getByRole("button", { name: "登录飞书，只读连接", exact: true }).click();
    const link = card.getByRole("link", { name: "打开飞书授权页面" });
    await expect(link).toBeVisible();
    const login = new URL((await link.getAttribute("href"))!);
    expect(login.searchParams.get("scope")).toBe(FEISHU_SCOPES.join(" "));
    expect(login.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(login.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", login.searchParams.get("state")!);
    callback.searchParams.set("code", "fixture");
    expect((await fetch(callback)).status).toBe(200);
    const confirm = card.getByRole("button", { name: "只读连接并继续" });
    await expect(confirm).toBeDisabled();
    await expect(card.getByRole("checkbox")).toHaveCount(0);
    expect(reads).toBe(0);
    await page.reload();
    const input = card.getByRole("textbox", { name: "飞书文档链接或 ID" });
    await input.fill("https://evil.example/docx/" + doc.id);
    await card.getByRole("button", { name: "添加文档", exact: true }).click();
    await expect(card.locator(".github-error")).toContainText("请输入飞书 docx");
    await expect(confirm).toBeDisabled();
    await input.fill("https://example.feishu.cn/docx/" + doc.id + "?from=copy");
    await card.getByRole("button", { name: "添加文档", exact: true }).click();
    await expect(card.getByRole("checkbox", { name: doc.id, exact: true })).toBeChecked();
    expect(reads).toBe(0);
    await confirm.click();
    await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
    await expect(card.getByText(doc.name, { exact: true })).toBeVisible();
    const result = page
      .locator("#log .msg")
      .filter({ hasText: "飞书原任务已自动完成：19 字符，未截断。" });
    await expect(result).toHaveCount(1);
    await page.reload();
    await expect(result).toHaveCount(1);
    expect(reads).toBe(1);
    await start(page, "总结飞书选定文档");
    await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
    expect(reads).toBe(2);
    await card.getByRole("button", { name: "断开 LISA 连接" }).click();
    await expect(card.getByRole("button", { name: "断开 LISA 连接" })).toHaveCount(0);
    expect(revokes).toBe(2);
  });
  test("combined sources stay parked; cancelling authorization closes callback without reading", async ({
    page,
  }) => {
    await start(page, "查看飞书和 Notion 中的文档");
    await expect(page.locator("#log")).toContainText("目前每条连接任务支持一个来源");
    await expect(page.getByRole("region", { name: /只读连接/ })).toHaveCount(0);
    await start(page, "查看飞书文档");
    const card = page.getByRole("region", { name: "飞书 只读连接" });
    await card.getByRole("button", { name: "登录飞书，只读连接" }).click();
    const link = card.getByRole("link", { name: "打开飞书授权页面" });
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
