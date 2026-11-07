import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import {
  authorizeLinear,
  refreshLinear,
  LINEAR_ORIGIN,
  LINEAR_ENDPOINT,
  linearEndpointAllowed,
} from "./linear-oauth.js";
import { remoteFetch, type McpFetch } from "../mcp/http.js";
import { loopbackAuthorization } from "./oauth-loopback.js";
const json = (v: unknown) =>
  new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } });
function metadata(path: string) {
  if (path.includes("protected-resource"))
    return {
      resource: LINEAR_ENDPOINT,
      authorization_servers: [LINEAR_ORIGIN],
      scopes_supported: ["read"],
    };
  return {
    issuer: LINEAR_ORIGIN,
    authorization_endpoint: LINEAR_ORIGIN + "/authorize",
    token_endpoint: LINEAR_ORIGIN + "/token",
    registration_endpoint: LINEAR_ORIGIN + "/register",
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}
test("Linear DCR requests only read, binds issuer/state/PKCE and rotates the saved token pair", async () => {
  let ready!: () => void,
    url!: URL,
    redirect = "",
    exchanges = 0;
  const wait = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const mock: McpFetch = async (raw, init) => {
    const path = new URL(raw).pathname;
    if (path.includes(".well-known")) return json(metadata(path));
    if (path === "/register") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.scope, "read");
      assert.equal(body.token_endpoint_auth_method, "none");
      redirect = body.redirect_uris[0];
      return json({ ...body, client_id: "fixture-client" });
    }
    assert.equal(path, "/token");
    exchanges++;
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("resource"), LINEAR_ENDPOINT);
    if (form.get("grant_type") === "refresh_token") {
      assert.equal(form.get("refresh_token"), "first-refresh");
      return json({
        access_token: "second-access",
        refresh_token: "second-refresh",
        token_type: "bearer",
        scope: "read",
        expires_in: 3600,
      });
    }
    assert.equal(
      createHash("sha256").update(form.get("code_verifier")!).digest("base64url"),
      url.searchParams.get("code_challenge"),
    );
    return json({
      access_token: "first-access",
      refresh_token: "first-refresh",
      token_type: "bearer",
      scope: "read",
      expires_in: 3600,
    });
  };
  const result = authorizeLinear(mock, AbortSignal.timeout(5000), (p) => {
    url = new URL(p.authorizationUrl);
    ready();
  });
  await wait;
  assert.equal(url.searchParams.get("scope"), "read");
  const callback = new URL(redirect);
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("state", url.searchParams.get("state")!);
  callback.searchParams.set("iss", "https://evil.example");
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(exchanges, 0);
  callback.searchParams.set("iss", LINEAR_ORIGIN);
  callback.searchParams.set("state", "wrong");
  assert.equal((await fetch(callback)).status, 400);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  const hostile = await new Promise<number | undefined>((resolve, reject) =>
    http
      .get(callback, { headers: { Host: "evil.example" } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      })
      .on("error", reject),
  );
  assert.equal(hostile, 400);
  assert.equal((await fetch(callback)).status, 200);
  const c = await result;
  assert.equal(c.scope, "read");
  assert.equal(exchanges, 1);
  const next = await refreshLinear(c, mock);
  assert.equal(next.accessToken, "second-access");
  assert.equal(next.refreshToken, "second-refresh");
});
test("foreign metadata is refused before registration; wider refresh scopes fail closed", async () => {
  let calls = 0;
  await assert.rejects(
    authorizeLinear(
      async () => {
        calls++;
        return json({
          resource: "https://evil.example",
          authorization_servers: ["https://evil.example"],
        });
      },
      AbortSignal.timeout(1000),
      () => {},
    ),
    /mcp_metadata_mismatch/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    refreshLinear(
      { clientId: "c", accessToken: "a", refreshToken: "r", expiry: 0, scope: "read" },
      async () =>
        json({
          access_token: "new",
          refresh_token: "new",
          expires_in: 3600,
          token_type: "bearer",
          scope: "read write",
        }),
    ),
    /linear_read_scope_required/,
  );
});
test("remote MCP HTTP pins public DNS, rejects redirects, bounds responses and hides provider errors", async () => {
  let requests = 0;
  const privateFetch = remoteFetch(linearEndpointAllowed, AbortSignal.timeout(1000), {
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    transport: async () => {
      requests++;
      return json({});
    },
  });
  await assert.rejects(privateFetch(LINEAR_ENDPOINT, { method: "POST" }), /mcp_unavailable/);
  assert.equal(requests, 0);
  for (const [response, error] of [
    [new Response("sensitive-token", { status: 401 }), "mcp_reauthorization_required"],
    [
      new Response("redirect", { status: 307, headers: { location: "https://evil.example" } }),
      "mcp_redirect_refused",
    ],
    [new Response("x".repeat(1_000_001)), "mcp_response_too_large"],
  ] as const) {
    const fetcher = remoteFetch(linearEndpointAllowed, AbortSignal.timeout(1000), {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: async (_url, init, ip) => {
        assert.equal(ip.address, "8.8.8.8");
        assert.equal(init.redirect, "manual");
        return response;
      },
    });
    await assert.rejects(
      fetcher(LINEAR_ENDPOINT, { method: "POST" }),
      new RegExp("^Error: " + error + "$"),
    );
    await assert.rejects(
      fetcher("https://evil.example", { method: "POST" }),
      /mcp_invalid_endpoint/,
    );
  }
});

test("loopback denial, cancellation and replay cannot produce an authorization code twice", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let ready!: (url: string) => void;
    const urlPromise = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const result = loopbackAuthorization(controller.signal, LINEAR_ORIGIN, async (a) => {
      ready(
        a.redirect +
          "?" +
          new URLSearchParams({ state: a.state, iss: LINEAR_ORIGIN, error: "access_denied" }),
      );
      return a.code;
    });
    const rejected = assert.rejects(result, /authorization_cancelled/);
    const url = await urlPromise;
    if (cancel) controller.abort();
    else assert.equal((await fetch(url)).status, 200);
    await rejected;
    await assert.rejects(fetch(url));
  }
  let ready!: (url: string) => void, release!: () => void;
  const urlPromise = new Promise<string>((resolve) => {
      ready = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const result = loopbackAuthorization(AbortSignal.timeout(5000), LINEAR_ORIGIN, async (a) => {
    ready(
      a.redirect +
        "?" +
        new URLSearchParams({ state: a.state, iss: LINEAR_ORIGIN, code: "one-time" }),
    );
    const code = await a.code;
    await hold;
    return code;
  });
  const url = await urlPromise;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url)).status, 400);
  release();
  assert.equal(await result, "one-time");
});

test("remote transport cancellation interrupts a pending DNS lookup without a network call", async () => {
  const controller = new AbortController();
  let called = false;
  const request = remoteFetch(linearEndpointAllowed, controller.signal, {
    lookup: async () => new Promise(() => {}),
    transport: async () => {
      called = true;
      return json({});
    },
  })(LINEAR_ENDPOINT, { method: "POST" });
  const rejected = assert.rejects(request, /request_cancelled/);
  controller.abort();
  await rejected;
  assert.equal(called, false);
});
