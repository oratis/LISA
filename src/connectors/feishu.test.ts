import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  authorizeFeishu,
  refreshFeishu,
  revokeFeishu,
  parseFeishuCredential,
  type FeishuCredential,
} from "./feishu-oauth.js";
import { FeishuReadonlyDriver, isFeishuReadRequest } from "./feishu-driver.js";
import {
  feishuHttp,
  feishuEndpointAllowed,
  FEISHU_SCOPES,
  type FeishuHttp,
} from "./feishu-http.js";
import { ConnectorError, type CredentialAccess } from "./types.js";
const signal = () => AbortSignal.timeout(5000);
const client = {
  clientId: "cli_test12345678",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:4863/oauth/feishu",
};
const account = {
  id: "ou_fixture",
  name: "Fixture",
  workspaceId: "tenant_fixture",
  workspaceName: "tenant_fixture",
};
const doc = {
  id: "doxbcmEtbFrbbq10nPNu8gabcef",
  name: "Fixture document",
  access: "file" as const,
};
const credential: FeishuCredential = {
  ...client,
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiry: Date.now() + 3600000,
  refreshExpiry: Date.now() + 86400000,
  scopes: [...FEISHU_SCOPES],
  userId: account.id,
  tenantId: account.workspaceId,
};
const grant = (extra: Record<string, unknown> = {}) => ({
  code: 0,
  access_token: "access-new",
  refresh_token: "refresh-new",
  expires_in: 7200,
  refresh_token_expires_in: 86400,
  token_type: "Bearer",
  scope: FEISHU_SCOPES.join(" "),
  ...extra,
});
function access(c = credential) {
  let raw = JSON.stringify(c),
    replaced = 0;
  return {
    use: async <T>(fn: Parameters<CredentialAccess["use"]>[0]) =>
      fn(raw, async (v) => {
        raw = v;
        replaced++;
      }) as Promise<T>,
    get raw() {
      return raw;
    },
    get replaced() {
      return replaced;
    },
  };
}
function fixture(
  extra?: (url: string, init: Parameters<FeishuHttp>[2]) => Record<string, unknown> | undefined,
) {
  const calls: string[] = [];
  const http: FeishuHttp = async (url, _s, init) => {
    calls.push(url);
    const custom = extra?.(url, init);
    if (custom) return custom;
    if (url.endsWith("/user_info"))
      return {
        data: {
          open_id: account.id,
          tenant_key: account.workspaceId,
          name: account.name,
          email: "not-returned@example.com",
        },
      };
    if (url.endsWith("/raw_content")) return { data: { content: "FEISHU-FLOW-VERIFIED" } };
    if (url.endsWith("/" + doc.id))
      return { data: { document: { document_id: doc.id, title: doc.name, revision_id: 1 } } };
    if (url.endsWith("/revoke")) return {};
    throw Error("Unexpected endpoint " + url);
  };
  return { http, calls };
}
async function freePort() {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
test("Feishu PKCE binds callback state and explicitly downscopes the v3 exchange", async () => {
  const c = { ...client, redirectUri: `http://localhost:${await freePort()}/oauth/feishu` };
  let url!: URL,
    notify!: () => void,
    exchanges = 0;
  const shown = new Promise<void>((r) => (notify = r));
  const pending = authorizeFeishu(
    c,
    async (endpoint, _s, init) => {
      exchanges++;
      assert.equal(endpoint, "https://accounts.feishu.cn/oauth/v3/token");
      assert.equal(init?.form?.client_secret, c.clientSecret);
      assert.equal(init?.form?.scope, FEISHU_SCOPES.join(" "));
      assert.equal(init?.form?.code, "fixture");
      assert.equal(
        createHash("sha256").update(init.form.code_verifier!).digest("base64url"),
        url.searchParams.get("code_challenge"),
      );
      return grant();
    },
    signal(),
    (v) => {
      url = new URL(v.authorizationUrl);
      notify();
    },
  );
  await shown;
  assert.equal(url.searchParams.get("scope"), FEISHU_SCOPES.join(" "));
  assert.equal(url.searchParams.has("prompt"), false);
  const driver = new FeishuReadonlyDriver();
  assert.ok(driver.validAuthorizationUrl(url.href));
  const legacy = new URL(url);
  legacy.searchParams.set("prompt", "consent");
  assert.ok(driver.validAuthorizationUrl(legacy.href));
  legacy.searchParams.set("prompt", "unknown");
  assert.equal(driver.validAuthorizationUrl(legacy.href), false);
  const cb = new URL(c.redirectUri);
  cb.searchParams.set("code", "fixture");
  cb.searchParams.set("state", "x".repeat(43));
  assert.equal((await fetch(cb)).status, 400);
  assert.equal(exchanges, 0);
  cb.searchParams.set("state", url.searchParams.get("state")!);
  assert.equal((await fetch(cb)).status, 200);
  const result = await pending;
  assert.equal(result.accessToken, "access-new");
  assert.equal(exchanges, 1);
  for (const scopes of [
    [],
    FEISHU_SCOPES.slice(1),
    [...FEISHU_SCOPES, "docx:document"],
    [...FEISHU_SCOPES, "offline_access"],
  ])
    assert.throws(
      () => parseFeishuCredential(JSON.stringify({ ...credential, scopes })),
      /reauthorization/,
    );
  assert.ok(
    parseFeishuCredential(
      JSON.stringify({ ...credential, scopes: [...FEISHU_SCOPES, "user_profile"] }),
    ),
  );
});
test("Feishu denial closes callback and never exchanges", async () => {
  const c = { ...client, redirectUri: `http://localhost:${await freePort()}/oauth/feishu` };
  let url!: URL, notify!: () => void;
  const shown = new Promise<void>((r) => (notify = r));
  const pending = authorizeFeishu(
    c,
    async () => {
      throw Error("must not exchange");
    },
    signal(),
    (v) => {
      url = new URL(v.authorizationUrl);
      notify();
    },
  );
  const rejected = assert.rejects(pending, /authorization_cancelled/);
  await shown;
  const cb = new URL(c.redirectUri);
  cb.searchParams.set("state", url.searchParams.get("state")!);
  cb.searchParams.set("error", "access_denied");
  assert.equal((await fetch(cb)).status, 200);
  await rejected;
  await assert.rejects(fetch(cb));
});
test("Feishu rotates single-use refresh tokens and preserves bound identity", async () => {
  const c = await refreshFeishu(
    credential,
    async (_url, _s, init) => {
      assert.equal(init?.form?.grant_type, "refresh_token");
      assert.equal(init?.form?.scope, FEISHU_SCOPES.join(" "));
      return grant();
    },
    signal(),
  );
  assert.equal(c.refreshToken, "refresh-new");
  assert.equal(c.tenantId, account.workspaceId);
  for (const invalid of [
    { scope: FEISHU_SCOPES.join(" ") + " docx:document" },
    { refresh_token: "" },
    { expires_in: 0 },
    { token_type: "tenant" },
    { refresh_token_expires_in: 0 },
  ])
    await assert.rejects(
      refreshFeishu(credential, async () => grant(invalid), signal()),
      /feishu_/,
    );
  await assert.rejects(
    refreshFeishu({ ...credential, refreshExpiry: 0 }, async () => grant(), signal()),
    /reauthorization/,
  );
  const hints: string[] = [];
  await revokeFeishu(
    c,
    async (_url, _s, init) => {
      hints.push(init!.form!.token_type_hint!);
      return {};
    },
    signal(),
  );
  assert.deepEqual(hints, ["refresh_token", "access_token"]);
});
test("Feishu transport fixes hosts, paths and methods, pins DNS and sanitizes provider errors", async () => {
  let calls = 0;
  const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
  const api = feishuHttp({
    lookup,
    transport: async (url, init, address) => {
      calls++;
      assert.equal(address.address, "93.184.216.34");
      assert.equal(init.redirect, "manual");
      return new Response(
        String(url).endsWith("/revoke") ? "" : JSON.stringify({ code: 0, data: {} }),
      );
    },
  });
  await api("https://open.feishu.cn/open-apis/authen/v1/user_info", signal(), {
    token: "access-secret",
  });
  await api("https://accounts.feishu.cn/oauth/v1/revoke", signal(), { form: { token: "fixture" } });
  assert.equal(calls, 2);
  for (const url of [
    "https://evil.example/open-apis/authen/v1/user_info",
    "http://open.feishu.cn/open-apis/authen/v1/user_info",
    "https://open.feishu.cn/open-apis/authen/v1/user_info?token=x",
    "https://open.feishu.cn/open-apis/docx/v1/documents/" + doc.id + "/blocks",
    "https://open.feishu.cn:444/open-apis/authen/v1/user_info",
  ]) {
    assert.equal(feishuEndpointAllowed(new URL(url), "GET"), false);
    await assert.rejects(api(url, signal()), /invalid_endpoint/);
  }
  assert.equal(calls, 2);
  await assert.rejects(
    api("https://open.feishu.cn/open-apis/authen/v1/user_info", signal(), { form: {} }),
    /invalid_endpoint/,
  );
  const privateApi = feishuHttp({
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    transport: async () => {
      throw Error("must not reach transport");
    },
  });
  await assert.rejects(
    privateApi("https://open.feishu.cn/open-apis/authen/v1/user_info", signal()),
    /feishu_unavailable/,
  );
  for (const [code, error] of [
    [20073, "reauthorization_required"],
    [20027, "read_scope_required"],
    [1770032, "access_denied"],
    [1770003, "document_unavailable"],
    [1770033, "response_too_large"],
    [99991400, "rate_limited"],
    [999, "request_failed"],
  ] as const) {
    const fail = feishuHttp({
      lookup,
      transport: async () => new Response(JSON.stringify({ code, msg: "access-secret" })),
    });
    await assert.rejects(
      fail("https://open.feishu.cn/open-apis/authen/v1/user_info", signal()),
      new RegExp("feishu_" + error),
    );
  }
  for (const response of [
    new Response("", { status: 302, headers: { location: "https://evil.example" } }),
    new Response("x".repeat(1_000_001)),
    new Response("", { status: 429 }),
  ])
    await assert.rejects(
      feishuHttp({ lookup, transport: async () => response })(
        "https://open.feishu.cn/open-apis/authen/v1/user_info",
        signal(),
      ),
      /feishu_(request_failed|response_too_large|rate_limited)/,
    );
});
test("Feishu only confirms explicit IDs and rejects writes/unselected documents before network", async () => {
  const f = fixture(),
    d = new FeishuReadonlyDriver({
      http: f.http,
      client: async () => client,
      authorize: async () => ({ ...credential }),
    });
  const auth = await d.authorize("login", signal(), () => {});
  assert.deepEqual(auth.account, account);
  assert.ok(!JSON.stringify(auth.account).includes("email"));
  assert.deepEqual(await d.resources(access(), 1, signal()), []);
  assert.deepEqual(await d.resource(access(), doc.id, signal()), doc);
  const count = f.calls.length;
  for (const args of [
    { operation: "write" },
    { operation: "content", resourceId: "not-selected" },
    { operation: "content", resourceId: doc.id, url: "https://evil.example" },
  ])
    await assert.rejects(
      d.read(access(), account, [doc], args, signal()),
      /read_operation_required|resource_not_granted/,
    );
  await assert.rejects(d.resource(access(), "https://evil.example", signal()), /invalid_resource/);
  assert.equal(f.calls.length, count);
  assert.equal(isFeishuReadRequest("查看飞书文档"), true);
  assert.equal(isFeishuReadRequest("修改飞书文档"), false);
  assert.equal(isFeishuReadRequest("read Feishu documents"), true);
});
test("Feishu checks identity and revision after text read, caps output and redacts secrets", async () => {
  const f = fixture((url) =>
      url.endsWith("/raw_content")
        ? { data: { content: "access-secret client-secret " + "x".repeat(31000) } }
        : undefined,
    ),
    d = new FeishuReadonlyDriver({ http: f.http });
  const result = (await d.read(
    access(),
    account,
    [doc],
    { operation: "content", resourceId: doc.id },
    signal(),
  )) as { content: string; truncated: boolean; untrusted: boolean };
  assert.ok(result.truncated && result.untrusted);
  assert.ok(!result.content.includes("access-secret"));
  assert.ok(!result.content.includes("client-secret"));
  assert.equal(f.calls.length, 5);
  for (const kind of ["tenant", "revision", "missing", "id"]) {
    let reads = 0;
    const f = fixture((url) => {
      if (url.endsWith("/raw_content")) {
        reads++;
        return undefined;
      }
      if (url.endsWith("/user_info") && reads && kind === "tenant")
        return { data: { open_id: account.id, tenant_key: "other_tenant", name: "Fixture" } };
      if (url.endsWith("/" + doc.id) && reads) {
        if (kind === "missing") throw new ConnectorError("feishu_access_denied");
        return {
          data: {
            document: {
              document_id: kind === "id" ? "different" : doc.id,
              title: doc.name,
              revision_id: kind === "revision" ? 2 : 1,
            },
          },
        };
      }
      return undefined;
    });
    await assert.rejects(
      new FeishuReadonlyDriver({ http: f.http }).read(
        access(),
        account,
        [doc],
        { operation: "content", resourceId: doc.id },
        signal(),
      ),
      /account_changed|document_changed|access_denied|resource_mismatch/,
    );
  }
});
test("Feishu persists rotation before use and refreshes a rejected token only once", async () => {
  const credentials = access({ ...credential, expiry: 0 });
  const f = fixture((url, init) => {
    if (url.endsWith("/token")) return grant();
    assert.equal(init?.token, "access-new");
    assert.equal(JSON.parse(credentials.raw).refreshToken, "refresh-new");
    return undefined;
  });
  await new FeishuReadonlyDriver({ http: f.http }).account(credentials, signal());
  assert.equal(credentials.replaced, 1);
  let rejected = 0;
  const retry = fixture((url) => {
    if (url.endsWith("/token")) return grant();
    if (++rejected === 1) throw new ConnectorError("feishu_reauthorization_required");
    return undefined;
  });
  const c = access();
  await new FeishuReadonlyDriver({ http: retry.http }).account(c, signal());
  assert.equal(c.replaced, 1);
});

test("Feishu retains durable authorization, resumes once after restart and disconnects safely", async (t) => {
  const { ReadonlyConnector } = await import("./service.js");
  const { MemorySecretStore } = await import("../warden/secrets.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  async function exercise<A, R>(
    driver: import("./types.js").ReadonlyDriver<A, R>,
    resourceId: string,
  ) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-feishu-restart-")),
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
        assert.equal(run.request.prompt, "Read selected Feishu document");
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
    const request = await first.create("chat", "Read selected Feishu document");
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
  const f = fixture();
  await exercise(
    new FeishuReadonlyDriver({
      http: f.http,
      client: async () => client,
      authorize: async () => credential,
    }),
    doc.id,
  );
});
