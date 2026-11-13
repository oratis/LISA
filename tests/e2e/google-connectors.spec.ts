import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { GoogleReadonlyDriver } from "../../src/connectors/google-driver.js";
import { GOOGLE_SCOPES } from "../../src/connectors/google-oauth.js";
import { authorizeGoogle } from "../../src/connectors/google-oauth.js";
import type { Provider } from "../../src/providers/types.js";

test.describe("Google read-only connections", () => {
  test.use({ locale: "zh-CN" });
  let home: string, base: string, server: http.Server;
  let reads = 0;
  const account = { sub: "123", email: "fixture@example.com", email_verified: true };
  const labels = [
    { id: "INBOX", name: "收件箱" },
    ...[
      "已加星标",
      "工作邮件",
      "会议",
      "财务",
      "收据",
      "项目更新",
      "私人邮件",
      "旅行",
      "稍后阅读",
    ].map((name, i) => ({ id: `Label_${i}`, name })),
  ];
  test.beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-google-browser-"));
    Object.assign(process.env, {
      LISA_HOME: home,
      HOME: path.join(home, "user"),
      CLAUDE_HOME: path.join(home, "claude"),
      LISA_SOUL_GIT: "0",
      LISA_MAIL_POLL_MINUTES: "0",
      ANTHROPIC_API_KEY: "fixture-unused",
      LISA_LOG_FORMAT: "text",
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
    await fs.mkdir(process.env.HOME!, { recursive: true });
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "tests/e2e/helpers/make-soul.ts"],
      { env: process.env },
    );
    const { startWebServer } = await import("../../src/web/server.js");
    const { MemorySecretStore } = await import("../../src/warden/secrets.js");
    function driver(id: "gmail" | "google-calendar") {
      let granted: readonly string[] = [];
      return new GoogleReadonlyDriver(id, {
        client: async () => ({ clientId: "fixture.apps.googleusercontent.com" }),
        authorize: (client, scopes, signal, progress, request) => {
          granted = scopes;
          return authorizeGoogle(client, scopes, signal, progress, request);
        },
        http: async (url, _signal, init) => {
          if (url.endsWith("/token"))
            return {
              access_token: "browser-access-token",
              refresh_token: "browser-refresh-token",
              expires_in: 3600,
              scope: granted.join(" "),
            };
          if (url.includes("userinfo")) return account;
          if (url.includes("/calendarList")) {
            const calendar = {
              id: account.email,
              summary: "Work calendar",
              timeZone: "Asia/Shanghai",
              accessRole: "owner",
            };
            return url.includes("/calendarList/") ? calendar : { items: [calendar] };
          }
          if (url.endsWith("/labels")) return { labels };
          if (url.includes("/labels/"))
            return labels.find((label) => url.endsWith("/" + label.id))!;
          reads++;
          if (url.includes("/events?"))
            return {
              timeZone: "Asia/Shanghai",
              items: [
                {
                  id: "one",
                  summary: "GOOGLE-FLOW-VERIFIED",
                  start: { date: "2026-11-07" },
                  end: { date: "2026-11-08" },
                },
              ],
            };
          if (url.includes("/messages?")) return { messages: [{ id: "mail1" }] };
          if (url.includes("/messages/mail1"))
            return {
              id: "mail1",
              labelIds: ["INBOX"],
              internalDate: String(Date.parse("2026-11-07T03:00:00Z")),
              snippet: "GOOGLE-FLOW-VERIFIED",
              payload: { headers: [{ name: "Subject", value: "Meeting" }] },
            };
          if (url.includes("/freeBusy")) {
            expect(init?.json).toBeDefined();
            return { calendars: { [account.email]: { busy: [] } } };
          }
          throw new Error("Unexpected fixture request");
        },
      });
    }
    const provider: Provider = {
      name: "fixture",
      runTurn: async (opts) => {
        const done = JSON.stringify(opts.messages).includes("GOOGLE-FLOW-VERIFIED");
        const mail = opts.systemPrompt.includes("granted gmail");
        return {
          content: done
            ? [{ type: "text", text: "Google 只读任务已自动完成。", citations: null }]
            : [
                {
                  type: "tool_use",
                  id: "google-read",
                  caller: { type: "direct" },
                  name: mail ? "gmail_read" : "google_calendar_read",
                  input: {
                    operation: mail ? "messages" : "events",
                    resourceId: mail ? "INBOX" : account.email,
                    timeMin: "2026-11-07T00:00:00+08:00",
                    timeMax: "2026-11-08T00:00:00+08:00",
                  },
                },
              ],
          stopReason: done ? "end_turn" : "tool_use",
          usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    server = await startWebServer({
      port: 0,
      tools: [],
      model: "claude-sonnet-4-6",
      thinking: false,
      reflect: false,
      idleMinutes: 0,
      provider,
      connectorSecrets: new MemorySecretStore(),
      googleDrivers: { gmail: driver("gmail"), "google-calendar": driver("google-calendar") },
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function start(page: Page, prompt: string) {
    await page.goto(base);
    await page.locator("#sbNewSession").click();
    await page.locator("#input").fill(prompt);
    await page.locator("#sendBtn").click();
  }
  for (const [name, prompt, button, resource] of [
    ["Google Calendar", "查看 Google Calendar 明天日程", "连接日历，读取日程详情", "Work calendar"],
    ["Gmail", "总结 Gmail 今天邮件", "登录 Google，连接 Gmail", "收件箱"],
  ]) {
    test(`${name}: OAuth callback → resource selection → automatic same-chat result → reload`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      if (name === "Gmail") await page.emulateMedia({ colorScheme: "dark" });
      await start(page, prompt!);
      const card = page.getByRole("region", { name: `${name} 只读连接` });
      await card.getByRole("button", { name: button!, exact: true }).click();
      const link = card.getByRole("link", { name: "打开 Google 授权页面" });
      await expect(link).toBeVisible();
      const login = new URL((await link.getAttribute("href"))!);
      expect(login.searchParams.get("scope")).toContain(
        name === "Gmail" ? GOOGLE_SCOPES.gmail[0] : GOOGLE_SCOPES.events[0],
      );
      await page.reload();
      await expect(link).toBeVisible();
      const callback = new URL(login.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", login.searchParams.get("state")!);
      callback.searchParams.set("code", "fixture-code");
      expect((await fetch(callback)).ok).toBe(true);
      const confirm = card.getByRole("button", { name: "只读连接并继续" });
      await expect(confirm).toBeDisabled();
      await expect(card.getByText(account.email, { exact: true })).toBeVisible();
      if (name === "Gmail") {
        const all = card.getByRole("button", { name: "全选", exact: true });
        const checked = card.getByRole("checkbox", { checked: true });
        await expect(all).toBeEnabled();
        await expect(checked).toHaveCount(0);
        await all.focus();
        await page.keyboard.press("Space");
        await expect(checked).toHaveCount(labels.length);
        await expect(confirm).toBeEnabled();
        await card.getByRole("button", { name: "清空选择" }).click();
        await expect(checked).toHaveCount(0);
        await expect(confirm).toBeDisabled();
        await all.click();
        await card.getByRole("checkbox", { name: "财务" }).uncheck();
        await expect(card.getByText("已选 9 / 10 项")).toBeVisible();
      } else {
        await card.getByRole("checkbox", { name: resource!, exact: true }).check();
      }
      await fs.mkdir(".tmp", { recursive: true });
      await card.screenshot({
        path: `.tmp/${name === "Gmail" ? "gmail" : "calendar"}-connection-card.png`,
      });
      if (name === "Gmail") {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: "light" });
        await card.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
        await card.screenshot({ path: ".tmp/gmail-connection-card-mobile.png" });
      }
      const payload = page.waitForRequest((req) => req.url().endsWith("/confirm"));
      await confirm.click();
      const { resources } = (await payload).postDataJSON();
      expect(resources).toEqual(
        name === "Gmail"
          ? labels.filter((label) => label.name !== "财务").map((label) => label.id)
          : [account.email],
      );
      await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
      await expect(
        page.locator("#log .msg").filter({ hasText: "Google 只读任务已自动完成。" }),
      ).toHaveCount(1);
      await page.reload();
      await expect(
        page.locator("#log .msg").filter({ hasText: "Google 只读任务已自动完成。" }),
      ).toHaveCount(1);
      await card.getByRole("button", { name: "断开 LISA 连接" }).click();
      await expect(card.getByRole("button", { name: "断开 LISA 连接" })).toHaveCount(0);
    });
  }
  test("Gmail bulk selection respects pagination and keeps manually chosen labels at the limit", async ({
    page,
  }) => {
    // Non-GitHub cards are restored from the catalog response in one request.
    await page.route("**/api/connectors?*", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.requests = [
        { provider: "gmail", request: { id: "many", status: "selecting", account, resources: [] } },
      ];
      return route.fulfill({ response, json });
    });
    await page.route("**/api/connectors/gmail/requests/many/resources?*", (route) => {
      const first = new URL(route.request().url()).searchParams.get("page") === "1";
      const resources = Array.from({ length: first ? 30 : 2 }, (_, i) => ({
        id: String((first ? 1 : 31) + i),
        name: "Label " + ((first ? 1 : 31) + i),
      }));
      return route.fulfill({ json: { resources } });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    const card = page.getByRole("region", { name: "Gmail 只读连接" });
    const checked = card.getByRole("checkbox", { checked: true });
    await card.getByRole("button", { name: "全选已加载项" }).click();
    await expect(checked).toHaveCount(30);
    await card.getByRole("button", { name: "加载更多" }).click();
    const last = card.getByRole("checkbox", { name: "Label 32", exact: true });
    await expect(last).toBeDisabled();
    await card.getByRole("button", { name: "清空选择" }).click();
    await last.check();
    await card.getByRole("button", { name: "选满 30 项" }).click();
    await expect(checked).toHaveCount(30);
    await expect(last).toBeChecked();
    await expect(card.getByText("已选 30 项 · 最多 30 项")).toBeVisible();
    await expect(card.getByRole("button", { name: "只读连接并继续" })).toBeEnabled();
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
  test("combined sources are explicit and never silently complete a partial task", async ({
    page,
  }) => {
    const before = reads;
    await start(page, "查看 Gmail 和 Google Calendar 今天的安排");
    await expect(page.locator("#log")).toContainText("目前每条连接任务支持一个来源");
    await expect(page.getByRole("region", { name: /只读连接/ })).toHaveCount(0);
    expect(reads).toBe(before);
  });
  test("cancelling a Google card closes the pending callback and never reads", async ({ page }) => {
    const before = reads;
    await start(page, "查看 Google Calendar 空闲时间");
    const card = page.getByRole("region", { name: "Google Calendar 只读连接" });
    await card.getByRole("button", { name: "连接主日历，只看忙闲", exact: true }).click();
    const link = card.getByRole("link", { name: "打开 Google 授权页面" });
    await expect(link).toBeVisible();
    const login = new URL((await link.getAttribute("href"))!);
    expect(login.searchParams.get("scope")).not.toContain(GOOGLE_SCOPES.events[0]);
    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole("button", { name: "取消此任务" }).click();
    await expect(card.getByText("任务已取消", { exact: true })).toBeVisible();
    await expect(link).toHaveCount(0);
    expect(reads).toBe(before);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
