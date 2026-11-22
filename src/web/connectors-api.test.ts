import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { handleConnectorApi } from "./connectors-api.js";
import { ConnectorError } from "../connectors/types.js";
import type { ConnectorService } from "../connectors/service.js";
import { workspaceIds } from "../connectors/workspace/catalog.js";
import type { ConnectorProvider } from "../connectors/catalog.js";

test("generic connector routes enforce owner/origin, bounded JSON, and scoped provider actions", async (t) => {
  let owner = true,
    actions = 0;
  const fake = {
    summary: async () => ({ status: "disconnected", resourceCount: 0 }),
    list: async () => [],
    authorize: async () => {
      actions++;
    },
    confirm: async () => {
      throw new ConnectorError("invalid_resources");
    },
    resources: async () => [],
  } as unknown as ConnectorService;
  const services = new Map<ConnectorProvider, ConnectorService>([
    ["gmail", fake],
    ["google-calendar", fake],
    ["linear", fake],
    ["google-drive", fake],
    ["notion", fake],
    ["slack", fake],
    ["feishu", fake],
    ["t3", fake],
  ]);
  for (const id of workspaceIds) services.set(id, fake);
  const publicGames = {
    configured: () => ({ igdb: false, itad: false }),
    query: async () => {
      throw new ConnectorError("public_games_not_configured", 503);
    },
  };
  services.set("game-library", fake);
  const server = http.createServer((req, res) => {
    void handleConnectorApi(req, res, req.url!, services, owner, undefined, publicGames).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: string, headers: Record<string, string> = {}, provider = "gmail") =>
    fetch(base + `/api/connectors/${provider}/requests/test/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  const catalog = await fetch(base + "/api/connectors");
  assert.equal(catalog.status, 200);
  assert.equal(
    ((await catalog.json()) as { connectors: unknown[] }).connectors.length,
    13 + workspaceIds.length,
  );
  for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }])
    assert.equal((await post("{}", headers)).status, 403, JSON.stringify(headers));
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    http
      .get(base + "/api/connectors", { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject);
  });
  assert.equal(rebound, 403);
  assert.equal(actions, 0);
  assert.equal((await post("{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await post("{")).status, 400);
  assert.equal((await post(JSON.stringify({ value: "x".repeat(17000) }))).status, 413);
  assert.equal((await post("{}")).status, 200);
  assert.equal(actions, 1);
  assert.equal((await post("{}", { origin: "https://evil.example" }, "linear")).status, 403);
  assert.equal((await post("{}", {}, "linear")).status, 200);
  assert.equal(actions, 2);
  for (const provider of ["google-drive", "notion", "slack", "feishu", "t3", ...workspaceIds]) {
    assert.equal((await post("{}", { origin: "https://evil.example" }, provider)).status, 403);
    assert.equal((await post("{}", {}, provider)).status, 200);
  }
  assert.deepEqual(await (await fetch(base + "/api/games/public")).json(), {
    igdb: false,
    itad: false,
  });
  const lookup = (body: string, headers: Record<string, string> = {}) =>
    fetch(base + "/api/games/public", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });
  assert.equal((await lookup("{}", { origin: "https://example.org" })).status, 403);
  assert.equal((await lookup("{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await lookup("x".repeat(4097))).status, 413);
  assert.equal((await lookup("{}")).status, 503);
  assert.equal((await post('{"mode":"import","games":[]}', {}, "game-library")).status, 409);
  assert.equal(
    (await post('{"mode":"import","games":[{"title":"test"}]}', { origin: "null" }, "game-library"))
      .status,
    403,
  );
  owner = false;
  for (const route of [
    "/api/connectors",
    "/api/games/public",
    "/api/connectors/game-library/requests?sessionId=test",
    "/api/connectors/google-calendar/requests?sessionId=test",
    "/api/connectors/gmail/requests/test/resources",
    "/api/connectors/linear/requests?sessionId=test",
    "/api/connectors/linear/requests/test/resources",
    "/api/connectors/google-drive/requests?sessionId=test",
    "/api/connectors/notion/requests/test/resources",
    "/api/connectors/slack/requests/test/resources",
    "/api/connectors/feishu/requests/test/resources",
    "/api/connectors/t3/requests/test/resources",
  ])
    assert.equal((await fetch(base + route)).status, 403);
  assert.equal((await post("{}")).status, 403);
  assert.equal((await post("{}", {}, "linear")).status, 403);
  assert.equal(actions, 7 + workspaceIds.length);
});

test("the catalog marks sources this install cannot serve, and their routes stay closed", async (t) => {
  const fake = {
    summary: async () => ({ status: "disconnected", resourceCount: 0 }),
    list: async () => [],
  } as unknown as ConnectorService;
  const services = new Map<ConnectorProvider, ConnectorService>([
    ["gmail", fake],
    ["outlook-mail", fake],
  ]);
  const server = http.createServer((req, res) => {
    void handleConnectorApi(req, res, req.url!, services, true, fake).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { connectors } = (await (await fetch(base + "/api/connectors")).json()) as {
    connectors: Array<{ id: string; available: boolean }>;
  };
  const available = new Map(connectors.map((c) => [c.id, c.available]));
  assert.equal(available.get("github"), true);
  assert.equal(available.get("gmail"), true);
  assert.equal(available.get("outlook-mail"), true);
  assert.equal(available.get("figma"), false);
  assert.equal(available.get("apple-calendar"), false);
  const figma = await fetch(base + "/api/connectors/figma/requests/test/authorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(figma.status, 404);
});
