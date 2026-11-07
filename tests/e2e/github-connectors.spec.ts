import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import type { GitHubDriver } from "../../src/connectors/github-driver.js";
import type { Provider } from "../../src/providers/types.js";

test.describe("GitHub connection card", () => {
  test.use({ locale: "zh-CN" });
  let home: string, base: string, server: http.Server;
  let allowLogin: (() => void) | undefined;
  let reads = 0;
  test.beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-gh-browser-"));
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
    const account = { id: 12, login: "octocat" };
    const repo = { id: 42, fullName: "octocat/project", private: true };
    const driver: GitHubDriver = {
      authorize: async (mode, signal, code) => {
        if (mode === "login") {
          code("ABCD-1234");
          await new Promise<void>((resolve) => {
            allowLogin = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return { token: "browser-fixture-secret", account };
      },
      account: async () => account,
      repositories: async () => [repo],
      repository: async () => repo,
      read: async () => {
        reads++;
        return { commits: ["Connector recovery completed"] };
      },
    };
    const provider: Provider = {
      name: "fixture",
      runTurn: async (opts) => {
        const result = JSON.stringify(opts.messages).includes("Connector recovery completed");
        return {
          content: result
            ? [{ type: "text", text: "GitHub 工作总结：连接恢复功能已经完成。", citations: null }]
            : [
                {
                  type: "tool_use",
                  id: "read-1",
                  name: "github_read",
                  caller: { type: "direct" },
                  input: { operation: "commits", repository: repo.fullName },
                },
              ],
          stopReason: result ? "end_turn" : "tool_use",
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
      githubDriver: driver,
      githubSecrets: new MemorySecretStore(),
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.afterAll(async () => {
    allowLogin?.();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("existing login → private repo selection → automatic original task result; survives reload", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await expect(page.locator("#birthOverlay")).not.toHaveClass(/\bopen\b/);
    await page.locator("#input").fill("总结 GitHub 最近工作");
    await page.locator("#sendBtn").click();
    const card = page.getByRole("region", { name: "GitHub 只读连接" });
    // section aria-label maps to region; all actions stay in the originating chat.
    await expect(card).toBeVisible();
    await page.reload();
    await card.getByRole("button", { name: "使用本机 GitHub 登录", exact: true }).click();
    await expect(card.getByText("@octocat", { exact: true })).toBeVisible();
    const confirm = card.getByRole("button", { name: "只读连接并继续" });
    await expect(confirm).toBeDisabled();
    await card.getByRole("checkbox", { name: "octocat/project · 私有" }).check();
    await fs.mkdir(".tmp", { recursive: true });
    await card.screenshot({ path: ".tmp/github-connection-card.png" });
    await confirm.click();
    await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
    await expect(
      page.locator("#log .msg").filter({ hasText: "GitHub 工作总结：连接恢复功能已经完成。" }),
    ).toHaveCount(1);
    await page.reload();
    await expect(
      page.locator("#log .msg").filter({ hasText: "GitHub 工作总结：连接恢复功能已经完成。" }),
    ).toHaveCount(1);
    expect(reads).toBe(1);
    await card.getByRole("button", { name: "断开 LISA 连接" }).click();
    await expect(card.getByRole("button", { name: "断开 LISA 连接" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("device code survives refresh; cancellation suppresses a late authorization", async ({
    page,
  }) => {
    await page.goto(base);
    await page.locator("#sbNewSession").click();
    await page.locator("#input").fill("只读查看 GitHub 最近提交");
    await page.locator("#sendBtn").click();
    const card = page.getByRole("region", { name: "GitHub 只读连接" });
    await card.getByRole("button", { name: "登录 GitHub", exact: true }).click();
    await expect(card.locator("code")).toHaveText("ABCD-1234");
    await expect(card.getByRole("link")).toHaveAttribute("href", "https://github.com/login/device");
    await page.reload();
    await expect(card.locator("code")).toHaveText("ABCD-1234");
    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole("button", { name: "取消此任务" }).click();
    allowLogin?.();
    await expect(card.getByText("任务已取消", { exact: true })).toBeVisible();
    await expect(card.locator("code")).toHaveCount(0);
    expect(reads).toBe(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
