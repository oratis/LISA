import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceDriver, availableWorkspaceIds, readPeriod } from "./driver.js";
import { workspaceApps, workspaceIds, workspaceReadIntents, type WorkspaceId } from "./catalog.js";
import { Reader, type Http } from "./http.js";
import { eventKitAvailable } from "./eventkit.js";
import { contents, validId } from "./data.js";
import {
  appClient,
  refreshCloud,
  validLogin,
  redirectUri,
  endpoints,
  type Grant,
} from "./oauth.js";
import type { CredentialAccess } from "../types.js";
const signal = () => AbortSignal.timeout(5000);
const unavailable: Http = async () => {
  throw Error("unexpected network");
};
function credentials(initial: Grant) {
  let raw = JSON.stringify(initial);
  const updates: string[] = [];
  const access: CredentialAccess = {
    use: async (work) =>
      work(raw, async (next) => {
        updates.push(next);
        raw = next;
      }),
  };
  return { access, updates };
}
const account = { id: "subject", name: "Fixture" };
const client = { clientId: "client", clientSecret: "private-secret", tenant: "consumers" };
const original: Grant = {
  provider: "todoist",
  client,
  access: "access-old",
  refresh: "refresh-old",
  subject: account.id,
  expires: Date.now() + 3600000,
};
test("all workspace sources match an explicit read and refuse write intent and resource escapes", async () => {
  for (const id of workspaceIds) {
    const name = workspaceApps[id].name;
    assert.deepEqual(workspaceReadIntents("只读查看 " + name), [id]);
    assert.deepEqual(workspaceReadIntents("删除 " + name + " 里的记录"), []);
    const driver = new WorkspaceDriver(id, unavailable, async () => {
      throw Error("unexpected native access");
    });
    const c = credentials(original).access;
    await assert.rejects(
      driver.read(c, account, [], { operation: "read", resourceId: "other" }, signal()),
      /resource_not_granted/,
    );
    await assert.rejects(
      driver.read(c, account, [], { operation: "write" }, signal()),
      /read_operation_required/,
    );
    await assert.rejects(
      driver.read(c, account, [], { operation: "list", url: "https://unexpected" }, signal()),
      /read_operation_required/,
    );
  }
  assert.equal(validId("confluence", "foo|../not-a-page"), false);
  assert.equal(validId("sharepoint", "foo.attacker.com|id"), false);
  assert.throws(() => readPeriod("2026-01-01", "2026-04-01"), /invalid_period/);
});
test("Todoist rotation is persisted before data access; account and project changes discard results", async () => {
  const c = credentials({ ...original, expires: 0 });
  let subject = account.id,
    project = "P1",
    readCount = 0;
  const http: Http = async (u, init) => {
    if (u.pathname === "/oauth/access_token")
      return {
        access_token: "access-new",
        refresh_token: "refresh-new",
        scope: "data:read",
        expires_in: 3600,
      };
    assert.equal(c.updates.length, 1);
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer access-new");
    if (u.pathname === "/api/v1/user") return { id: subject, full_name: "Fixture" };
    if (u.pathname === "/api/v1/projects/P1") return { id: "P1", name: "Project" };
    if (u.pathname === "/api/v1/tasks") {
      readCount++;
      return {
        results: [{ id: "task", content: "access-new untrusted task", project_id: project }],
      };
    }
    throw Error("Unexpected endpoint");
  };
  const driver = new WorkspaceDriver("todoist", http);
  const read = () =>
    driver.read(
      c.access,
      account,
      [{ id: "P1", name: "Project" }],
      { operation: "read", resourceId: "P1" },
      signal(),
    );
  assert.doesNotMatch(JSON.stringify(await read()), /access-new/);
  assert.equal(JSON.parse(c.updates[0]!).refresh, "refresh-new");
  project = "other";
  await assert.rejects(read(), /resource_changed/);
  subject = "different";
  await assert.rejects(read(), /account_changed/);
  assert.equal(readCount, 2);
  await assert.rejects(
    refreshCloud(original, async () => ({ scope: "data:read data:read_write" }), signal()),
    /scope_mismatch/,
  );
});
test("downloads reject foreign origins and redirects are never tools; folder and version changes fail closed", async () => {
  const graph = new Reader("microsoft", "secret", signal(), unavailable);
  for (const url of [
    "http://foo.sharepoint.com/x",
    "https://evil.example/x",
    "https://a.1drv.com@127.0.0.1/x",
    "https://example.sharepoint.com:8443/x",
  ])
    await assert.rejects(graph.graphText(url), /invalid_endpoint/);
  const p = readPeriod(undefined, undefined);
  await assert.rejects(
    contents(
      "outlook-mail",
      new Reader("microsoft", "secret", signal(), async () => ({
        value: [{ parentFolderId: "other", subject: "private" }],
      })),
      "folder1",
      p,
    ),
    /resource_changed/,
  );
  let reads = 0;
  const drop = new Reader("dropbox", "secret", signal(), async (u) => {
    if (u.hostname === "content.dropboxapi.com") return "private";
    return { id: "id:abc", ".tag": "file", name: "file.txt", rev: String(++reads), size: 7 };
  });
  await assert.rejects(contents("dropbox", drop, "id:abc", p), /resource_changed/);
  const large = new Reader("dropbox", "secret", signal(), async () => ({
    id: "id:abc",
    ".tag": "file",
    name: "file.pdf",
    size: 7,
  }));
  await assert.rejects(contents("dropbox", large, "id:abc", p), /content_unavailable/);
});
test("authorization link validation checks exact callback, tenant, scopes, PKCE and duplicate parameters", () => {
  const id = "outlook-mail";
  const e = endpoints(id, client),
    u = new URL(e.auth);
  u.search = new URLSearchParams({
    client_id: "client",
    redirect_uri: redirectUri(id),
    scope: e.scopes,
    response_type: "code",
    state: "s".repeat(43),
    code_challenge_method: "S256",
    code_challenge: "p".repeat(43),
  }).toString();
  assert.ok(validLogin(id, u.href));
  assert.equal(validLogin("outlook-calendar", u.href), false);
  u.searchParams.append("scope", "Mail.ReadWrite");
  assert.equal(validLogin(id, u.href), false);
  assert.throws(() => endpoints("sharepoint", client), /not_configured/);
});
test("Todoist caches only a public DCR client and checks the exact returned grant", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-todoist-dcr-"));
  const old = process.env.LISA_HOME,
    oldFile = process.env.LISA_WORKSPACE_CLIENTS_FILE;
  process.env.LISA_HOME = dir;
  delete process.env.LISA_WORKSPACE_CLIENTS_FILE;
  t.after(async () => {
    if (old) process.env.LISA_HOME = old;
    else delete process.env.LISA_HOME;
    if (oldFile) process.env.LISA_WORKSPACE_CLIENTS_FILE = oldFile;
    await fs.rm(dir, { recursive: true, force: true });
  });
  let n = 0;
  const http: Http = async (u, init) => {
    assert.equal(u.href, "https://api.todoist.com/oauth/register");
    n++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.scope, "data:read");
    assert.equal(body.token_endpoint_auth_method, "none");
    return { ...body, client_id: "tdd_localfixture" };
  };
  const clients = await Promise.all([
    appClient("todoist", http, signal()),
    appClient("todoist", http, signal()),
  ]);
  assert.deepEqual(clients, [{ clientId: "tdd_localfixture" }, { clientId: "tdd_localfixture" }]);
  assert.equal(n, 1);
});

test("Figma node selection cannot import other nodes from a multi-node response", async () => {
  const p = readPeriod(undefined, undefined);
  const graph = new Reader("figma", "secret", signal(), async (url) => {
    assert.equal(url.pathname, "/v1/files/fileKey/nodes");
    assert.equal(url.searchParams.get("ids"), "12:34");
    return {
      nodes: {
        "12:34": {
          document: {
            id: "12:34",
            type: "TEXT",
            name: "Selected",
            characters: "Only selected text",
          },
        },
        "9:9": { document: { id: "9:9", name: "Hidden secret" } },
      },
    };
  });
  const selected = JSON.stringify(await contents("figma", graph, "fileKey|12:34", p));
  assert.match(selected, /Only selected text/);
  assert.doesNotMatch(selected, /Hidden secret/);
  const wrong = new Reader("figma", "secret", signal(), async () => ({
    nodes: { "12:34": { document: { id: "9:9", name: "moved" } } },
  }));
  await assert.rejects(contents("figma", wrong, "fileKey|12:34", p), /resource_changed/);
});

test("ordinary chat that only names a source is not a read request", () => {
  for (const text of [
    "What is Figma?",
    "I already use Dropbox",
    "what's the difference between Jira and Confluence",
    "Show me what Figma can do",
    "Can you find a Dropbox alternative?",
    "Review the musical I saw last night",
    "Figma 是什么？",
  ])
    assert.deepEqual(workspaceReadIntents(text), [], text);
});
test("each source matches a plain English (or Chinese) read request", () => {
  const asks: Record<WorkspaceId, string> = {
    todoist: "List my Todoist tasks for today",
    "outlook-mail": "Summarize my Outlook inbox",
    "outlook-calendar": "Read my Outlook calendar for next week",
    onedrive: "Review the notes in my OneDrive",
    sharepoint: "Read the SharePoint project plan",
    jira: "List my open Jira issues",
    confluence: "Summarize the Confluence onboarding page",
    figma: "Inspect the Figma design for the login screen",
    dropbox: "Read the contract in Dropbox",
    "apple-calendar": "查看我的苹果日历",
    "apple-reminders": "List my Apple Reminders",
  };
  for (const id of workspaceIds) assert.deepEqual(workspaceReadIntents(asks[id]), [id], asks[id]);
});
test("only sources with a configured client or a runnable EventKit reader are offered", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-workspace-clients-"));
  const old = process.env.LISA_WORKSPACE_CLIENTS_FILE;
  t.after(async () => {
    if (old) process.env.LISA_WORKSPACE_CLIENTS_FILE = old;
    else delete process.env.LISA_WORKSPACE_CLIENTS_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });
  delete process.env.LISA_WORKSPACE_CLIENTS_FILE;
  assert.deepEqual(await availableWorkspaceIds(async () => false), ["todoist"]);
  const file = path.join(dir, "clients.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      microsoft: { clientId: "client", tenant: "12345678-1234-1234-1234-123456789012" },
      // Incomplete: Figma needs a client secret.
      figma: { clientId: "client" },
    }),
    { mode: 0o600 },
  );
  process.env.LISA_WORKSPACE_CLIENTS_FILE = file;
  assert.deepEqual(await availableWorkspaceIds(async () => false), [
    "todoist",
    "outlook-mail",
    "outlook-calendar",
    "onedrive",
    "sharepoint",
  ]);
  assert.deepEqual((await availableWorkspaceIds(async () => true)).slice(-2), [
    "apple-calendar",
    "apple-reminders",
  ]);
  // A build without the reader source (Lisa.app's embedded runtime) cannot offer Apple sources.
  assert.equal(
    await eventKitAvailable({ source: path.join(dir, "missing.swift"), plist: file }),
    false,
  );
});
