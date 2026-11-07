/** /api/remote/* grants phones full remote access: it must refuse DNS-rebinding and cross-site callers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { RelayBroker } from "./broker.js";
import { identity, LinkCipher } from "./protocol.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-remote-owner-"));
process.env.LISA_HOME = home;
process.env.CLAUDE_HOME = path.join(home, "claude");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
for (const k of [
  "LISA_EDITION",
  "LISA_WEB_TOKEN",
  "LISA_MANAGED_SESSION",
  "LISA_FIRESTORE",
  "K_SERVICE",
  "LISA_MODEL_FALLBACK",
])
  delete process.env[k];
const { startWebServer } = await import("../web/server.js");

function raw(
  port: number,
  method: string,
  route: string,
  headers: Record<string, string>,
  body?: object,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: route, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(text);
        } catch {
          /* empty body */
        }
        resolve({ status: res.statusCode!, json });
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test(
  "a DNS-rebinding page cannot point the Mac at its own relay and approve its own phone",
  { timeout: 30_000 },
  async () => {
    // The attacker's "cloud": accepts any session and runs a relay it controls.
    const evil = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/api/auth/me" ? { signedIn: true, uid: "mallory" } : {}));
    });
    await new Promise<void>((r) => evil.listen(0, "127.0.0.1", r));
    const evilBase = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;
    const broker = new RelayBroker(evil, async () => ({
      uid: "mallory",
      expiresAt: Date.now() + 60_000,
    }));
    const mac = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      tools: [],
      model: "gemini-2.5-flash",
      thinking: false,
      reflect: false,
      idleMinutes: 0,
      hooks: [],
    });
    const port = (mac.address() as AddressInfo).port;
    const json = { "content-type": "application/json" };
    // Same-origin to the browser after rebinding, so JSON POSTs need no preflight.
    const rebound = {
      ...json,
      host: `rebind.attacker.example:${port}`,
      origin: `http://rebind.attacker.example:${port}`,
      "sec-fetch-site": "same-origin",
    };
    const crossSite = {
      ...json,
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    };
    const sockets: WebSocket[] = [];
    try {
      for (const headers of [rebound, crossSite]) {
        assert.equal((await raw(port, "GET", "/api/remote/status", headers)).status, 403);
        const connect = await raw(port, "POST", "/api/remote/connect", headers, {
          base: evilBase,
          session: "mallory",
        });
        assert.equal(connect.status, 403);
        assert.equal(
          connect.json.error,
          headers === rebound ? "untrusted_host" : "cross_site_request",
        );
        assert.equal(
          (await raw(port, "POST", "/api/remote/approve", headers, { id: "x", code: "y" })).status,
          403,
        );
        // ...nor relax the Mac's pairing policy to let a v1 (grindable) pairing through.
        assert.equal(
          (
            await raw(port, "POST", "/api/remote/policy", headers, {
              requireSecurePairing: false,
            })
          ).status,
          403,
        );
      }
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(
        broker.list("mallory"),
        [],
        "the Mac never registered at the attacker relay",
      );

      // The Mac app's own call (loopback Host, no Origin) still works end to end, so the
      // rest of the chain is real: an approved key would get full remote-device access.
      const owner = { ...json, host: `127.0.0.1:${port}` };
      assert.equal(
        (await raw(port, "POST", "/api/remote/connect", owner, { base: evilBase, session: "m" }))
          .status,
        200,
      );
      const [host] = await (async () => {
        for (let i = 0; i < 100; i++) {
          const list = broker.list("mallory");
          if (list.length) return list;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("Mac did not register");
      })();
      const phone = identity();
      const ws = new WebSocket(
        `${evilBase.replace("http:", "ws:")}/api/relay/client?host=${host!.id}`,
        {
          headers: { authorization: "Bearer m" },
        },
      );
      sockets.push(ws);
      ws.on("error", () => {});
      await once(ws, "open");
      const salt = crypto.randomBytes(32).toString("base64");
      const cipher = new LinkCipher(phone, host!.publicKey, salt, "client");
      const welcome = once(ws, "message");
      ws.send(
        JSON.stringify({ type: "hello", publicKey: phone.publicKey, salt, name: "x", pair: true }),
      );
      assert.equal(cipher.open(JSON.parse(String((await welcome)[0]))).authorized, false);
      const pending = (await raw(port, "GET", "/api/remote/status", owner)).json.pending as Array<{
        id: string;
        code: string;
      }>;
      assert.equal(pending.length, 1);
      // ...but only the real owner context can approve it; the rebinding page is refused.
      assert.equal(
        (await raw(port, "POST", "/api/remote/approve", rebound, pending[0])).status,
        403,
      );
      assert.equal(
        ((await raw(port, "GET", "/api/remote/status", owner)).json.devices as []).length,
        0,
      );
      // The owner can require secure (v2) pairing; that withdraws this v1 request.
      const policy = await raw(port, "POST", "/api/remote/policy", owner, {
        requireSecurePairing: true,
      });
      assert.equal(policy.status, 200);
      assert.equal(policy.json.requireSecurePairing, true);
      assert.deepEqual(policy.json.pending, []);
      assert.equal(
        (await raw(port, "POST", "/api/remote/policy", owner, { requireSecurePairing: 1 })).status,
        409,
      );
    } finally {
      for (const ws of sockets) ws.terminate();
      broker.close();
      await new Promise<void>((r) => mac.close(() => r()));
      evil.closeAllConnections();
      await new Promise<void>((r) => evil.close(() => r()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
