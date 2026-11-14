import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import {
  authorizeT3,
  parseT3Credential,
  t3Endpoint,
  t3Fetch,
  T3_SCOPE,
  type T3Credential,
} from "./t3-oauth.js";
import { T3ReadonlyDriver } from "./t3-driver.js";
import { remoteFetch, type McpFetch } from "../mcp/http.js";
import type { CredentialAccess } from "./types.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadonlyConnector } from "./service.js";
import { MemorySecretStore } from "../warden/secrets.js";
const endpoint = "https://fixture.t3.example/mcp",
  origin = new URL(endpoint).origin;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const signal = () => AbortSignal.timeout(5000);
const credential: T3Credential = {
  endpoint,
  clientId: "private-client",
  accessToken: "private-token",
  expiry: Date.now() + 3600000,
  scope: T3_SCOPE,
  environmentId: "env-1",
};
const access = (c = credential): CredentialAccess => ({
  use: (fn) =>
    fn(JSON.stringify(c), async () => {
      assert.fail("T3 has no refresh flow");
    }),
});
function metadata(path: string) {
  return path.includes("protected-resource")
    ? { resource: endpoint, authorization_servers: [origin], scopes_supported: [T3_SCOPE] }
    : {
        issuer: origin,
        authorization_endpoint: origin + "/oauth/mcp/authorize",
        token_endpoint: origin + "/oauth/mcp/token",
        registration_endpoint: origin + "/oauth/mcp/register",
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      };
}
test("T3 DCR binds callback issuer/state/PKCE, rejects write scopes and never requests refresh", async () => {
  for (const scope of [T3_SCOPE, T3_SCOPE + " orchestration:operate"]) {
    let url!: URL,
      redirect = "",
      ready!: () => void,
      exchanged = 0;
    const shown = new Promise<void>((r) => {
      ready = r;
    });
    const fetcher: McpFetch = async (raw, init) => {
      const pathname = new URL(raw).pathname;
      if (pathname.includes(".well-known")) return json(metadata(pathname));
      if (pathname.endsWith("/register")) {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.grant_types, ["authorization_code"]);
        redirect = body.redirect_uris[0];
        return json({ ...body, client_id: "private-client" });
      }
      assert.equal(pathname, "/oauth/mcp/token");
      exchanged++;
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("resource"), endpoint);
      assert.equal(
        createHash("sha256").update(form.get("code_verifier")!).digest("base64url"),
        url.searchParams.get("code_challenge"),
      );
      return json({ access_token: "private-token", token_type: "Bearer", scope, expires_in: 3600 });
    };
    const pending = authorizeT3(endpoint, fetcher, signal(), (p) => {
      url = new URL(p.authorizationUrl);
      ready();
    });
    void pending.catch(() => {});
    await shown;
    assert.equal(url.searchParams.get("scope"), T3_SCOPE);
    const callback = new URL(redirect);
    callback.searchParams.set("code", "code");
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("iss", "https://other.example");
    assert.equal((await fetch(callback)).status, 400);
    assert.equal(exchanged, 0);
    callback.searchParams.set("iss", origin);
    callback.searchParams.set("state", "bad");
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    assert.equal((await fetch(callback)).status, 200);
    if (scope === T3_SCOPE)
      assert.equal(parseT3Credential(JSON.stringify(await pending)).scope, T3_SCOPE);
    else await assert.rejects(pending, /t3_read_scope_required/);
  }
});
test("T3 refuses substituted OAuth metadata and aborts a waiting sign-in", async () => {
  let calls = 0;
  await assert.rejects(
    authorizeT3(
      endpoint,
      async () => {
        calls++;
        return json({});
      },
      signal(),
      () => {},
    ),
    /mcp_metadata_mismatch/,
  );
  assert.equal(calls, 2);
  const cancel = new AbortController();
  await assert.rejects(
    authorizeT3(
      endpoint,
      async (raw, init) => {
        if (String(raw).includes(".well-known")) return json(metadata(String(raw)));
        return json({ ...JSON.parse(String(init?.body)), client_id: "private-client" });
      },
      cancel.signal,
      () => cancel.abort(),
    ),
    /authorization_cancelled/,
  );
});

function fixture(beforeThreads?: () => Promise<void>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const state = {
    environment: "env-1",
    scope: T3_SCOPE,
    authenticated: true,
    foreign: false,
    hiddenScope: false,
    loop: false,
  };
  const fetcher: McpFetch = async (raw, init) => {
    const pathname = new URL(raw).pathname;
    if (pathname === "/api/auth/session") {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-token");
      return json({ authenticated: state.authenticated, scopes: state.scope.split(" ") });
    }
    if (pathname === "/.well-known/t3/environment")
      return json({ environmentId: state.environment, label: "T3 fixture" });
    assert.equal(String(raw), endpoint);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-token");
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const msg = JSON.parse(String(init?.body));
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result: unknown;
    if (msg.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "T3 fixture", version: "pinned" },
      };
    else if (msg.method === "tools/list")
      result = {
        tools: [
          {
            name: "t3_project_list",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object", properties: { cursor: {}, limit: {} } },
          },
          {
            name: "t3_thread_list",
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: {
                projectId: {},
                ...(state.hiddenScope ? {} : { allProjects: {} }),
                includeSubagents: {},
                cursor: {},
                limit: {},
              },
            },
          },
          {
            name: "t3_thread_read",
            annotations: { readOnlyHint: false },
            inputSchema: { type: "object" },
          },
        ],
      };
    else {
      assert.equal(msg.method, "tools/call");
      const { name, arguments: args } = msg.params;
      if (name === "t3_thread_list") await beforeThreads?.();
      calls.push({ name, args });
      const payload =
        name === "t3_project_list"
          ? {
              projects: Array.from({ length: 20 }, (_, i) => ({
                id: "project-" + (Number(args.cursor) + i),
                title: "Project " + (Number(args.cursor) + i),
                workspaceRoot: "/hidden/path",
                scripts: ["secret script"],
              })),
              nextCursor: state.loop
                ? Number(args.cursor)
                : Number(args.cursor) < 40
                  ? Number(args.cursor) + 20
                  : null,
            }
          : {
              projectId: state.foreign ? "project-2" : args.projectId,
              threads: [
                {
                  threadId: "thread-1",
                  projectId: args.projectId,
                  title: "Thread",
                  status: "idle",
                  createdAt: "2026-01-01",
                  updatedAt: "2026-01-02",
                  parentThreadId: null,
                  privateTranscript: "NEVER FORWARD",
                  link: "https://unreviewed.example",
                },
              ],
              nextCursor: Number(args.cursor) === 0 ? 1 : null,
              total: 2,
            };
      assert.ok(["t3_project_list", "t3_thread_list"].includes(name));
      result = { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    return json({ jsonrpc: "2.0", id: msg.id, result });
  };
  const driver = new T3ReadonlyDriver({
    endpoint,
    fetch: () => fetcher,
    authorize: async () => ({ ...credential }),
  });
  return { driver, state, calls };
}
test("T3 picker fills short pages and only selected project thread metadata reaches the model", async () => {
  const f = fixture(),
    credentials = access(),
    account = await f.driver.account(credentials, signal());
  const page = await f.driver.resources(credentials, 1, signal());
  assert.equal(page.length, 30);
  assert.equal((await f.driver.resources(credentials, 2, signal()))[0]!.id, "project-30");
  const selected = [await f.driver.resource(credentials, "project-31", signal())];
  const list = await f.driver.read(credentials, account, selected, { operation: "list" }, signal());
  assert.deepEqual(list, { projects: selected });
  const threads = await f.driver.read(
    credentials,
    account,
    selected,
    { operation: "threads", resourceId: "project-31" },
    signal(),
  );
  assert.equal(threads.nextCursor, 1);
  assert.equal(threads.threads?.length, 1);
  assert.doesNotMatch(
    JSON.stringify(threads),
    /NEVER FORWARD|unreviewed|hidden\/path|secret script/,
  );
  assert.deepEqual(f.calls.at(-1), {
    name: "t3_thread_list",
    args: {
      projectId: "project-31",
      allProjects: false,
      includeSubagents: false,
      cursor: 0,
      limit: 30,
    },
  });
  const last = await f.driver.read(
    credentials,
    account,
    selected,
    { operation: "threads", resourceId: "project-31", cursor: 1 },
    signal(),
  );
  assert.equal(last.nextCursor, null);
  assert.throws(
    () =>
      f.driver.read(
        credentials,
        account,
        selected,
        { operation: "threads", resourceId: "project-1" },
        signal(),
      ),
    /resource_not_selected/,
  );
});

test("T3 discards a buffered read after upstream revocation", async () => {
  const f = fixture(async () => {
    f.state.authenticated = false;
  });
  const account = await f.driver.account(access(), signal());
  await assert.rejects(
    f.driver.read(
      access(),
      account,
      [{ id: "project-1", name: "Project", access: "project" }],
      { operation: "threads", resourceId: "project-1" },
      signal(),
    ),
    /t3_reauthorization_required/,
  );
});

test("T3 disconnect deletes staged/active credentials and a late read cannot resume the task", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-t3-lifecycle-"));
  const secrets = new MemorySecretStore();
  let release!: () => void,
    entered!: () => void,
    commits = 0;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const f = fixture(async () => {
    entered();
    await blocked;
  });
  const service = new ReadonlyConnector({
    home,
    secrets,
    driver: f.driver,
    changed: () => {},
    resume: async (run) => {
      assert.equal(run.request.prompt, "查看 T3 项目线程");
      assert.deepEqual(
        run.tools.map((tool) => tool.name),
        ["t3_read"],
      );
      await run.tools[0]!.execute(
        { operation: "threads", resourceId: "project-1" },
        { cwd: home, signal: run.signal, log: () => {} },
      );
      await run.commit(async () => {
        commits++;
      });
    },
  });
  t.after(async () => {
    release();
    await service.stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  await service.start();
  const authorize = async () => {
    const r = await service.create("chat", "查看 T3 项目线程");
    await service.authorize(r.id, "login");
    const deadline = Date.now() + 5000;
    while (
      !(await service.list("chat")).some((row) => row.id === r.id && row.status === "selecting")
    ) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return r;
  };
  await authorize();
  assert.equal((await secrets.list()).length, 1);
  await service.disconnect();
  assert.equal((await secrets.list()).length, 0);
  const r = await authorize();
  await service.confirm(r.id, ["project-1"], signal());
  await waiting;
  await service.disconnect();
  assert.equal((await secrets.list()).length, 0);
  release();
  await service.stop();
  assert.equal(commits, 0);
  assert.equal((await service.list("chat")).find((row) => row.id === r.id)!.status, "cancelled");
  const raw = await fs.readFile(path.join(home, "connectors/t3/state.json"), "utf8");
  assert.doesNotMatch(raw, /private-token|private-client/);
});
test("T3 rejects scope broadening, foreign rows, schema changes, changed environment and expired grants", async () => {
  const f = fixture(),
    credentials = access(),
    account = await f.driver.account(credentials, signal());
  const resources = [{ id: "project-1", name: "Project 1", access: "project" as const }];
  const read = () =>
    f.driver.read(
      credentials,
      account,
      resources,
      { operation: "threads", resourceId: "project-1" },
      signal(),
    );
  for (const input of [
    { operation: "thread_read" },
    { operation: "threads", resourceId: "project-1", allProjects: true },
    { operation: "list", environmentId: "other" },
  ])
    assert.throws(
      () => f.driver.read(credentials, account, resources, input, signal()),
      /read_operation_required/,
    );
  f.state.foreign = true;
  await assert.rejects(read(), /t3_resource_mismatch/);
  f.state.foreign = false;
  f.state.hiddenScope = true;
  await assert.rejects(read(), /mcp_tools_changed/);
  f.state.hiddenScope = false;
  f.state.environment = "env-2";
  await assert.rejects(read(), /connector_account_changed/);
  f.state.environment = "env-1";
  f.state.scope += " orchestration:operate";
  await assert.rejects(read(), /t3_read_scope_required/);
  f.state.scope = T3_SCOPE;
  f.state.authenticated = false;
  await assert.rejects(read(), /t3_reauthorization_required/);
  f.state.authenticated = true;
  await assert.rejects(
    f.driver.account(access({ ...credential, expiry: 0 }), signal()),
    /t3_reauthorization_required/,
  );
  f.state.loop = true;
  await assert.rejects(f.driver.resources(credentials, 1, signal()), /t3_invalid_response/);
  const aborted = AbortSignal.abort();
  await assert.rejects(
    f.driver.read(credentials, account, resources, { operation: "list" }, aborted),
  );
});

test("T3 loopback transport is explicitly pinned; redirects, other paths and remote plaintext are refused", async () => {
  let redirects = false,
    requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    if (redirects) {
      res.writeHead(302, { location: "http://example.com/" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const local = `http://localhost:${(server.address() as { port: number }).port}/mcp`;
  try {
    const fetcher = t3Fetch(local, signal());
    assert.deepEqual(await (await fetcher(new URL("/api/auth/session", local))).json(), {
      ok: true,
    });
    redirects = true;
    await assert.rejects(fetcher(new URL("/api/auth/session", local)), /mcp_redirect_refused/);
    const count = requests;
    await assert.rejects(
      fetcher(new URL("/api/auth/token", local), { method: "POST" }),
      /mcp_invalid_endpoint/,
    );
    await assert.rejects(fetcher("http://127.0.0.1:9/mcp"), /mcp_invalid_endpoint/);
    await assert.rejects(remoteFetch(() => true, signal())(local), /mcp_invalid_endpoint/);
    assert.equal(requests, count);
    for (const bad of [
      "http://192.168.1.1/mcp",
      "https://x/mcp?token=secret",
      "https://u:p@x/mcp",
      "https://x:8443/mcp",
      "file:///mcp",
      "https://x/other",
    ])
      assert.throws(() => t3Endpoint(bad), /t3_endpoint_not_configured/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
