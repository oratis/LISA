/**
 * Revoking a device token closes what that device still has open. The token is
 * checked when a request starts, so without this an /events subscription (or a
 * PTY attach) opened before the revoke kept streaming after it (#480).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-device-revoke-"));
process.env.LISA_HOME = TMP;
process.env.CLAUDE_HOME = path.join(TMP, "claude");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
process.env.LISA_LOG_FORMAT = "text";
process.env.LISA_WEB_TOKEN = "device-revoke-test-token";
for (const k of [
  "LISA_EDITION",
  "LISA_PUBLIC_ORIGIN",
  "LISA_LOG_FILE",
  "K_SERVICE",
  "LISA_MODEL_FALLBACK",
  "LISA_MANAGED_SESSION",
  "LISA_BASE_URL",
  "LISA_PROVIDER",
]) {
  delete process.env[k];
}

const { startWebServer } = await import("./server.js");
const { mintDevice } = await import("./devices.js");

let server: http.Server;
let port = 0;

before(async () => {
  server = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    tools: [],
    model: "claude-sonnet-4-6",
    thinking: false,
    reflect: false,
    idleMinutes: 0,
    hooks: [],
  });
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** A phone on the LAN: it names this Mac by another host, so the token gate applies. */
const phone = (token: string) => ({ host: "lisa-mac.local", authorization: `Bearer ${token}` });

/** Open /events as `token`; resolves once the first event arrived. */
function subscribe(token: string): Promise<{ ended: Promise<number>; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/events", headers: phone(token), agent: false },
      (res) => {
        assert.equal(res.statusCode, 200);
        const ended = new Promise<number>((done) => {
          const finish = () => done(Date.now());
          res.once("end", finish);
          res.once("aborted", finish);
          res.once("close", finish);
          res.once("error", finish);
        });
        res.once("data", () => resolve({ ended, res }));
        res.on("data", () => {});
      },
    );
    req.on("error", reject);
  });
}

function send(method: string, route: string, headers: Record<string, string>, body?: string) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers:
          body === undefined
            ? headers
            : { ...headers, "content-length": String(Buffer.byteLength(body)) },
        agent: false,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("revoking a device closes its open /events within a second, and only its own", async () => {
  const lost = mintDevice("Lost iPhone", "ios");
  const kept = mintDevice("iPad", "ios");
  const lostEvents = await subscribe(lost.token);
  const keptEvents = await subscribe(kept.token);
  let keptEnded = false;
  void keptEvents.ended.then(() => (keptEnded = true));

  const revokedAt = Date.now();
  const status = await send(
    "POST",
    "/api/devices/revoke",
    { host: `127.0.0.1:${port}`, "content-type": "application/json" },
    JSON.stringify({ id: lost.id }),
  );
  assert.equal(status, 200);
  const endedAt = await Promise.race([
    lostEvents.ended,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("/events still open 1 s after the revoke")), 1000),
    ),
  ]);
  assert.ok(endedAt - revokedAt < 1000);
  // The revoked token is refused from now on (403 untrusted_host here, as this test
  // reaches the Mac over loopback; a phone on the LAN gets 401). The other device
  // keeps its stream.
  assert.equal(await send("GET", "/api/soul", phone(lost.token)), 403);
  assert.equal(await send("GET", "/api/soul", phone(kept.token)), 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(keptEnded, false, "another device's stream must stay open");
  keptEvents.res.destroy();
});
