import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DriveReadonlyDriver,
  driveContentEndpointAllowed,
  isDriveReadRequest,
  parseDriveCredential,
} from "./drive-driver.js";
import { NotionReadonlyDriver, isNotionReadRequest } from "./notion-driver.js";
import { notionEndpointAllowed, notionHttp } from "./notion-http.js";
import { assertNotionReadScope, refreshNotion, type NotionCredential } from "./notion-oauth.js";
import { GOOGLE_SCOPES, authorizeGoogle } from "./google-oauth.js";
import { ConnectorError, type CredentialAccess } from "./types.js";
import type { GoogleHttp } from "./google-http.js";
import type { NotionHttp } from "./notion-http.js";
const signal = () => AbortSignal.timeout(5000);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fileId = "selected-file-1";
const driveAccount = { id: "account-1", name: "Fixture", email: "fixture@example.com" };
const driveResource = {
  id: fileId,
  name: "Selected file",
  access: "file" as const,
  mimeType: "application/vnd.google-apps.document",
};
const googleCredential = {
  clientId: "fixture.apps.googleusercontent.com",
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiry: Date.now() + 3600000,
  scopes: [...GOOGLE_SCOPES.driveFile],
  allowedScopes: [...GOOGLE_SCOPES.driveFile],
  pickedFileIds: [fileId],
};
const notionCredential: NotionCredential = {
  clientId: id(1),
  clientSecret: "client-secret",
  redirectUri: "http://localhost:4860/oauth/notion",
  accessToken: "notion-access-secret",
  refreshToken: "notion-refresh-secret",
  workspaceId: id(2),
  workspaceName: "Fixture workspace",
  botId: id(3),
  identityId: id(3),
};
const notionAccount = {
  id: id(3),
  name: "Fixture",
  workspaceId: id(2),
  workspaceName: "Fixture workspace",
};
const notionResource = { id: id(4), name: "Selected page", access: "page" as const };
function access(c: object) {
  let raw = JSON.stringify(c),
    replaced = 0;
  return {
    use: async <T>(fn: Parameters<CredentialAccess["use"]>[0]) =>
      fn(raw, async (value) => {
        raw = value;
        replaced++;
      }) as Promise<T>,
    get replaced() {
      return replaced;
    },
    get raw() {
      return raw;
    },
  };
}
function driveFixture(
  options: { mime?: string; revoked?: () => boolean; size?: string; canDownload?: boolean } = {},
) {
  let calls = 0;
  const http: GoogleHttp = async (url) => {
    calls++;
    if (url.includes("/about?"))
      return {
        user: {
          permissionId: driveAccount.id,
          displayName: driveAccount.name,
          emailAddress: driveAccount.email,
        },
      };
    if (options.revoked?.()) throw new ConnectorError("google_access_denied");
    return {
      id: fileId,
      name: "Selected file",
      mimeType: options.mime ?? driveResource.mimeType,
      size: options.size,
      capabilities: { canDownload: options.canDownload ?? true },
    };
  };
  return {
    http,
    get calls() {
      return calls;
    },
  };
}
const page = () => ({
  object: "page",
  id: id(4),
  parent: { type: "workspace", workspace: true },
  properties: { title: { type: "title", title: [{ plain_text: "Selected page" }] } },
});
const block = (n: number, type = "paragraph", parent = id(4), children = false) => ({
  object: "block",
  id: id(n),
  type,
  parent: {
    type: parent === id(4) ? "page_id" : "block_id",
    [parent === id(4) ? "page_id" : "block_id"]: parent,
  },
  has_children: children,
  [type]: { rich_text: [{ plain_text: "untrusted source text" }] },
});
function notionFixture(
  extra?: (path: string, init: Parameters<NotionHttp>[2]) => Record<string, unknown> | undefined,
) {
  const calls: string[] = [];
  const http: NotionHttp = async (path, _s, init) => {
    calls.push(path);
    const custom = extra?.(path, init);
    if (custom) return custom;
    if (path === "/v1/oauth/introspect") return { active: true, scope: "read_content" };
    if (path === "/v1/users/me") return { object: "user", id: id(3), name: "Fixture", type: "bot" };
    if (path === "/v1/search")
      return { object: "list", results: [page()], has_more: false, next_cursor: null };
    if (path === "/v1/pages/" + id(4)) return page();
    if (path.includes("/children?"))
      return { object: "list", results: [block(5)], has_more: false, next_cursor: null };
    throw Error("Unexpected fixed route: " + path);
  };
  return { http, calls };
}

test("Drive reads only picker IDs and confirmed resources; no writes or arbitrary URLs reach HTTP", async () => {
  const f = driveFixture(),
    d = new DriveReadonlyDriver({
      http: f.http,
      content: () => async () => new Response("hello access-secret"),
    });
  const c = access(googleCredential);
  assert.deepEqual(await d.resources(c, 1, signal()), [driveResource]);
  const before = f.calls;
  await assert.rejects(d.resource(c, "other-file-12", signal()), /resource_not_granted/);
  for (const input of [
    { operation: "delete", resourceId: fileId },
    { operation: "content", resourceId: "other-file-12" },
    { operation: "content", resourceId: fileId, url: "https://evil.example" },
  ])
    await assert.rejects(d.read(c, driveAccount, [driveResource], input, signal()));
  assert.equal(f.calls, before);
  const r = (await d.read(
    c,
    driveAccount,
    [driveResource],
    { operation: "content", resourceId: fileId },
    signal(),
  )) as { text: string; untrusted: boolean };
  assert.equal(r.untrusted, true);
  assert.ok(!r.text.includes("access-secret"));
  assert.equal(
    driveContentEndpointAllowed(
      new URL("https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media"),
      "GET",
    ),
    true,
  );
  assert.equal(
    driveContentEndpointAllowed(
      new URL("https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media"),
      "DELETE",
    ),
    false,
  );
  assert.equal(
    driveContentEndpointAllowed(
      new URL("https://evil.example/drive/v3/files/" + fileId + "?alt=media"),
      "GET",
    ),
    false,
  );
});
test("Drive rejects shortcuts, unsupported files, changed MIME, denied downloads and large files", async () => {
  for (const [opts, error] of [
    [{ mime: "application/vnd.google-apps.shortcut" }, "drive_file_type_unsupported"],
    [{ mime: "text/plain" }, "drive_file_type_changed"],
    [{ canDownload: false }, "drive_download_denied"],
    [{ size: "1000001" }, "drive_content_too_large"],
  ] as const) {
    const f = driveFixture(opts),
      d = new DriveReadonlyDriver({
        http: f.http,
        content: () => async () => {
          assert.fail("download forbidden");
        },
      });
    await assert.rejects(
      d.read(
        access(googleCredential),
        driveAccount,
        [driveResource],
        { operation: "content", resourceId: fileId },
        signal(),
      ),
      new RegExp(error),
    );
  }
  assert.throws(
    () => parseDriveCredential(JSON.stringify({ ...googleCredential, pickedFileIds: [] })),
    /drive_selection_required/,
  );
});
test("Drive exports Sheets first sheet, truncates text and rechecks revoked access after download", async () => {
  let revoked = false;
  const mime = "application/vnd.google-apps.spreadsheet";
  const f = driveFixture({ mime, revoked: () => revoked });
  const resource = { ...driveResource, mimeType: mime };
  const d = new DriveReadonlyDriver({
    http: f.http,
    content: () => async (url) => {
      assert.equal(new URL(url).searchParams.get("mimeType"), "text/csv");
      return new Response("x".repeat(31000));
    },
  });
  const r = (await d.read(
    access(googleCredential),
    driveAccount,
    [resource],
    { operation: "content", resourceId: fileId },
    signal(),
  )) as { text: string; truncated: boolean; firstSheetOnly: boolean };
  assert.equal(r.text.length, 30000);
  assert.equal(r.truncated, true);
  assert.equal(r.firstSheetOnly, true);
  const bad = new DriveReadonlyDriver({
    http: f.http,
    content: () => async () => {
      revoked = true;
      return new Response("private");
    },
  });
  await assert.rejects(
    bad.read(
      access(googleCredential),
      driveAccount,
      [resource],
      { operation: "content", resourceId: fileId },
      signal(),
    ),
    /google_access_denied/,
  );
});
test("desktop Picker OAuth uses only drive.file and binds selected IDs to its PKCE callback", async () => {
  let url!: URL, ready!: () => void;
  const signalled = new Promise<void>((r) => (ready = r));
  const task = authorizeGoogle(
    { clientId: googleCredential.clientId },
    GOOGLE_SCOPES.driveFile,
    signal(),
    (p) => {
      url = new URL(p.authorizationUrl);
      ready();
    },
    async () => ({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      scope: GOOGLE_SCOPES.driveFile[0],
    }),
    { drivePicker: true },
  );
  await signalled;
  assert.equal(url.searchParams.get("scope"), GOOGLE_SCOPES.driveFile[0]);
  assert.equal(url.searchParams.get("trigger_onepick"), "true");
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  callback.searchParams.set("code", "fixture");
  callback.searchParams.set("picked_file_ids", fileId);
  assert.equal((await fetch(callback)).status, 200);
  assert.deepEqual((await task).pickedFileIds, [fileId]);
  await assert.rejects(
    authorizeGoogle(
      { clientId: googleCredential.clientId },
      [...GOOGLE_SCOPES.identity, ...GOOGLE_SCOPES.driveFile],
      signal(),
      () => {},
      async () => ({}),
      { drivePicker: true },
    ),
    /google_scope_required/,
  );
});
test("Notion authenticates read-only capabilities and rotates credentials before further use", async () => {
  for (const scope of ["", "read_content update_content", "write", "read_comments"])
    await assert.rejects(
      assertNotionReadScope(notionCredential, async () => ({ active: true, scope }), signal()),
      /notion_read_scope_required/,
    );
  let refreshes = 0;
  const f = notionFixture((path, init) => {
    if (path === "/v1/oauth/introspect")
      return {
        active: (init?.json as { token: string }).token !== "notion-access-secret",
        scope: "read_content",
      };
    if (path === "/v1/oauth/token") {
      refreshes++;
      return {
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "bearer",
        workspace_id: id(2),
        workspace_name: "Fixture workspace",
        bot_id: id(3),
      };
    }
  });
  const c = access(notionCredential),
    d = new NotionReadonlyDriver({ http: f.http });
  await d.account(c, signal());
  assert.equal(refreshes, 1);
  assert.equal(c.replaced, 1);
  assert.ok(c.raw.includes("new-refresh"));
  await assert.rejects(
    refreshNotion(
      notionCredential,
      async () => ({
        access_token: "a",
        refresh_token: "r",
        token_type: "bearer",
        workspace_id: id(9),
        bot_id: id(3),
      }),
      signal(),
    ),
    /connector_account_changed/,
  );
});
test("Notion picker fills pages with eligible resources across short or archived search results", async () => {
  const active = Array.from({ length: 31 }, (_, i) => ({ ...page(), id: id(i + 10) }));
  const f = notionFixture((path, init) => {
    if (path !== "/v1/search") return;
    const cursor = (init?.json as { start_cursor?: string }).start_cursor;
    if (!cursor) {
      return {
        object: "list",
        results: [...active.slice(0, 29), { ...page(), archived: true }],
        has_more: true,
        next_cursor: id(98),
      };
    }
    if (cursor === id(98))
      return { object: "list", results: [], has_more: true, next_cursor: id(99) };
    assert.equal(cursor, id(99));
    return { object: "list", results: active.slice(29), has_more: false };
  });
  const driver = new NotionReadonlyDriver({ http: f.http });
  const credentials = access(notionCredential);
  const first = await driver.resources(credentials, 1, signal());
  const second = await driver.resources(credentials, 2, signal());
  assert.equal(first.length, 30);
  assert.deepEqual(
    [...first, ...second].map((r) => r.id),
    active.map((r) => r.id),
  );
});

test("Notion content ignores child pages/synced blocks/files and enforces confirmed page scope", async () => {
  const f = notionFixture((path) =>
    path.includes("/children?")
      ? {
          object: "list",
          results: [
            block(5),
            block(6, "child_page", id(4), true),
            block(7, "synced_block", id(4), true),
            block(8, "file"),
          ],
          has_more: false,
        }
      : undefined,
  );
  const d = new NotionReadonlyDriver({ http: f.http }),
    c = access(notionCredential);
  assert.deepEqual(await d.resources(c, 1, signal()), [notionResource]);
  const before = f.calls.length;
  await assert.rejects(
    d.read(
      c,
      notionAccount,
      [notionResource],
      { operation: "content", resourceId: id(99) },
      signal(),
    ),
    /resource_not_granted/,
  );
  await assert.rejects(
    d.read(
      c,
      notionAccount,
      [notionResource],
      { operation: "update", resourceId: id(4) },
      signal(),
    ),
    /read_operation_required/,
  );
  assert.equal(f.calls.length, before);
  const r = (await d.read(
    c,
    notionAccount,
    [notionResource],
    { operation: "content", resourceId: id(4) },
    signal(),
  )) as { blocks: unknown[]; omittedTypes: string[]; untrusted: boolean };
  assert.equal(r.blocks.length, 1);
  assert.equal(r.untrusted, true);
  assert.deepEqual(r.omittedTypes, ["child_page", "synced_block", "file"]);
  assert.equal(f.calls.filter((p) => p.includes("/children?")).length, 1);
});
test("Notion rejects a block outside the selected page and a moved nested container", async () => {
  for (const moved of [false, true]) {
    const f = notionFixture((path) => {
      if (path.includes("/blocks/" + id(4) + "/children"))
        return {
          object: "list",
          results: [block(5, "paragraph", moved ? id(4) : id(99), moved)],
          has_more: false,
        };
      if (path.includes("/blocks/" + id(5) + "/children"))
        return { object: "list", results: [block(6, "paragraph", id(5))], has_more: false };
      if (path === "/v1/blocks/" + id(5)) return block(5, "paragraph", id(99));
    });
    await assert.rejects(
      new NotionReadonlyDriver({ http: f.http }).read(
        access(notionCredential),
        notionAccount,
        [notionResource],
        { operation: "content", resourceId: id(4) },
        signal(),
      ),
      /notion_resource_mismatch/,
    );
  }
});
test("Notion never returns content after root access is revoked", async () => {
  let pages = 0;
  const f = notionFixture((path) => {
    if (path === "/v1/pages/" + id(4) && ++pages > 1)
      throw new ConnectorError("notion_page_unavailable");
  });
  await assert.rejects(
    new NotionReadonlyDriver({ http: f.http }).read(
      access(notionCredential),
      notionAccount,
      [notionResource],
      { operation: "content", resourceId: id(4) },
      signal(),
    ),
    /notion_page_unavailable/,
  );
});
test("Notion HTTP has a fixed endpoint/method allowlist and sends versioned Basic or Bearer only", async () => {
  assert.equal(notionEndpointAllowed(new URL("https://api.notion.com/v1/search"), "POST"), true);
  assert.equal(
    notionEndpointAllowed(new URL("https://api.notion.com/v1/pages/" + id(4)), "PATCH"),
    false,
  );
  assert.equal(notionEndpointAllowed(new URL("https://evil.example/v1/search"), "POST"), false);
  let calls = 0;
  const request = notionHttp(() => async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("Notion-Version"), "2026-03-11");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Basic " + Buffer.from(id(1) + ":client-secret").toString("base64"),
    );
    return new Response('{"active":true,"scope":"read_content"}');
  });
  await request("/v1/oauth/introspect", signal(), {
    basic: notionCredential,
    json: { token: "token" },
  });
  await assert.rejects(request("/v1/pages", signal(), { json: {} }), /notion_invalid_endpoint/);
  assert.equal(calls, 1);
});
test("document intent detection accepts explicit read requests and excludes writes", () => {
  assert.equal(isDriveReadRequest("只读查看 Google Drive 文件"), true);
  assert.equal(isNotionReadRequest("总结 Notion 页面"), true);
  assert.equal(isDriveReadRequest("删除 Google Drive 文件"), false);
  assert.equal(isNotionReadRequest("修改 Notion 页面"), false);
});

test("Notion OAuth binds registered localhost callback and state; secret is only in Basic token exchange", async () => {
  const { authorizeNotion } = await import("./notion-oauth.js");
  const { default: http } = await import("node:http");
  const listener = http.createServer();
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const port = (listener.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const client = {
    clientId: id(1),
    clientSecret: "client-secret",
    redirectUri: `http://localhost:${port}/oauth/notion`,
  };
  let login!: URL,
    ready!: () => void,
    exchanges = 0;
  const signalled = new Promise<void>((r) => (ready = r));
  const task = authorizeNotion(
    client,
    async (route, _s, init) => {
      exchanges++;
      assert.equal(route, "/v1/oauth/token");
      assert.deepEqual(init?.basic, client);
      assert.equal((init?.json as { redirect_uri: string }).redirect_uri, client.redirectUri);
      return {
        access_token: "a",
        refresh_token: "r",
        token_type: "bearer",
        workspace_id: id(2),
        workspace_name: "Fixture",
        bot_id: id(3),
      };
    },
    signal(),
    (p) => {
      login = new URL(p.authorizationUrl);
      ready();
    },
  );
  await signalled;
  assert.ok(!login.href.includes(client.clientSecret));
  const callback = new URL(client.redirectUri);
  callback.searchParams.set("state", "x".repeat(43));
  callback.searchParams.set("code", "fixture");
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(exchanges, 0);
  callback.searchParams.set("state", login.searchParams.get("state")!);
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await task).workspaceId, id(2));
  assert.equal(exchanges, 1);
});

test("Notion handles person identity and bounds nested output instead of expanding a whole workspace", async () => {
  let n = 10;
  const f = notionFixture((path) => {
    if (path === "/v1/users/me")
      return { object: "user", id: id(3), type: "person", name: "Fixture" };
    if (path.includes("/children?")) {
      const parent = path.split("/")[3];
      return {
        object: "list",
        results: Array.from({ length: 100 }, () => ({
          ...block(n++, "paragraph", parent),
          paragraph: { rich_text: [{ plain_text: "x".repeat(2000) }] },
        })),
        has_more: true,
        next_cursor: id(99),
      };
    }
  });
  const d = new NotionReadonlyDriver({ http: f.http });
  const r = (await d.read(
    access(notionCredential),
    notionAccount,
    [notionResource],
    { operation: "content", resourceId: id(4) },
    signal(),
  )) as { truncated: boolean; characterCount: number; blocks: unknown[] };
  assert.equal(r.truncated, true);
  assert.equal(r.characterCount, 30000);
  assert.ok(r.blocks.length <= 200);
  assert.equal(f.calls.filter((p) => p.includes("/children?")).length, 1);
});

test("both document drivers retain durable authorization, restart exactly once and disconnect safely", async (t) => {
  const { ReadonlyConnector } = await import("./service.js");
  const { MemorySecretStore } = await import("../warden/secrets.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  async function exercise<A, R>(
    driver: import("./types.js").ReadonlyDriver<A, R>,
    resourceId: string,
  ) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-documents-restart-")),
      secrets = new MemorySecretStore();
    let entered = false,
      commits = 0;
    const options = { home, secrets, driver, changed: () => {} };
    const first = new ReadonlyConnector({
      ...options,
      resume: async (run) => {
        entered = true;
        await new Promise<void>((r) =>
          run.signal.addEventListener("abort", () => r(), { once: true }),
        );
        run.signal.throwIfAborted();
      },
    });
    const second = new ReadonlyConnector({
      ...options,
      resume: async (run) => {
        assert.deepEqual(
          run.tools.map((t) => t.name),
          [driver.tool.name],
        );
        assert.equal(run.request.prompt, "Read selected document");
        await run.commit(async () => {
          commits++;
        });
      },
    });
    t.after(async () => {
      await first.stop();
      await second.stop();
      await fs.rm(home, { recursive: true, force: true });
    });
    const until = async (fn: () => Promise<boolean>) => {
      for (let i = 0; i < 300; i++) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("timeout");
    };
    await first.start();
    const request = await first.create("chat", "Read selected document");
    await first.authorize(request.id, "login");
    await until(async () => (await first.list("chat"))[0]?.status === "selecting");
    await first.confirm(request.id, [resourceId], signal());
    await until(async () => entered);
    await first.stop();
    await second.start();
    await until(async () => (await second.list("chat"))[0]?.status === "completed");
    assert.equal(commits, 1);
    await second.stop();
    await second.start();
    assert.equal(commits, 1);
    const raw = await fs.readFile(path.join(home, "connectors", driver.id, "state.json"), "utf8");
    assert.ok(!raw.includes("access-secret"));
    assert.ok(!raw.includes("refreshToken"));
    await second.disconnect();
    assert.equal((await second.list("chat"))[0]?.connected, false);
  }
  const drive = driveFixture();
  await exercise(
    new DriveReadonlyDriver({
      http: drive.http,
      client: async () => ({ clientId: googleCredential.clientId }),
      authorize: async () => googleCredential,
    }),
    fileId,
  );
  const notion = notionFixture();
  await exercise(
    new NotionReadonlyDriver({
      http: notion.http,
      client: async () => notionCredential,
      authorize: async () => ({ ...notionCredential }),
    }),
    id(4),
  );
});
