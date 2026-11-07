import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { LinearReadonlyDriver, LINEAR_READ_TOOLS } from "../../src/connectors/linear-driver.js";
import { LINEAR_ORIGIN, LINEAR_ENDPOINT } from "../../src/connectors/linear-oauth.js";
import type { McpFetch } from "../../src/mcp/http.js";
import type { Provider } from "../../src/providers/types.js";

test.describe("Linear read-only connection", () => {
  test.use({ locale: "zh-CN" });
  let home: string,
    base: string,
    server: http.Server,
    reads = 0;
  const account = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Fixture user",
    email: "fixture@example.com",
  };
  const team = { id: "00000000-0000-4000-8000-000000000002", name: "Fixture team" };
  test.beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-linear-browser-"));
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
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    const fetcher: McpFetch = async (url, init) => {
      const endpoint = new URL(url);
      expect(endpoint.origin).toBe(LINEAR_ORIGIN);
      if (endpoint.pathname.includes("oauth-protected-resource"))
        return json({
          resource: LINEAR_ENDPOINT,
          authorization_servers: [LINEAR_ORIGIN],
          scopes_supported: ["read"],
        });
      if (endpoint.pathname.includes("oauth-authorization-server"))
        return json({
          issuer: LINEAR_ORIGIN,
          authorization_endpoint: LINEAR_ORIGIN + "/authorize",
          token_endpoint: LINEAR_ORIGIN + "/token",
          registration_endpoint: LINEAR_ORIGIN + "/register",
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        });
      if (endpoint.pathname === "/register") {
        const body = JSON.parse(String(init?.body));
        expect(body.scope).toBe("read");
        expect(body.token_endpoint_auth_method).toBe("none");
        return json({ ...body, client_id: "fixture-client" });
      }
      if (endpoint.pathname === "/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("resource")).toBe(LINEAR_ENDPOINT);
        expect(body.get("code_verifier")!.length).toBeGreaterThan(40);
        return json({
          access_token: "linear-browser-access",
          refresh_token: "linear-browser-refresh",
          expires_in: 3600,
          scope: "read",
          token_type: "bearer",
        });
      }
      expect(endpoint.href).toBe(LINEAR_ENDPOINT);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer linear-browser-access");
      const message = JSON.parse(String(init?.body));
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      let result: unknown;
      if (message.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "linear-fixture", version: "1" },
        };
      else if (message.method === "tools/list")
        result = {
          tools: LINEAR_READ_TOOLS.map((name) => ({
            name,
            inputSchema: {
              type: "object",
              properties: Object.fromEntries(
                ["query", "team", "limit", "cursor", "orderBy", "includeArchived", "assignee"].map(
                  (key) => [key, {}],
                ),
              ),
            },
            annotations: { readOnlyHint: true },
          })),
        };
      else {
        expect(message.method).toBe("tools/call");
        let data: unknown;
        if (message.params.name === "get_user") data = account;
        else if (message.params.name === "list_teams") data = { teams: [team] };
        else if (message.params.name === "get_team") {
          expect(message.params.arguments.query).toBe(team.id);
          data = team;
        } else {
          expect(message.params.name).toBe("list_issues");
          expect(message.params.arguments.team).toBe(team.id);
          reads++;
          data = {
            issues: [
              {
                id: "00000000-0000-4000-8000-000000000003",
                teamId: team.id,
                identifier: "TEST-1",
                title: "LINEAR-FLOW-VERIFIED",
              },
            ],
          };
        }
        result = { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      // Exercise the SDK's SSE result path, not a mocked driver or lifecycle.
      return new Response(
        "event: message\ndata: " +
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) +
          "\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    const provider: Provider = {
      name: "fixture",
      runTurn: async (opts) => {
        expect(opts.tools.map((t) => t.name)).toEqual(["linear_read"]);
        const done = JSON.stringify(opts.messages).includes("LINEAR-FLOW-VERIFIED");
        return {
          content: done
            ? [{ type: "text", text: "Linear 只读任务已自动完成。", citations: null }]
            : [
                {
                  type: "tool_use",
                  id: "linear-read",
                  caller: { type: "direct" },
                  name: "linear_read",
                  input: { operation: "issues", resourceId: team.id },
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
      linearDriver: new LinearReadonlyDriver({ fetch: () => fetcher }),
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function start(page: Page, prompt = "查看 Linear 团队的近期工单") {
    await page.goto(base);
    await page.locator("#sbNewSession").click();
    await page.locator("#input").fill(prompt);
    await page.locator("#sendBtn").click();
  }
  test("DCR/PKCE → team selection → automatic same-chat result → reload and connection reuse", async ({
    page,
  }) => {
    await start(page);
    const card = page.getByRole("region", { name: "Linear 只读连接" });
    await card.getByRole("button", { name: "登录 Linear，只读连接", exact: true }).click();
    const link = card.getByRole("link", { name: "打开 Linear 授权页面" });
    await expect(link).toBeVisible();
    const login = new URL((await link.getAttribute("href"))!);
    expect(login.searchParams.get("scope")).toBe("read");
    expect(login.searchParams.get("resource")).toBe(LINEAR_ENDPOINT);
    await page.reload();
    await expect(link).toBeVisible();
    const callback = new URL(login.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", login.searchParams.get("state")!);
    callback.searchParams.set("iss", LINEAR_ORIGIN);
    callback.searchParams.set("code", "fixture-code");
    expect((await fetch(callback)).ok).toBe(true);
    const confirm = card.getByRole("button", { name: "只读连接并继续" });
    await expect(confirm).toBeDisabled();
    await expect(card).toContainText(account.email);
    expect(reads).toBe(0);
    await card.getByRole("checkbox", { name: team.name, exact: true }).check();
    await fs.mkdir(".tmp", { recursive: true });
    await card.screenshot({ path: ".tmp/linear-connection-card.png" });
    await confirm.click();
    await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
    const result = page.locator("#log .msg").filter({ hasText: "Linear 只读任务已自动完成。" });
    await expect(result).toHaveCount(1);
    await page.reload();
    await expect(result).toHaveCount(1);
    expect(reads).toBe(1);
    await start(page, "总结 Linear 团队工单");
    await expect(card.getByText("原任务已完成", { exact: true })).toBeVisible();
    expect(reads).toBe(2);
    await card.getByRole("button", { name: "断开 LISA 连接" }).click();
    await expect(card.getByRole("button", { name: "断开 LISA 连接" })).toHaveCount(0);
  });
  test("cancel closes the pending authorization and performs no issue reads on narrow screens", async ({
    page,
  }) => {
    const before = reads;
    await start(page);
    const card = page.getByRole("region", { name: "Linear 只读连接" });
    await card.getByRole("button", { name: "登录 Linear，只读连接", exact: true }).click();
    await expect(card.getByRole("link", { name: "打开 Linear 授权页面" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole("button", { name: "取消此任务" }).click();
    await expect(card.getByText("任务已取消", { exact: true })).toBeVisible();
    expect(reads).toBe(before);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
  test("mixed Linear/GitHub requests ask for separate tasks without partial execution", async ({
    page,
  }) => {
    const before = reads;
    await start(page, "查看 Linear 和 GitHub 最近进展");
    await expect(page.locator("#log")).toContainText("目前每条连接任务支持一个来源");
    await expect(page.getByRole("region", { name: /只读连接/ })).toHaveCount(0);
    expect(reads).toBe(before);
  });
});
