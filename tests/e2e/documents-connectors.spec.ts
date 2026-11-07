import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { DriveReadonlyDriver } from "../../src/connectors/drive-driver.js";
import { NotionReadonlyDriver } from "../../src/connectors/notion-driver.js";
import { GOOGLE_SCOPES } from "../../src/connectors/google-oauth.js";
import type { Provider } from "../../src/providers/types.js";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fileId = "fixture-document-id";
const pageId = uuid(4);
test.describe("document connectors", () => {
  test.use({ locale: "zh-CN" });
  let home: string, base: string, server: http.Server;
  const reads = { drive: 0, notion: 0 };
  test.beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-documents-browser-"));
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
    const drive = new DriveReadonlyDriver({
      client: async () => ({ clientId: "fixture.apps.googleusercontent.com" }),
      http: async (url, _s, init) => {
        if (url.includes("/token")) {
          expect(init?.form?.get("code_verifier")).toBeTruthy();
          return {
            access_token: "drive-access",
            refresh_token: "drive-refresh",
            expires_in: 3600,
            scope: GOOGLE_SCOPES.driveFile[0],
          };
        }
        if (url.includes("/about?"))
          return {
            user: {
              permissionId: "fixture-account",
              displayName: "Fixture",
              email: "fixture@example.com",
            },
          };
        expect(new URL(url).pathname).toBe("/drive/v3/files/" + fileId);
        return {
          id: fileId,
          name: "Fixture document",
          mimeType: "text/plain",
          capabilities: { canDownload: true },
        };
      },
      content: () => async () => {
        reads.drive++;
        return new Response("DOCUMENT-FLOW-VERIFIED");
      },
    });
    // Port 0 chooses a free loopback port while retaining real state validation.
    const { loopbackAuthorization } = await import("../../src/connectors/oauth-loopback.js");
    const notion = new NotionReadonlyDriver({
      client: async () => ({
        clientId: uuid(1),
        clientSecret: "fixture-secret",
        redirectUri: "http://localhost:4860/oauth/notion",
      }),
      authorize: async (client, http, signal, progress) =>
        loopbackAuthorization(
          signal,
          null,
          async (a) => {
            progress({
              authorizationUrl:
                "https://api.notion.com/v1/oauth/authorize?" +
                new URLSearchParams({
                  client_id: client.clientId,
                  response_type: "code",
                  owner: "user",
                  state: a.state,
                  redirect_uri: a.redirect,
                }),
            });
            await a.code;
            return {
              ...client,
              accessToken: "notion-access",
              refreshToken: "notion-refresh",
              workspaceId: uuid(2),
              workspaceName: "Fixture workspace",
              botId: uuid(3),
            };
          },
          { hostname: "localhost", pathname: "/oauth/notion" },
        ),
      http: async (route) => {
        if (route === "/v1/oauth/introspect") return { active: true, scope: "read_content" };
        if (route === "/v1/users/me")
          return { object: "user", type: "bot", id: uuid(3), name: "Fixture" };
        const page = {
          object: "page",
          id: pageId,
          properties: { title: { type: "title", title: [{ plain_text: "Fixture page" }] } },
        };
        if (route === "/v1/search") return { object: "list", results: [page], has_more: false };
        if (route === "/v1/pages/" + pageId) return page;
        expect(route).toContain("/v1/blocks/" + pageId + "/children?");
        reads.notion++;
        return {
          object: "list",
          results: [
            {
              object: "block",
              id: uuid(5),
              type: "paragraph",
              parent: { type: "page_id", page_id: pageId },
              paragraph: { rich_text: [{ plain_text: "DOCUMENT-FLOW-VERIFIED" }] },
            },
          ],
          has_more: false,
        };
      },
    });
    const provider: Provider = {
      name: "fixture",
      runTurn: async (opts) => {
        const tool = opts.tools[0]!.name;
        expect(["google_drive_read", "notion_read"]).toContain(tool);
        expect(opts.tools).toHaveLength(1);
        const done = JSON.stringify(opts.messages).includes("DOCUMENT-FLOW-VERIFIED");
        return {
          content: done
            ? [{ type: "text", text: "文档只读任务已自动完成。", citations: null }]
            : [
                {
                  type: "tool_use",
                  id: "document-read",
                  caller: { type: "direct" },
                  name: tool,
                  input: {
                    operation: "content",
                    resourceId: tool === "notion_read" ? pageId : fileId,
                  },
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
      driveDriver: drive,
      notionDriver: notion,
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
  for (const source of ["drive", "notion"] as const)
    test(
      source +
        " callback → explicit resource card → original task exactly once → reuse and disconnect",
      async ({ page }) => {
        const drive = source === "drive",
          name = drive ? "Google Drive" : "Notion";
        await start(page, "只读查看 " + name + " 中选定的文档");
        const card = page.getByRole("region", { name: name + " 只读连接" });
        await card
          .getByRole("button", {
            name: drive ? "登录 Google 并选择文件" : "登录 Notion，只读连接",
            exact: true,
          })
          .click();
        const link = card.getByRole("link", {
          name: drive ? "打开 Google 授权页面" : "打开 Notion 授权页面",
        });
        await expect(link).toBeVisible();
        const login = new URL((await link.getAttribute("href"))!);
        const callback = new URL(login.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", login.searchParams.get("state")!);
        callback.searchParams.set("code", "fixture");
        if (drive) {
          expect(login.searchParams.get("scope")).toBe(GOOGLE_SCOPES.driveFile[0]);
          expect(login.searchParams.get("trigger_onepick")).toBe("true");
          callback.searchParams.set("picked_file_ids", fileId);
        }
        expect((await fetch(callback)).status).toBe(200);
        const confirm = card.getByRole("button", { name: "只读连接并继续" });
        await expect(confirm).toBeDisabled();
        await expect(card.getByRole("checkbox")).toHaveCount(1);
        expect(reads[source]).toBe(0);
        await page.reload();
        await card
          .getByRole("checkbox", { name: drive ? "Fixture document" : "Fixture page", exact: true })
          .check();
        await confirm.click();
        await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
        const result = page.locator("#log .msg").filter({ hasText: "文档只读任务已自动完成。" });
        await expect(result).toHaveCount(1);
        await page.reload();
        await expect(result).toHaveCount(1);
        expect(reads[source]).toBe(1);
        await start(page, "总结 " + name + " 文件和页面");
        await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
        expect(reads[source]).toBe(2);
        await card.getByRole("button", { name: "断开 LISA 连接" }).click();
        await expect(card.getByRole("button", { name: "断开 LISA 连接" })).toHaveCount(0);
      },
    );
  test("combined sources stay parked and do not read half a request", async ({ page }) => {
    await start(page, "查看 Google Drive 和 Notion 的文档");
    await expect(page.locator("#log")).toContainText("目前每条连接任务支持一个来源");
    await expect(page.getByRole("region", { name: /只读连接/ })).toHaveCount(0);
  });
  test("cancellation closes the pending callback without reading", async ({ page }) => {
    await start(page, "查看 Google Drive 文件");
    const card = page.getByRole("region", { name: "Google Drive 只读连接" });
    await card.getByRole("button", { name: "登录 Google 并选择文件" }).click();
    const link = card.getByRole("link", { name: "打开 Google 授权页面" });
    await expect(link).toBeVisible();
    const callback = new URL(
      new URL((await link.getAttribute("href"))!).searchParams.get("redirect_uri")!,
    );
    await card.getByRole("button", { name: "取消此任务" }).click();
    await expect(card.getByText("任务已取消", { exact: true })).toBeVisible();
    await expect(fetch(callback)).rejects.toThrow();
    expect(reads.drive).toBe(2);
  });
});
