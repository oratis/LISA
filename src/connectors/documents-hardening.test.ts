/**
 * Review follow-ups for the Drive / Notion connectors (#445): nullable Notion refresh
 * tokens, partial Drive selections, the fixed Notion callback port, provider wording for
 * shared HTTP errors, the 30-file Picker limit and best-effort Notion revocation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DriveReadonlyDriver } from "./drive-driver.js";
import { NotionReadonlyDriver } from "./notion-driver.js";
import { notionEndpointAllowed, notionHttp, type NotionHttp } from "./notion-http.js";
import {
  authorizeNotion,
  parseNotionCredential,
  refreshNotion,
  type NotionCredential,
} from "./notion-oauth.js";
import { GOOGLE_SCOPES, authorizeGoogle } from "./google-oauth.js";
import { googleHttp, type GoogleHttp } from "./google-http.js";
import { ReadonlyConnector } from "./service.js";
import { ConnectorError, type CredentialAccess, type ReadonlyDriver } from "./types.js";
import { MemorySecretStore } from "../warden/secrets.js";

const signal = () => AbortSignal.timeout(5000);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const code = (error: unknown) => (error instanceof ConnectorError ? error.code : String(error));
const access = (c: object): CredentialAccess => {
  let raw = JSON.stringify(c);
  return {
    use: async (fn) =>
      fn(raw, async (value) => {
        raw = value;
      }),
  };
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
const tokenResponse = (refresh: unknown) => ({
  access_token: "new-access",
  token_type: "bearer",
  refresh_token: refresh,
  workspace_id: id(2),
  workspace_name: null,
  bot_id: id(3),
});
async function freePort(host = "127.0.0.1") {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, host, r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function hasIpv6Loopback() {
  const server = net.createServer();
  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "::1", () => server.close(() => resolve(true)));
  });
}
async function occupy(port: number, host: string) {
  const server = net.createServer();
  await new Promise<void>((r, j) => {
    server.once("error", j);
    server.listen(port, host, r);
  });
  return () => new Promise<void>((r) => server.close(() => r()));
}

// ── 1. Notion `refresh_token` is documented as `string | null` ──────────────
test("Notion refresh keeps the previous refresh token when the response carries null", async () => {
  for (const refresh of [null, undefined]) {
    const next = await refreshNotion(
      notionCredential,
      async () => tokenResponse(refresh),
      signal(),
    );
    assert.equal(next.accessToken, "new-access");
    assert.equal(next.refreshToken, "notion-refresh-secret");
    assert.equal(next.identityId, id(3));
    assert.equal(next.workspaceName, "Notion");
  }
  // A rotated refresh token still replaces the old one.
  assert.equal(
    (await refreshNotion(notionCredential, async () => tokenResponse("rotated"), signal()))
      .refreshToken,
    "rotated",
  );
  // A present but malformed refresh token is still an invalid response.
  for (const refresh of ["", 42, {}])
    await assert.rejects(
      refreshNotion(notionCredential, async () => tokenResponse(refresh), signal()),
      /notion_invalid_response/,
    );
});

test("Notion sign-in accepts refresh_token: null and stores a credential without one", async () => {
  const port = await freePort();
  const client = {
    clientId: id(1),
    clientSecret: "client-secret",
    redirectUri: `http://localhost:${port}/oauth/notion`,
  };
  const credential = await authorizeNotion(
    client,
    async () => tokenResponse(null),
    signal(),
    (p) => {
      const state = new URL(p.authorizationUrl).searchParams.get("state")!;
      void fetch(`http://localhost:${port}/oauth/notion?code=fixture&state=${state}`).catch(
        () => {},
      );
    },
  );
  assert.equal(credential.accessToken, "new-access");
  assert.equal("refreshToken" in credential, false);
  const stored = parseNotionCredential(JSON.stringify({ ...credential, identityId: id(3) }));
  assert.equal(stored.refreshToken, undefined);
  // Without any refresh token, refreshing asks for reconnecting instead of failing generically.
  await assert.rejects(
    refreshNotion(stored, async () => assert.fail("no refresh request"), signal()),
    /notion_reauthorization_required/,
  );
});

test("an expired Notion connection without a refresh token is dropped for reconnecting", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-notion-norefresh-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let expired = false,
    readError = "";
  const pageId = id(4);
  const notion: NotionHttp = async (route) => {
    if (route === "/v1/oauth/introspect") return { active: !expired, scope: "read_content" };
    if (route === "/v1/oauth/token") assert.fail("no refresh token to send");
    if (route === "/v1/users/me") return { object: "user", id: id(3), name: "Bot", type: "bot" };
    if (route === "/v1/pages/" + pageId)
      return {
        object: "page",
        id: pageId,
        parent: { type: "workspace", workspace: true },
        properties: { title: { type: "title", title: [{ plain_text: "Page" }] } },
      };
    throw Error("unexpected " + route);
  };
  const withoutRefresh: NotionCredential = { ...notionCredential };
  delete withoutRefresh.refreshToken;
  const driver = new NotionReadonlyDriver({
    http: notion,
    client: async () => notionCredential,
    authorize: async () => ({ ...withoutRefresh }),
  });
  const connector = new ReadonlyConnector({
    home,
    driver,
    secrets: new MemorySecretStore(),
    changed: () => {},
    resume: async (run) => {
      expired = true;
      await run.tools[0]!.execute(
        { operation: "metadata", resourceId: pageId },
        { cwd: home, signal: run.signal, log: () => {} },
      ).catch((error: unknown) => {
        readError = code(error);
      });
    },
  });
  t.after(() => connector.stop());
  await connector.start();
  const request = await connector.create("chat", "Read my Notion page");
  await connector.authorize(request.id, "login");
  for (let i = 0; i < 300 && (await connector.list("chat"))[0]?.status !== "selecting"; i++)
    await new Promise((r) => setTimeout(r, 10));
  await connector.confirm(request.id, [pageId], signal());
  for (let i = 0; i < 300 && !readError; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(readError, "notion_reauthorization_required");
  const [view] = await connector.list("chat");
  assert.equal(view?.connected, false);
  assert.equal(view?.error, "notion_reauthorization_required");
});

// ── 2. One unavailable Picker file no longer hides the rest ─────────────────
function drivePicks(states: Record<string, "ok" | "trashed" | "gone" | "shortcut" | "expired">) {
  const http: GoogleHttp = async (url) => {
    if (url.includes("/about?"))
      return { user: { permissionId: "account-1", displayName: "F", emailAddress: "f@x.test" } };
    const fid = url.split("/files/")[1]!.split("?")[0]!;
    const state = states[fid];
    if (state === "gone") throw new ConnectorError("google_request_failed", 404);
    if (state === "expired") throw new ConnectorError("google_reauthorization_required", 401);
    return {
      id: fid,
      name: "File " + fid,
      mimeType:
        state === "shortcut"
          ? "application/vnd.google-apps.shortcut"
          : "application/vnd.google-apps.document",
      trashed: state === "trashed",
      capabilities: { canDownload: true },
    };
  };
  const credential = {
    clientId: "fixture.apps.googleusercontent.com",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiry: Date.now() + 3600_000,
    scopes: [...GOOGLE_SCOPES.driveFile],
    allowedScopes: [...GOOGLE_SCOPES.driveFile],
    pickedFileIds: Object.keys(states),
  };
  return { driver: new DriveReadonlyDriver({ http }), credentials: access(credential) };
}

test("Drive lists the usable picks when others are trashed, deleted or unsupported", async () => {
  const { driver, credentials } = drivePicks({
    "good-file-0001": "ok",
    "trashed-file-02": "trashed",
    "deleted-file-03": "gone",
    "shortcut-file-4": "shortcut",
    "good-file-0005": "ok",
  });
  assert.deepEqual(
    (await driver.resources(credentials, 1, signal())).map((r) => r.id),
    ["good-file-0001", "good-file-0005"],
  );
  // A deleted file is reported as unavailable when confirmed or read directly.
  await assert.rejects(
    driver.resource(credentials, "deleted-file-03", signal()),
    /drive_file_unavailable/,
  );
});

test("Drive asks for a new selection when no pick is usable, and still fails on lost access", async () => {
  const none = drivePicks({ "trashed-file-01": "trashed", "deleted-file-02": "gone" });
  await assert.rejects(
    none.driver.resources(none.credentials, 1, signal()),
    /drive_selection_required/,
  );
  // Account-wide failures are never hidden as a shorter list.
  const lost = drivePicks({ "good-file-0001": "ok", "expired-file-02": "expired" });
  await assert.rejects(
    lost.driver.resources(lost.credentials, 1, signal()),
    /google_reauthorization_required/,
  );
});

test("Google HTTP keeps the upstream status so a per-file 404 is distinguishable", async () => {
  const request = googleHttp({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    transport: async () => new Response("{}", { status: 404 }),
  });
  const error = await request("https://www.googleapis.com/drive/v3/files/x", signal()).catch(
    (e: unknown) => e,
  );
  assert.ok(error instanceof ConnectorError);
  assert.equal(error.code, "google_request_failed");
  assert.equal(error.httpStatus, 404);
});

// ── 3. Fixed Notion callback port ────────────────────────────────────────────
const notionClientOn = (port: number) => ({
  clientId: id(1),
  clientSecret: "client-secret",
  redirectUri: `http://localhost:${port}/oauth/notion`,
});

test("a taken Notion callback port fails with notion_callback_port_in_use", async () => {
  const port = await freePort();
  const release = await occupy(port, "127.0.0.1");
  try {
    await assert.rejects(
      authorizeNotion(
        notionClientOn(port),
        async () => ({}),
        signal(),
        () => assert.fail("no authorization URL while the port is taken"),
      ),
      /notion_callback_port_in_use/,
    );
  } finally {
    await release();
  }
});

test("Notion holds ::1 too, so no other process can take the localhost callback", async (t) => {
  if (!(await hasIpv6Loopback())) return t.skip("host has no IPv6 loopback");
  const port = await freePort();
  // Someone else already listening on [::1]:port would receive the browser's callback.
  const release = await occupy(port, "::1");
  try {
    await assert.rejects(
      authorizeNotion(
        notionClientOn(port),
        async () => ({}),
        signal(),
        () => assert.fail("no authorization URL while ::1 is taken"),
      ),
      /notion_callback_port_in_use/,
    );
  } finally {
    await release();
  }
  // With both loopbacks free, a browser that reaches ::1 lands on LISA's own listener.
  let ready!: (state: string) => void;
  const authorizing = new Promise<string>((r) => (ready = r));
  const task = authorizeNotion(
    notionClientOn(port),
    async () => tokenResponse("refresh"),
    signal(),
    (p) => ready(new URL(p.authorizationUrl).searchParams.get("state")!),
  );
  const state = await authorizing;
  await assert.rejects(occupy(port, "::1"), /EADDRINUSE/);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    http
      .get(
        {
          host: "::1",
          port,
          path: `/oauth/notion?code=fixture&state=${state}`,
          headers: { host: `localhost:${port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(status, 200);
  assert.equal((await task).accessToken, "new-access");
  // Both listeners are released afterwards.
  await (
    await occupy(port, "::1")
  )();
  await (
    await occupy(port, "127.0.0.1")
  )();
});

// ── 4. Shared remoteFetch errors carry Drive / Notion wording ────────────────
test("Notion maps shared mcp_* transport errors to notion_* codes", async () => {
  const failing = (error: ConnectorError | Response) =>
    notionHttp(() => async () => {
      if (error instanceof Response) return error;
      throw error;
    });
  for (const [thrown, expected] of [
    [new ConnectorError("mcp_unavailable"), "notion_unavailable"],
    [new ConnectorError("mcp_request_failed", 500), "notion_request_failed"],
    [new ConnectorError("mcp_redirect_refused"), "notion_request_failed"],
    [new ConnectorError("mcp_response_too_large"), "notion_response_too_large"],
    [new ConnectorError("mcp_access_denied", 403), "notion_access_denied"],
    [new ConnectorError("mcp_rate_limited", 429), "notion_rate_limited"],
    [new ConnectorError("notion_reauthorization_required", 401), "notion_reauthorization_required"],
    [new Response("not json"), "notion_invalid_response"],
  ] as const)
    assert.equal(
      await failing(thrown)("/v1/users/me", signal(), { token: "t" }).then(() => "resolved", code),
      expected,
    );
});

test("Drive content maps shared mcp_* transport errors to drive_* codes", async () => {
  const mime = "application/vnd.google-apps.document";
  const http: GoogleHttp = async (url) =>
    url.includes("/about?")
      ? { user: { permissionId: "account-1", displayName: "F", emailAddress: "f@x.test" } }
      : { id: "picked-file-01", name: "Doc", mimeType: mime, capabilities: { canDownload: true } };
  const credentials = access({
    clientId: "fixture.apps.googleusercontent.com",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiry: Date.now() + 3600_000,
    scopes: [...GOOGLE_SCOPES.driveFile],
    allowedScopes: [...GOOGLE_SCOPES.driveFile],
    pickedFileIds: ["picked-file-01"],
  });
  const account = { id: "account-1", name: "F", email: "f@x.test" };
  const resource = { id: "picked-file-01", name: "Doc", access: "file" as const, mimeType: mime };
  for (const [thrown, expected] of [
    [new ConnectorError("mcp_access_denied", 403), "drive_access_denied"],
    [new ConnectorError("mcp_rate_limited", 429), "drive_rate_limited"],
    [new ConnectorError("mcp_unavailable"), "drive_unavailable"],
    [new ConnectorError("mcp_request_failed", 500), "drive_request_failed"],
    [new ConnectorError("mcp_request_failed", 404), "drive_file_unavailable"],
    [new ConnectorError("mcp_response_too_large"), "drive_content_too_large"],
    [new ConnectorError("google_reauthorization_required", 401), "google_reauthorization_required"],
  ] as const) {
    const driver = new DriveReadonlyDriver({
      http,
      content: () => async () => {
        throw thrown;
      },
    });
    assert.equal(
      await driver
        .read(
          credentials,
          account,
          [resource],
          { operation: "content", resourceId: resource.id },
          signal(),
        )
        .then(() => "resolved", code),
      expected,
    );
  }
});

test("every new Drive / Notion card error has English and Chinese wording", async () => {
  const client = path.join(import.meta.dirname, "../web/assets/client");
  const [cards, strings] = await Promise.all([
    fs.readFile(path.join(client, "connectors.js"), "utf8"),
    fs.readFile(path.join(client, "main.js"), "utf8"),
  ]);
  for (const name of [
    "notion_callback_port_in_use",
    "notion_request_failed",
    "notion_response_too_large",
    "notion_invalid_response",
    "notion_unavailable",
    "drive_selection_limit_exceeded",
    "drive_access_denied",
    "drive_rate_limited",
    "drive_unavailable",
    "drive_request_failed",
  ]) {
    assert.ok(cards.includes(`${name}: tr('connector.error.${name}')`), name);
    const lines = strings.split("\n").filter((l) => l.includes(`"connector.error.${name}":`));
    assert.equal(lines.length, 2, `${name} needs one English and one Chinese string`);
    assert.ok(!/Linear/.test(lines.join("\n")), `${name} must not mention Linear`);
  }
});

// ── 7. More than 30 Picker files ─────────────────────────────────────────────
test("the Drive Picker callback reports more than 30 files as a limit, not an empty pick", async () => {
  let url!: URL, ready!: () => void;
  const signalled = new Promise<void>((r) => (ready = r));
  const task = authorizeGoogle(
    { clientId: "fixture.apps.googleusercontent.com" },
    GOOGLE_SCOPES.driveFile,
    signal(),
    (p) => {
      url = new URL(p.authorizationUrl);
      ready();
    },
    async () => assert.fail("no token exchange over the limit"),
    { drivePicker: true },
  );
  void task.catch(() => {});
  await signalled;
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  callback.searchParams.set("code", "fixture");
  callback.searchParams.set(
    "picked_file_ids",
    Array.from({ length: 31 }, (_, i) => `picked-file-${String(i).padStart(3, "0")}`).join(","),
  );
  const res = await fetch(callback);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /More than 30 files/);
  await assert.rejects(task, /drive_selection_limit_exceeded/);
});

// ── 6. Disconnect revocation ─────────────────────────────────────────────────
async function connectedNotion(
  t: import("node:test").TestContext,
  revoke: NotionHttp,
  revokeTimeoutMs?: number,
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-notion-revoke-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const pageId = id(4);
  const notion: NotionHttp = async (route, s, init) => {
    if (route === "/v1/oauth/revoke") return revoke(route, s, init);
    if (route === "/v1/oauth/introspect") return { active: true, scope: "read_content" };
    if (route === "/v1/users/me") return { object: "user", id: id(3), name: "Bot", type: "bot" };
    if (route === "/v1/pages/" + pageId)
      return {
        object: "page",
        id: pageId,
        parent: { type: "workspace", workspace: true },
        properties: { title: { type: "title", title: [{ plain_text: "Page" }] } },
      };
    throw Error("unexpected " + route);
  };
  const secrets = new MemorySecretStore();
  const connector = new ReadonlyConnector({
    home,
    driver: new NotionReadonlyDriver({
      http: notion,
      client: async () => notionCredential,
      authorize: async () => ({ ...notionCredential }),
    }),
    secrets,
    changed: () => {},
    resume: async (run) => run.commit(async () => {}),
    ...(revokeTimeoutMs ? { revokeTimeoutMs } : {}),
  });
  t.after(() => connector.stop());
  await connector.start();
  const request = await connector.create("chat", "Read my Notion page");
  await connector.authorize(request.id, "login");
  for (let i = 0; i < 300 && (await connector.list("chat"))[0]?.status !== "selecting"; i++)
    await new Promise((r) => setTimeout(r, 10));
  await connector.confirm(request.id, [pageId], signal());
  for (let i = 0; i < 300 && (await connector.list("chat"))[0]?.status !== "completed"; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal((await connector.list("chat"))[0]?.connected, true);
  return { connector, secrets };
}

test("Notion disconnect revokes the token upstream with Basic client auth", async (t) => {
  const revoked: { token?: string; basic?: unknown }[] = [];
  const { connector, secrets } = await connectedNotion(t, async (_route, _s, init) => {
    revoked.push({
      token: (init?.json as { token?: string }).token,
      basic: init?.basic,
    });
    return { request_id: id(9) };
  });
  await connector.disconnect();
  assert.deepEqual(revoked, [
    {
      token: "notion-access-secret",
      basic: { ...notionCredential },
    },
  ]);
  assert.equal((await connector.list("chat"))[0]?.connected, false);
  assert.equal((await secrets.list()).length, 0);
  assert.equal(
    notionEndpointAllowed(new URL("https://api.notion.com/v1/oauth/revoke"), "POST"),
    true,
  );
  assert.equal(
    notionEndpointAllowed(new URL("https://api.notion.com/v1/oauth/revoke"), "GET"),
    false,
  );
});

test("Notion disconnect deletes locally even when revocation fails or never answers", async (t) => {
  const failing = await connectedNotion(t, async () => {
    throw new ConnectorError("notion_unavailable");
  });
  await failing.connector.disconnect();
  assert.equal((await failing.connector.list("chat"))[0]?.connected, false);
  assert.equal((await failing.secrets.list()).length, 0);
  // A revocation that ignores its signal is still bounded.
  const hanging = await connectedNotion(t, () => new Promise(() => {}), 50);
  const started = Date.now();
  await hanging.connector.disconnect();
  assert.ok(Date.now() - started < 2000);
  assert.equal((await hanging.connector.list("chat"))[0]?.connected, false);
  assert.equal((await hanging.secrets.list()).length, 0);
});

test("Drive deliberately has no upstream revoke: Google would revoke every LISA Google scope", () => {
  const driver: ReadonlyDriver<unknown, unknown> = new DriveReadonlyDriver();
  assert.equal(driver.revoke, undefined);
});
