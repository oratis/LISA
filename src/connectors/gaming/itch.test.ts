import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ItchDriver } from "./itch.js";
import type { Http } from "../workspace/http.js";
import type { CredentialAccess } from "../types.js";

const client = "test-app",
  token = "test-token-original",
  account = { id: "12", name: "Player" };
const scopes = ["profile:me", "profile:owned"];
const signal = () => AbortSignal.timeout(5000);
const credentials: CredentialAccess = {
  use: (work) =>
    work(
      JSON.stringify({ provider: "itch", subject: "12", access: token, clientId: client }),
      async () => {},
    ),
};
const entry = (id: number) => ({
  id: id + 123000,
  game_id: id,
  purchase_id: 130,
  key: "private-download-secret",
  game: { id, title: "Game " + id, classification: "game" },
});
function using(extra: Http, info: object = { type: "key", scopes }) {
  return new ItchDriver(async (url, init, signal, text) => {
    assert.equal(url.origin, "https://api.itch.io");
    if (url.pathname === "/credentials/info") {
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + token);
      return info;
    }
    if (url.pathname === "/profile") return { user: { id: 12, username: "Player" } };
    return extra(url, init, signal, text);
  }, client);
}

test("itch desktop authorization binds its scope, code exchange and revocation to the registered client", async () => {
  let login!: URL;
  const called: string[] = [];
  const driver = using(async (url, init) => {
    const body = new URLSearchParams(String(init.body));
    called.push(url.pathname);
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), null);
    assert.equal(body.get("client_id"), client);
    if (url.pathname === "/oauth/revoke") {
      assert.equal(body.get("token"), token);
      return {};
    }
    assert.equal(url.pathname, "/oauth/token");
    assert.equal(body.get("code"), "approved");
    assert.equal(body.get("redirect_uri"), login.searchParams.get("redirect_uri"));
    assert.equal(
      createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),
      login.searchParams.get("code_challenge"),
    );
    return { access_token: token, token_type: "bearer", scope: scopes.join(" ") };
  });
  const authorization = await driver.authorize("login", signal(), (value) => {
    login = new URL(value.authorizationUrl);
    assert.equal(driver.validAuthorizationUrl(login.href), true);
    assert.equal(login.searchParams.get("scope"), scopes.join(" "));
    const redirect = new URL(login.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "approved");
    redirect.searchParams.set("state", login.searchParams.get("state")!);
    void fetch(redirect).then((response) => response.text());
  });
  assert.deepEqual(authorization.account, account);
  // Disconnect continues to use the issuing client after the operator changes configuration.
  await new ItchDriver((url, init) => {
    if (url.pathname === "/oauth/revoke") {
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("client_id"), client);
      assert.equal(form.get("token"), token);
      called.push(url.pathname);
      return Promise.resolve({});
    }
    throw Error("unexpected");
  }, "replacement").revoke(authorization.token, signal());
  assert.deepEqual(called, ["/oauth/token", "/oauth/revoke"]);
});

test("itch selection reads short and duplicate upstream pages to the first empty page", async () => {
  const visited: number[] = [];
  const driver = using(async (url) => {
    assert.equal(url.pathname, "/profile/owned-keys");
    const page = Number(url.searchParams.get("page"));
    visited.push(page);
    return { owned_keys: page === 1 ? [entry(1), entry(1)] : page === 2 ? [entry(2)] : [] };
  });
  assert.deepEqual(await driver.resources(credentials, 1, signal()), [
    { id: "1", name: "Game 1" },
    { id: "2", name: "Game 2" },
  ]);
  assert.deepEqual(visited, [1, 2, 3]);
});

test("itch filters the selected ids upstream and from every tool result, excluding purchase data", async () => {
  const driver = using(async (url) => {
    assert.equal(url.searchParams.get("game_ids"), "1");
    return { owned_keys: [entry(1), entry(2)] };
  });
  const picked = [{ id: "1", name: "Old title" }];
  assert.deepEqual(
    await driver.read(credentials, account, picked, { operation: "list" }, signal()),
    {
      untrusted: true,
      source: "itch.io",
      record: "claimed_download_key",
      games: [{ id: "1", name: "Game 1" }],
      unavailableCount: 0,
    },
  );
  await assert.rejects(
    async () =>
      driver.read(credentials, account, picked, { operation: "read", resourceId: "2" }, signal()),
    /resource_not_granted/,
  );
  await assert.rejects(
    async () =>
      driver.read(credentials, account, picked, { operation: "list", account: "other" }, signal()),
    /read_operation_required/,
  );
  await assert.rejects(
    driver.read(credentials, { id: "99", name: "Other" }, picked, { operation: "list" }, signal()),
    /connector_account_changed/,
  );
});

test("itch rejects personal or expanded keys and reports an incomplete discovery budget", async () => {
  for (const info of [{ type: "key" }, { type: "key", scopes: [...scopes, "collection:edit"] }]) {
    await assert.rejects(
      using(async () => assert.fail(), info).account(credentials, signal()),
      /workspace_scope_mismatch/,
    );
  }
  let calls = 0;
  await assert.rejects(
    using(async () => {
      calls++;
      return { owned_keys: [entry(1)] };
    }).resources(credentials, 1, signal()),
    /game_library_incomplete/,
  );
  assert.equal(calls, 20);
  assert.equal(await new ItchDriver(async () => assert.fail(), "").configured(), false);
  await assert.rejects(
    new ItchDriver(async () => assert.fail(), "").authorize("login", signal(), () => assert.fail()),
    /game_provider_unconfigured/,
  );
});

test("itch login can be denied or cancelled before token exchange", async () => {
  const driver = using(async () => assert.fail());
  await assert.rejects(
    driver.authorize("login", signal(), ({ authorizationUrl }) => {
      const login = new URL(authorizationUrl);
      const redirect = new URL(login.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", login.searchParams.get("state")!);
      redirect.searchParams.set("error", "access_denied");
      void fetch(redirect).then((r) => r.text());
    }),
    /authorization_cancelled/,
  );
  const controller = new AbortController();
  await assert.rejects(
    driver.authorize("login", controller.signal, () => controller.abort()),
    /authorization_cancelled/,
  );
});

test("itch resolves a 30-game confirmation in one filtered lookup and restores the selected order", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => String(i + 1)).reverse();
  let requests = 0;
  const driver = using(async (url) => {
    requests++;
    assert.equal(url.searchParams.get("game_ids"), ids.join(","));
    return { owned_keys: Array.from({ length: 30 }, (_, i) => entry(i + 1)) };
  });
  const resolved = await driver.resolveResources(credentials, ids, signal());
  assert.deepEqual(
    resolved.map((r) => r.id),
    ids,
  );
  assert.equal(requests, 1);
});
