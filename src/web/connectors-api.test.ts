import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { handleConnectorApi } from "./connectors-api.js";
import { ConnectorError } from "../connectors/types.js";
import type { ConnectorService } from "../connectors/service.js";
import type { ConnectorProvider } from "../connectors/catalog.js";

test("generic connector routes enforce owner/origin, bounded JSON, and scoped provider actions", async (t) => {
  let owner = true,
    actions = 0;
  const fake = {
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
  ]);
  const server = http.createServer((req, res) => {
    void handleConnectorApi(req, res, req.url!, services, owner).then((handled) => {
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
  const post = (body: string, headers: Record<string, string> = {}, provider = "gmail") =>
    fetch(base + `/api/connectors/${provider}/requests/test/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  const catalog = await fetch(base + "/api/connectors");
  assert.equal(catalog.status, 200);
  assert.equal(((await catalog.json()) as { connectors: unknown[] }).connectors.length, 4);
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
  owner = false;
  for (const route of [
    "/api/connectors",
    "/api/connectors/google-calendar/requests?sessionId=test",
    "/api/connectors/gmail/requests/test/resources",
    "/api/connectors/linear/requests?sessionId=test",
    "/api/connectors/linear/requests/test/resources",
  ])
    assert.equal((await fetch(base + route)).status, 403);
  assert.equal((await post("{}")).status, 403);
  assert.equal((await post("{}", {}, "linear")).status, 403);
  assert.equal(actions, 2);
});
