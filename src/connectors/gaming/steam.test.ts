import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Http } from "../workspace/http.js";
import { ConnectorError, type CredentialAccess } from "../types.js";
import { SteamDriver } from "./steam.js";

const key = "a".repeat(32);
const subject = "76561198000000001";
const account = { id: subject, name: "Steam " + subject };
const grant = JSON.stringify({
  provider: "steam",
  subject,
  deployment: createHash("sha256").update(key).digest("hex"),
});
const creds: CredentialAccess = { use: (work) => work(grant, async () => {}) };
const signal = () => AbortSignal.timeout(5000);
const selected = [{ id: "42", name: "Game" }];
const response = {
  response: { game_count: 1, games: [{ appid: 42, name: "Game", playtime_forever: 15 }] },
};

function signIn(driver: SteamDriver, customize?: (params: URLSearchParams) => void) {
  return driver.authorize("login", signal(), ({ authorizationUrl }) => {
    const login = new URL(authorizationUrl);
    assert(driver.validAuthorizationUrl(authorizationUrl));
    assert.equal(login.searchParams.get("openid.mode"), "checkid_setup");
    const dest = new URL(login.searchParams.get("openid.return_to")!);
    assert.equal(dest.pathname, "/oauth/steam");
    assert.equal(login.searchParams.get("openid.realm"), dest.origin + "/");
    const values = {
      ns: "http://specs.openid.net/auth/2.0",
      mode: "id_res",
      op_endpoint: "https://steamcommunity.com/openid/login",
      identity: "https://steamcommunity.com/openid/id/" + subject,
      claimed_id: "https://steamcommunity.com/openid/id/" + subject,
      return_to: dest.href,
      response_nonce: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") + "nonce",
      assoc_handle: "handle",
      signed: "op_endpoint,return_to,response_nonce,assoc_handle,claimed_id,identity",
      sig: "provider-signature",
    };
    for (const [name, value] of Object.entries(values))
      dest.searchParams.set("openid." + name, value);
    customize?.(dest.searchParams);
    void fetch(dest).then((r) => r.text());
  });
}

test("Steam verifies the single-use return with Valve and binds the SteamID to the operator key", async () => {
  const driver = new SteamDriver(async (url, init, _signal, text) => {
    assert.equal(url.href, "https://steamcommunity.com/openid/login");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("x-webapi-key"), null);
    assert.equal(text, true);
    const params = new URLSearchParams(String(init.body));
    assert.equal(params.get("openid.mode"), "check_authentication");
    assert.equal(params.get("openid.identity"), "https://steamcommunity.com/openid/id/" + subject);
    return "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n";
  }, key);
  const auth = await signIn(driver);
  assert.deepEqual(auth.account, account);
  assert.deepEqual(JSON.parse(auth.token), JSON.parse(grant));
  assert(!auth.token.includes(key));
  await assert.rejects(
    new SteamDriver(async () => assert.fail(), "b".repeat(32)).account(creds, signal()),
    /workspace_reauthorize/,
  );
});

test("Steam declines stale, unsigned or mismatched account assertions and an unverified signature", async () => {
  const driver = new SteamDriver(async () => assert.fail(), key);
  for (const change of [
    (p: URLSearchParams) => p.set("openid.response_nonce", "2000-01-01T00:00:00Zold"),
    (p: URLSearchParams) => p.set("openid.signed", "response_nonce,assoc_handle"),
    (p: URLSearchParams) => p.set("openid.return_to", "other"),
    (p: URLSearchParams) =>
      p.set("openid.identity", "https://steamcommunity.com/openid/id/76561198000000002"),
  ])
    await assert.rejects(signIn(driver, change), /workspace_reauthorize/);
  await assert.rejects(
    signIn(new SteamDriver(async () => "is_valid:false\n", key)),
    /workspace_reauthorize/,
  );
  await assert.rejects(
    signIn(driver, (p) => p.set("openid.mode", "cancel")),
    /authorization_cancelled/,
  );
});

test("Steam uses confirmed AppIDs for filtered reads and omits unrelated games and fields", async () => {
  const api: Http = async (url, init) => {
    assert.equal(url.origin, "https://api.steampowered.com");
    assert(!url.href.includes(key));
    assert.equal(new Headers(init.headers).get("x-webapi-key"), key);
    const query = JSON.parse(url.searchParams.get("input_json")!);
    assert.deepEqual(query, {
      steamid: subject,
      include_appinfo: true,
      include_played_free_games: true,
      appids_filter: [42],
    });
    return {
      response: {
        games: [
          { appid: 43, name: "Other" },
          { appid: 42, name: "New title", internal: "private" },
        ],
      },
    };
  };
  const driver = new SteamDriver(api, key);
  assert.deepEqual(
    await driver.read(creds, account, selected, { operation: "read", resourceId: "42" }, signal()),
    {
      untrusted: true,
      source: "Steam",
      includesPlayedFreeGames: true,
      games: [{ id: "42", name: "New title", playtimeMinutes: null }],
      unavailableCount: 0,
    },
  );
  await assert.rejects(
    async () =>
      driver.read(creds, account, selected, { operation: "read", resourceId: "43" }, signal()),
    /resource_not_granted/,
  );
  await assert.rejects(
    driver.read(
      creds,
      { id: "76561198000000002", name: "Other" },
      selected,
      { operation: "list" },
      signal(),
    ),
    /connector_account_changed/,
  );
});

test("Steam distinguishes an explicitly empty library, unavailable library, and absent achievements", async () => {
  assert.deepEqual(
    await new SteamDriver(async () => ({ response: { game_count: 0 } }), key).resources(
      creds,
      1,
      signal(),
    ),
    [],
  );
  await assert.rejects(
    new SteamDriver(async () => ({ response: {} }), key).resources(creds, 1, signal()),
    /game_library_unavailable/,
  );
  const driver = new SteamDriver(async (url) => {
    if (url.pathname === "/IPlayerService/GetOwnedGames/v1/") return response;
    assert.equal(url.searchParams.get("appid"), "42");
    assert.equal(url.searchParams.get("steamid"), subject);
    throw new ConnectorError("game_library_unavailable");
  }, key);
  assert.deepEqual(
    (
      await driver.read(
        creds,
        account,
        selected,
        { operation: "achievements", resourceId: "42" },
        signal(),
      )
    ).achievements,
    { available: false },
  );
  assert.equal(await new SteamDriver(async () => assert.fail(), "").configured(), false);
  await assert.rejects(
    new SteamDriver(async () => assert.fail(), "").authorize("login", signal(), () =>
      assert.fail(),
    ),
    /game_provider_unconfigured/,
  );
});

test("Steam only returns bounded achievement fields for the verified player and selected game", async () => {
  let steamID = subject;
  const driver = new SteamDriver(
    async (url) =>
      url.pathname.startsWith("/IPlayerService")
        ? response
        : {
            playerstats: {
              steamID,
              success: true,
              achievements: Array.from({ length: 101 }, (_, i) => ({
                name: "Achievement " + i,
                achieved: 1,
                unlocktime: 123456,
              })),
            },
          },
    key,
  );
  const input = { operation: "achievements", resourceId: "42" };
  const data = await driver.read(creds, account, selected, input, signal());
  assert.equal(data.achievements?.truncated, true);
  assert.equal(data.achievements?.items?.length, 100);
  assert.deepEqual(data.achievements?.items?.[0], { name: "Achievement 0", unlocked: true });
  steamID = "76561198000000002";
  await assert.rejects(
    driver.read(creds, account, selected, input, signal()),
    /connector_account_changed/,
  );
});

test("Steam confirms all selected AppIDs in one request and rejects missing games", async () => {
  let requests = 0;
  const driver = new SteamDriver(async (url) => {
    requests++;
    const filter = JSON.parse(url.searchParams.get("input_json")!).appids_filter;
    assert.deepEqual(filter, [7, 42]);
    return {
      response: {
        games: (requests === 1 ? [42, 7] : [42]).map((appid) => ({ appid, name: "Game " + appid })),
      },
    };
  }, key);
  assert.deepEqual(await driver.resolveResources(creds, ["7", "42"], signal()), [
    { id: "7", name: "Game 7" },
    { id: "42", name: "Game 42" },
  ]);
  assert.equal(requests, 1);
  await assert.rejects(
    driver.resolveResources(creds, ["7", "42"], signal()),
    /resource_not_granted/,
  );
});
