import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { WorkspaceDriver } from "../../src/connectors/workspace/driver.js";
import {
  workspaceIds,
  workspaceApps,
  toolName,
  type WorkspaceId,
  type CloudId,
} from "../../src/connectors/workspace/catalog.js";
import { endpoints } from "../../src/connectors/workspace/oauth.js";
import type { Http } from "../../src/connectors/workspace/http.js";
import type { Provider } from "../../src/providers/types.js";

const tenant = "12345678-1234-1234-1234-123456789012";
const client = { clientId: "test-app", clientSecret: "fixture-secret", tenant };
function key(id: WorkspaceId) {
  if (id === "dropbox") return "id:File01";
  if (id === "jira" || id === "confluence") return tenant + "|123";
  if (id === "sharepoint") return "example.sharepoint.com," + tenant + "," + tenant + "|File01";
  return "File01";
}
const marker = "VERIFIED-FROM-SELECTED-RESOURCE";
function providerHttp(id: CloudId, onRead: () => void): Http {
  const e = endpoints(id, client),
    item = key(id),
    label = "Selected resource";
  return async (u, init) => {
    if (u.href === e.token) {
      expect(init.method).toBe("POST");
      expect(String(init.body)).toContain("code");
      if (e.pkce) expect(String(init.body)).toContain("code_verifier");
      return {
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
        scope: e.scopes,
        token_type: "Bearer",
      };
    }
    const p = decodeURIComponent(u.pathname);
    if (u.hostname.endsWith(".1drv.com")) {
      expect(init.headers).toBeUndefined();
      onRead();
      return marker;
    }
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fixture-access");
    if (p === "/api/v1/user") return { id: "user", full_name: "Fixture" };
    if (p === "/v1/me") return { id: "user", handle: "Fixture" };
    if (p === "/v1.0/me") return { id: "user", displayName: "Fixture" };
    if (p === "/oauth/token/accessible-resources")
      return [{ id: tenant, name: "Fixture site", scopes: [workspaceApps[id].scope] }];
    if (p.endsWith("/project/search")) return { values: [{ id: "123", name: label }] };
    if (p.endsWith("/wiki/api/v2/pages")) return { results: [{ id: "123", title: label }] };
    if (p === "/me") return { account_id: "user", name: "Fixture" };
    if (p === "/2/users/get_current_account")
      return { account_id: "user", name: { display_name: "Fixture" } };
    if (p === "/api/v1/projects") return { results: [{ id: item, name: label }] };
    if (p === "/api/v1/projects/" + item) return { id: item, name: label };
    if (p === "/api/v1/tasks") {
      expect(u.searchParams.get("project_id")).toBe(item);
      onRead();
      return { results: [{ id: "task", content: marker, project_id: item }] };
    }
    if (p === "/v1.0/me/mailFolders") return { value: [{ id: item, displayName: label }] };
    if (p.endsWith("/mailFolders/" + item)) return { id: item, displayName: label };
    if (p.endsWith("/messages")) {
      onRead();
      return { value: [{ id: "msg", subject: marker, parentFolderId: item }] };
    }
    if (p === "/v1.0/me/calendars") return { value: [{ id: item, name: label }] };
    if (p.endsWith("/calendars/" + item)) return { id: item, name: label };
    if (p.endsWith("/calendarView")) {
      onRead();
      return {
        value: [
          {
            id: "event",
            subject: marker,
            start: { dateTime: "today" },
            end: { dateTime: "today" },
          },
        ],
      };
    }
    if (p.endsWith("/drive/root/children"))
      return { value: [{ id: item, name: "fixture.txt", file: {} }] };
    if (p.endsWith("/drive/items/File01"))
      return {
        id: "File01",
        name: "fixture.txt",
        file: {},
        size: 10,
        eTag: "version",
        "@microsoft.graph.downloadUrl": "https://fixture.1drv.com/data",
      };
    if (p.endsWith("/project/123")) return { id: "123", name: label };
    if (p.endsWith("/search/jql")) {
      onRead();
      return {
        issues: [
          {
            key: "TEST-1",
            fields: { project: { id: "123" }, status: { name: "Open" }, summary: marker },
          },
        ],
      };
    }
    if (p.endsWith("/pages/123")) {
      if (u.searchParams.has("body-format")) onRead();
      return { id: "123", title: label, body: { storage: { value: marker } } };
    }
    if (p.startsWith("/v1/files/")) {
      const content = u.searchParams.get("depth") === "3";
      if (content) onRead();
      return {
        name: label,
        document: { children: content ? [{ id: "n", type: "TEXT", name: marker }] : [] },
      };
    }
    if (p === "/2/files/list_folder")
      return { entries: [{ id: item, ".tag": "file", name: "fixture.txt" }] };
    if (p === "/2/files/get_metadata")
      return { id: item, ".tag": "file", name: "fixture.txt", rev: "rev", size: 10 };
    if (p === "/2/files/download") {
      onRead();
      return marker;
    }
    throw Error("Unexpected fixture endpoint " + p);
  };
}
test.describe("Scoped workspace connectors", () => {
  test.use({ locale: "zh-CN" });
  let home: string, base: string, server: http.Server;
  const reads = new Map<WorkspaceId, number>();
  test.beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-workspace-cards-"));
    Object.assign(process.env, {
      LISA_HOME: home,
      CLAUDE_HOME: path.join(home, "claude"),
      LISA_WORKSPACE_CLIENTS_FILE: path.join(home, "clients.json"),
      LISA_SOUL_GIT: "0",
      LISA_MAIL_POLL_MINUTES: "0",
      ANTHROPIC_API_KEY: "fixture",
    });
    for (const k of [
      "LISA_EDITION",
      "K_SERVICE",
      "LISA_WEB_TOKEN",
      "LISA_BASE_URL",
      "LISA_PROVIDER",
      "LISA_MODEL_FALLBACK",
    ])
      delete process.env[k];
    await fs.writeFile(
      process.env.LISA_WORKSPACE_CLIENTS_FILE!,
      JSON.stringify(
        Object.fromEntries(Object.values(workspaceApps).map((app) => [app.vendor, client])),
      ),
      { mode: 0o600 },
    );
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "tests/e2e/helpers/make-soul.ts"],
      { env: process.env },
    );
    const drivers = Object.fromEntries(
      workspaceIds.map((id) => {
        const count = () => reads.set(id, (reads.get(id) ?? 0) + 1);
        if (workspaceApps[id].vendor === "apple")
          return [
            id,
            new WorkspaceDriver(id, undefined, async (_kind, action) => {
              const item = { id: key(id), name: "Fixture list" };
              if (action === "resources") return [item];
              if (action === "resource") return item;
              if (action === "read") {
                count();
                return { items: [{ title: marker }], truncated: false };
              }
              return { granted: true, accountId: "a".repeat(64) };
            }),
          ];
        return [id, new WorkspaceDriver(id, providerHttp(id as CloudId, count))];
      }),
    );
    const provider: Provider = {
      name: "fixture",
      runTurn: async (opts) => {
        expect(opts.tools.length).toBe(1);
        const id = workspaceIds.find((id) => toolName(id) === opts.tools[0]!.name)!;
        const done = JSON.stringify(opts.messages).includes(marker);
        return {
          content: done
            ? [{ type: "text", text: "Verified result for " + id, citations: null }]
            : [
                {
                  type: "tool_use",
                  id: "read",
                  name: toolName(id),
                  caller: { type: "direct" },
                  input: { operation: "read", resourceId: key(id) },
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
      workspaceDrivers: drivers,
      connectorSecrets: new MemorySecretStore(),
    });
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });
  test.afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  for (const id of workspaceIds)
    test(id + " → grant → select → resume once", async ({ page }) => {
      const name = workspaceApps[id].name,
        native = workspaceApps[id].vendor === "apple";
      await page.goto(base);
      await page.locator("#sbNewSession").click();
      await page.locator("#input").fill("只读查看 " + name + " 并总结所选资源");
      await page.locator("#sendBtn").click();
      const card = page.getByRole("region", { name: name + " 只读连接" });
      await card
        .getByRole("button", {
          name: native ? "在这台 Mac 上授权 " + name : "登录 " + name,
          exact: true,
        })
        .click();
      if (!native) {
        const link = card.getByRole("link", { name: "打开 " + name + " 授权页" });
        await expect(link).toBeVisible();
        const auth = new URL((await link.getAttribute("href"))!);
        expect(auth.searchParams.get("scope")).toBe(endpoints(id as CloudId, client).scopes);
        const callback = new URL(auth.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", "x".repeat(43));
        expect((await fetch(callback)).status).toBe(400);
        callback.searchParams.set("state", auth.searchParams.get("state")!);
        expect((await fetch(callback)).status).toBe(200);
      }
      const confirm = card.getByRole("button", { name: "只读连接并继续" });
      await expect(confirm).toBeDisabled();
      expect(reads.get(id) ?? 0).toBe(0);
      if (native) await card.getByRole("checkbox").first().check();
      else {
        await card.getByRole("textbox", { name: name + " 资源 ID" }).fill(key(id));
        await card.getByRole("button", { name: "添加", exact: false }).click();
      }
      await confirm.click();
      const output = page.getByText("Verified result for " + id, { exact: true });
      await expect(output).toHaveCount(1);
      await page.reload();
      await expect(output).toHaveCount(1);
      expect(reads.get(id)).toBe(1);
    });
});
