import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { identity, keyId } from "./protocol.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-relay-cloud-"));
process.env.LISA_HOME = home;
process.env.CLAUDE_HOME = path.join(home, "claude");
process.env.LISA_EDITION = "cloud";
process.env.LISA_RELAY_ENABLED = "1";
process.env.LISA_WEB_TOKEN = "operator-demo-token";
process.env.LISA_PUBLIC_ORIGIN = "https://cloud.example";
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
for (const name of [
  "LISA_REVIEWER_SEED",
  "LISA_FIRESTORE",
  "LISA_FIRESTORE_PROJECT",
  "LISA_MANAGED_SESSION",
  "LISA_MODEL_FALLBACK",
])
  delete process.env[name];
const { startWebServer } = await import("../web/server.js");
const { createEmailAccount } = await import("../web/accounts.js");
const { mintSession, loadOrCreateSessionSecret } = await import("../web/sessions-auth.js");

test(
  "real cloud account auth gates discovery/upgrades and account deletion closes relay sockets",
  { timeout: 20_000 },
  async () => {
    const server = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      tools: [],
      model: "gemini-2.5-flash",
      thinking: false,
      reflect: false,
      idleMinutes: 0,
      hooks: [],
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const alice = await createEmailAccount("relay-alice@example.com", "test-password");
    const bob = await createEmailAccount("relay-bob@example.com", "test-password");
    const secret = loadOrCreateSessionSecret();
    const token = mintSession(alice.uid, secret, { sv: alice.sessionVersion });
    const bobToken = mintSession(bob.uid, secret, { sv: bob.sessionVersion });
    const headers = { authorization: `Bearer ${token}` };
    const sockets: WebSocket[] = [];
    try {
      assert.equal((await fetch(`${base}/api/relay/macs`)).status, 401);
      assert.equal(
        (
          await fetch(`${base}/api/relay/macs`, {
            headers: { authorization: "Bearer operator-demo-token" },
          })
        ).status,
        403,
      );
      const host = new WebSocket(base.replace("http:", "ws:") + "/api/relay/host", { headers });
      sockets.push(host);
      host.on("error", () => {});
      await once(host, "open");
      const key = identity();
      const registered = once(host, "message");
      host.send(JSON.stringify({ type: "register", publicKey: key.publicKey, name: "Alice Mac" }));
      assert.equal(JSON.parse(String((await registered)[0])).id, keyId(key.publicKey));
      const own = await fetch(`${base}/api/relay/macs`, { headers });
      assert.equal(own.status, 200);
      assert.equal(((await own.json()) as { hosts: unknown[] }).hosts.length, 1);
      const other = await fetch(`${base}/api/relay/macs`, {
        headers: { authorization: `Bearer ${bobToken}` },
      });
      assert.deepEqual(await other.json(), { hosts: [] });
      for (const invalid of [
        "operator-demo-token",
        mintSession(alice.uid, secret, { ttlMs: -1 }),
        mintSession(alice.uid, secret, { sv: 999 }),
      ]) {
        const denied = new WebSocket(base.replace("http:", "ws:") + "/api/relay/host", {
          headers: { authorization: `Bearer ${invalid}` },
        });
        sockets.push(denied);
        denied.on("error", () => {});
        await assert.rejects(once(denied, "open"), /403/);
      }
      const closed = once(host, "close");
      assert.equal((await fetch(`${base}/api/account`, { method: "DELETE", headers })).status, 200);
      await closed;
      assert.equal((await fetch(`${base}/api/relay/macs`, { headers })).status, 401);
    } finally {
      for (const ws of sockets) ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
