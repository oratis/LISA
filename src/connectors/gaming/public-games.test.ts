import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicGames } from "./public-games.js";
import { ConnectorError } from "../types.js";

const env = {
  LISA_IGDB_CLIENT_ID: "app",
  LISA_IGDB_CLIENT_SECRET: "private",
  LISA_ITAD_API_KEY: "api-key",
};
const signal = () => AbortSignal.timeout(5000);
const id = "018d937f-012f-73b8-ab2c-898516969e6a",
  edition = "018d937f-07fc-72ed-8517-d8e24cb1eb22";
const search = { provider: "itad", action: "search", title: "One & Two" };
const prices = { provider: "itad", action: "details", id, country: "CN" };
const token = { token_type: "bearer", access_token: "app-token", expires_in: 6400 };
const metadata = {
  id: 42,
  name: "One",
  url: "https://www.igdb.com/games/one",
  platforms: [{ name: "PC" }],
  version_title: "Gold",
  first_release_date: 1577836800,
};
const time = "2025-12-11T01:47:46+01:00";
const fixtures = {
  money: { amount: 1.97, currency: "CNY", amountInt: 197 },
  url: "https://isthereanydeal.com/link/sale/?affiliate=keep%20original",
};
function capture(answer: (url: URL, init: RequestInit) => unknown) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const data = answer(url, init);
    return data instanceof Response ? data : Response.json(data);
  };
  return { calls, fetcher };
}
const error = (code: string) => (err: unknown) =>
  err instanceof ConnectorError && err.code === code;

test("public status and invalid/extra fields never send requests", async () => {
  const { calls, fetcher } = capture(() => assert.fail("unexpected request"));
  const app = new PublicGames({}, fetcher);
  assert.deepEqual(app.configured(), { igdb: false, itad: false });
  await assert.rejects(app.query(search, signal()), error("public_games_not_configured"));
  for (const input of [
    { ...prices, country: undefined },
    { ...prices, country: "EU" },
    { ...prices, id: "wrong" },
    { ...prices, accountId: "never send" },
    { ...search, library: [] },
    { ...search, title: "title\nexfil" },
    { provider: "igdb", action: "steam", appId: "x" },
    { provider: "itad", action: "details", country: "US", id: "https://test.invalid" },
    { provider: "unknown", action: "search", title: "x" },
    null,
  ]) {
    await assert.rejects(app.query(input, signal()), error("public_games_invalid_input"));
  }
  assert.equal(calls.length, 0);
});

test("IGDB single-flight app grant, version disambiguation, exact id binding and four requests per second", async () => {
  const { calls, fetcher } = capture((url) =>
    url.hostname === "id.twitch.tv"
      ? token
      : [metadata, { ...metadata, id: 43, version_title: "Original" }],
  );
  let now = 100000;
  const app = new PublicGames(env, fetcher, () => now);
  const ig = { provider: "igdb", action: "search", title: 'One "Deluxe"; Two' };
  const [first] = await Promise.all([app.query(ig, signal()), app.query(ig, signal())]);
  assert.ok("games" in first);
  assert.deepEqual(first.games[0], {
    id: "42",
    title: "One",
    url: metadata.url,
    releaseDate: "2020-01-01",
    platforms: ["PC"],
    version: "Gold",
  });
  assert.equal(first.games.length, 2);
  assert.equal(calls.filter((c) => c.url.hostname === "id.twitch.tv").length, 1);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body))), {
    client_id: "app",
    client_secret: "private",
    grant_type: "client_credentials",
  });
  for (const call of calls.slice(1)) {
    assert.equal(call.url.href, "https://api.igdb.com/v4/games");
    assert.match(String(call.init.body), /search "One {2}Deluxe ; Two"; limit 15;/);
    assert.equal(new Headers(call.init.headers).get("Client-ID"), "app");
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer app-token");
    assert.equal(call.init.redirect, "error");
  }
  await app.query(ig, signal());
  await assert.rejects(
    app.query({ provider: "igdb", action: "details", id: "4" }, signal()),
    error("public_games_not_found"),
  );
  await assert.rejects(app.query(ig, signal()), error("public_games_rate_limited"));
  assert.equal(calls.length, 5);
  now += 1000;
  await app.query(ig, signal());
  assert.equal(calls.length, 6);
});

test("Steam App ID narrows a lookup on either catalog without sending a player identity", async () => {
  const result = { id, slug: "one", type: "game", title: "One" };
  const { calls, fetcher } = capture((url) =>
    url.hostname === "id.twitch.tv"
      ? token
      : url.hostname === "api.igdb.com"
        ? [{ game: metadata }]
        : { found: true, game: result },
  );
  const app = new PublicGames(env, fetcher);
  for (const provider of ["igdb", "itad"]) {
    const response = await app.query({ provider, action: "steam", appId: "440" }, signal());
    assert.ok("games" in response && response.games.length === 1);
  }
  assert.equal(calls[1]!.url.pathname, "/v4/external_games");
  assert.match(String(calls[1]!.init.body), /external_game_source.name = "Steam" & uid = "440"/);
  assert.equal(calls[2]!.url.pathname, "/games/lookup/v1");
  assert.equal(calls[2]!.url.search, "?appid=440");
});

test("ITAD search and prices send distinct inputs; quotes retain source links, currency and region", async () => {
  const { calls, fetcher } = capture((url) =>
    url.pathname === "/games/search/v1"
      ? [
          { id, title: "One", slug: "one", type: "game" },
          { id: edition, title: "One", slug: "one-deluxe", type: "package" },
        ]
      : [
          {
            id,
            historyLow: { all: fixtures.money },
            deals: [
              {
                shop: { name: "Shop" },
                price: fixtures.money,
                regular: { amount: 9, currency: "CNY" },
                platforms: [{ name: "Windows" }],
                url: fixtures.url,
                timestamp: time,
                private: "not-to-return",
              },
            ],
          },
        ],
  );
  const app = new PublicGames(env, fetcher);
  const matches = await app.query(search, signal());
  assert.ok("games" in matches && matches.games.length === 2);
  assert.deepEqual(
    [...calls[0]!.url.searchParams],
    [
      ["title", "One & Two"],
      ["results", "15"],
    ],
  );
  const data = await app.query(prices, signal());
  assert.ok("offers" in data);
  assert.deepEqual(data.historicalLow, { amount: 1.97, currency: "CNY" });
  assert.deepEqual(data.offers[0], {
    shop: "Shop",
    price: { amount: 1.97, currency: "CNY" },
    regular: { amount: 9, currency: "CNY" },
    platforms: ["Windows"],
    url: fixtures.url,
    updatedAt: time,
    voucher: undefined,
  });
  assert.equal(data.country, "CN");
  assert.equal(calls[1]!.url.search, "?country=CN&vouchers=false");
  assert.equal(calls[1]!.init.body, JSON.stringify([id]));
  assert.equal(calls[1]!.init.method, "POST");
  for (const { url, init } of calls) {
    assert.equal(url.hostname, "api.isthereanydeal.com");
    assert.equal(new Headers(init.headers).get("ITAD-API-Key"), "api-key");
    assert.ok(!url.href.includes("api-key"));
  }
  await app.query({ ...prices, country: "cn" }, signal());
  assert.equal(calls.length, 2);
  await app.query({ ...prices, country: "US" }, signal());
  assert.equal(calls.length, 3);
});

test("empty results, upstream mismatches and untrusted URLs stay distinguishable", async () => {
  const query = async (raw: unknown) =>
    new PublicGames(env, capture(() => raw).fetcher).query(prices, signal());
  const empty = await query([]);
  assert.ok("offers" in empty && empty.offers.length === 0 && empty.historicalLow === null);
  await assert.rejects(
    query([{ id: edition, historyLow: { all: null }, deals: [] }]),
    error("public_games_invalid_response"),
  );
  const bad = {
    shop: { name: "Store" },
    price: fixtures.money,
    regular: fixtures.money,
    timestamp: time,
    url: "javascript:alert(1)",
  };
  await assert.rejects(
    query([{ id, historyLow: { all: null }, deals: [bad] }]),
    error("public_games_invalid_response"),
  );
});

test("history identifies removed offers, sorts changes and reports truncated lists", async () => {
  const day = (n: number) => "2026-08-" + String(n).padStart(2, "0") + "T12:00:00Z";
  const { calls, fetcher } = capture(() =>
    Array.from({ length: 21 }, (_, i) => ({
      shop: { name: "Store" },
      timestamp: day(i + 1),
      deal: i === 20 ? null : { price: fixtures.money },
    })),
  );
  const app = new PublicGames(env, fetcher);
  const result = await app.query({ ...prices, action: "history" }, signal());
  assert.ok("history" in result);
  assert.equal(result.history.length, 20);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.history[0], { shop: "Store", timestamp: day(21), price: null });
  assert.equal(calls[0]!.url.pathname, "/games/history/v2");
  assert.deepEqual(
    [...calls[0]!.url.searchParams],
    [
      ["id", id],
      ["country", "CN"],
    ],
  );
});

test("upstream cooldown, cancellation, denial, malformed and oversized payloads have fixed error codes", async () => {
  let now = 100000;
  const { calls, fetcher } = capture(
    () =>
      new Response("API key details not for UI", { status: 429, headers: { "Retry-After": "8" } }),
  );
  const app = new PublicGames(env, fetcher, () => now);
  await assert.rejects(app.query(search, signal()), error("public_games_rate_limited"));
  now += 7900;
  await assert.rejects(app.query(search, signal()), error("public_games_rate_limited"));
  assert.equal(calls.length, 1);
  now += 100;
  await assert.rejects(app.query(search, signal()), error("public_games_rate_limited"));
  assert.equal(calls.length, 2);
  await assert.rejects(app.query(search, AbortSignal.abort()), error("request_cancelled"));
  assert.equal(calls.length, 2);
  for (const [res, code] of [
    [new Response("internal error", { status: 403 }), "public_games_access_denied"],
    [new Response("oops"), "public_games_invalid_response"],
    [new Response("x".repeat(515000)), "public_games_invalid_response"],
  ] as const)
    await assert.rejects(
      new PublicGames(env, capture(() => res).fetcher).query(search, signal()),
      error(code),
    );
});
