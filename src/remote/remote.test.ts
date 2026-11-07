/** Real Mac HTTP routes + WebSockets, isolated homes, no model/account/network calls. */
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
import {
  identity,
  keyId,
  LinkCipher,
  pairingCode,
  pairingCommitment,
  pairingNonce,
  type LinkIdentity,
  type HostInfo,
} from "./protocol.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-remote-"));
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

async function eventually<T>(read: () => T | Promise<T>, check: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timed out");
}
function inbox(ws: WebSocket) {
  const queue: string[] = [];
  let waiter: { resolve: (text: string) => void; reject: (error: Error) => void } | undefined;
  let closed = false;
  ws.on("message", (data) => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w.resolve(data.toString());
    } else queue.push(data.toString());
  });
  ws.on("close", () => {
    closed = true;
    waiter?.reject(new Error("closed"));
    waiter = undefined;
  });
  ws.on("error", () => {});
  return () =>
    new Promise<string>((resolve, reject) => {
      const value = queue.shift();
      if (value !== undefined) resolve(value);
      else if (closed) reject(new Error("closed"));
      else waiter = { resolve, reject };
    });
}

test(
  "same-account discovery, explicit pairing, encrypted cloud/LAN traffic, streaming, replay protection and revocation",
  { timeout: 30_000 },
  async () => {
    const cloud = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/me" && req.headers.authorization === "Bearer alice") {
        res.end(JSON.stringify({ signedIn: true, uid: "alice" }));
        return;
      }
      res.writeHead(401);
      res.end("{}");
    });
    await new Promise<void>((r) => cloud.listen(0, "127.0.0.1", r));
    const cloudBase = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
    const allowed = new Set(["alice", "bob"]);
    const broker = new RelayBroker(cloud, async (token) =>
      allowed.has(token) ? { uid: token, expiresAt: Date.now() + 60_000 } : null,
    );
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
    const macBase = `http://127.0.0.1:${(mac.address() as AddressInfo).port}`;
    const sockets: WebSocket[] = [];
    const local = async (route: string, payload?: object) => {
      const res = await fetch(
        `${macBase}/api/remote/${route}`,
        payload
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            }
          : undefined,
      );
      return {
        status: res.status,
        body: (await res.json()) as {
          pending: Array<{ id: string; code: string; secure: boolean; waiting: boolean }>;
          devices: Array<{ id: string; secure: boolean }>;
          activeConnections: number;
          enabled: boolean;
        },
      };
    };
    const phone = identity();
    let host: HostInfo;
    async function connect(
      options: {
        key?: LinkIdentity;
        token?: string;
        lan?: string;
        salt?: string;
        pair?: boolean;
        extra?: Record<string, unknown>;
      } = {},
    ) {
      const key = options.key ?? phone;
      const salt = options.salt ?? crypto.randomBytes(32).toString("base64");
      const ws = new WebSocket(
        options.lan ?? `${cloudBase.replace("http:", "ws:")}/api/relay/client?host=${host.id}`,
        {
          headers: { authorization: `Bearer ${options.token ?? "alice"}` },
          handshakeTimeout: 2000,
        },
      );
      sockets.push(ws);
      const receive = inbox(ws);
      await once(ws, "open");
      const cipher = new LinkCipher(key, host.publicKey, salt, "client");
      ws.send(
        JSON.stringify({
          type: "hello",
          publicKey: key.publicKey,
          salt,
          name: "Test iPhone",
          pair: options.pair ?? true,
          ...options.extra,
        }),
      );
      const welcome = cipher.open(JSON.parse(await receive()));
      return { ws, cipher, welcome, receive, salt };
    }
    async function request(
      connection: Awaited<ReturnType<typeof connect>>,
      route: string,
      method = "GET",
      body?: object,
    ) {
      connection.ws.send(
        JSON.stringify(
          connection.cipher.seal({
            type: "request",
            id: crypto.randomUUID(),
            challenge: connection.welcome.challenge,
            expiresAt: Date.now() + 60_000,
            path: route,
            method,
            body: body ? Buffer.from(JSON.stringify(body)).toString("base64") : "",
          }),
        ),
      );
      const chunks: Buffer[] = [];
      let status = 0;
      while (true) {
        const frame = connection.cipher.open(JSON.parse(await connection.receive()));
        if (frame.type === "headers") status = frame.status as number;
        if (frame.type === "chunk") chunks.push(Buffer.from(frame.body as string, "base64"));
        if (frame.type === "end") return { status, body: Buffer.concat(chunks).toString() };
      }
    }
    try {
      assert.equal((await local("connect", { base: cloudBase, session: "alice" })).status, 200);
      host = (
        await eventually(
          () => broker.list("alice"),
          (list) => list.length === 1,
        )
      )[0]!;
      assert.deepEqual(broker.list("bob"), []);
      await assert.rejects(connect({ token: "bob" }), /closed/);
      await assert.rejects(connect({ token: "unknown" }));
      const pending = await connect();
      assert.equal(pending.welcome.authorized, false);
      assert.deepEqual(pending.welcome.lanURLs, []);
      assert.equal(
        (await local("approve", { id: keyId(phone.publicKey), code: "WRONG" })).status,
        409,
      );
      assert.equal(
        (await local("approve", { id: keyId(phone.publicKey), code: pending.welcome.code })).status,
        200,
      );
      pending.ws.close();
      const connected = await connect();
      assert.equal(connected.welcome.authorized, true);
      const edition = await request(connected, "/api/edition");
      assert.equal(edition.status, 200);
      assert.equal(JSON.parse(edition.body).edition, "mac");

      // Pairing v2 through the real broker and Mac routes: the code exists only after the
      // phone opens its commitment, and the owner approves exactly that code.
      const secure = identity();
      const nonce = pairingNonce();
      const committed = await connect({
        key: secure,
        extra: { v: 2, commit: pairingCommitment(host.publicKey, secure.publicKey, nonce) },
      });
      assert.equal(committed.welcome.code, undefined);
      assert.deepEqual(
        (await local("status")).body.pending.map((p) => [p.code, p.waiting]),
        [["", true]],
      );
      committed.ws.send(JSON.stringify(committed.cipher.seal({ type: "pair", nonce })));
      const paired = committed.cipher.open(JSON.parse(await committed.receive()));
      const code = pairingCode(
        host.publicKey,
        secure.publicKey,
        nonce,
        committed.welcome.nonce as string,
      );
      assert.equal(paired.code, code);
      const listed = (await local("status")).body.pending;
      assert.deepEqual(
        listed.map((p) => [p.id, p.code, p.secure]),
        [[keyId(secure.publicKey), code, true]],
      );
      assert.equal((await local("approve", { id: listed[0]!.id, code })).status, 200);
      const v2Link = await connect({ key: secure, pair: false, extra: { v: 2 } });
      assert.equal(v2Link.welcome.authorized, true);
      assert.deepEqual(await request(v2Link, "/api/edition"), edition);
      assert.deepEqual(
        (await local("status")).body.devices.map((d) => d.secure),
        [false, true],
      );

      // The reverse hop is REMOTE despite its loopback socket: owner actions stay forbidden.
      assert.equal((await request(await connect(), "/api/pair/start", "POST", {})).status, 403);
      assert.equal(
        (await request(await connect(), "/api/control/policy", "POST", { remoteControl: false }))
          .status,
        403,
      );
      // Owner-only surfaces added since (memory sovereignty, Warden/task approvals,
      // read-only connectors, dreams, transcripts) must classify the hop as remote too.
      for (const [route, method, body] of [
        ["/api/memory/forget", "POST", { query: "anything" }],
        ["/api/memory/entries/x", "DELETE", undefined],
        ["/api/export", "GET", undefined],
        ["/api/approvals/x/approve", "POST", {}],
        ["/api/warden/rules", "PUT", { rules: [] }],
        ["/api/connectors", "GET", undefined],
        ["/api/connectors/github", "GET", undefined],
        ["/api/reve/dreams/x/revert", "POST", {}],
        ["/api/agents/transcript?id=x", "GET", undefined],
      ] as const) {
        const reply = await request(await connect(), route, method, body);
        assert.equal(reply.status, 403, `${method} ${route} must refuse a relayed device`);
        // ...while the same read from the local owner is served (the 403 is the classification).
        if (method === "GET" && route !== "/api/agents/transcript?id=x")
          assert.notEqual((await fetch(`${macBase}${route}`)).status, 403, route);
      }
      // Connection management never crosses the tunnel, however the path is spelled.
      for (const route of ["/api/remote/status", "/api/relay/macs", "/api/%72emote/status"]) {
        const tunnel = await connect();
        tunnel.ws.send(
          JSON.stringify(
            tunnel.cipher.seal({
              type: "request",
              id: crypto.randomUUID(),
              challenge: tunnel.welcome.challenge,
              expiresAt: Date.now() + 60_000,
              path: route,
              method: "GET",
            }),
          ),
        );
        const first = await tunnel.receive().then(
          (frame) => tunnel.cipher.open(JSON.parse(frame)),
          () => null,
        );
        assert.ok(first === null || (first.type === "headers" && first.status !== 200), route);
      }
      const forged = await fetch(`${macBase}/api/pair/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lisa-link": "forged",
          "x-lisa-link-device": keyId(phone.publicKey),
        },
        body: "{}",
      });
      assert.equal(forged.status, 401);

      const advertised = (connected.welcome.lanURLs as string[])[0];
      assert.ok(advertised, "test host needs a network interface for real LAN verification");
      assert.match(advertised, /^ws:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d+\/link$/);
      // Dial the same 0.0.0.0 listener over loopback: host firewalls (macOS
      // stealth mode, CI sandboxes) often drop a socket to the machine's own LAN IP.
      const lanURL = advertised.replace(/^ws:\/\/[^:/]+:/, "ws://127.0.0.1:");
      const direct = await connect({ lan: lanURL });
      assert.deepEqual(await request(direct, "/api/edition"), edition);
      const pendingCount = (await local("status")).body.pending.length;
      await assert.rejects(connect({ lan: lanURL, key: identity() }), /closed/);
      assert.equal((await local("status")).body.pending.length, pendingCount);

      // Interrupt the uplink without revoking the account: same key/grant reconnects automatically.
      broker.revokeAccount("alice");
      await eventually(
        () => broker.list("alice"),
        (list) => list.length === 0,
      );
      await eventually(
        () => broker.list("alice"),
        (list) => list.length === 1,
      );
      assert.deepEqual(await request(await connect({ pair: false }), "/api/edition"), edition);

      // A captured hello and request cannot replay across connections: server challenges differ.
      const original = await connect();
      const captured = original.cipher.seal({
        type: "request",
        id: crypto.randomUUID(),
        challenge: original.welcome.challenge,
        expiresAt: Date.now() + 60_000,
        path: "/api/edition",
        method: "GET",
      });
      original.ws.close();
      const replay = await connect({ salt: original.salt });
      assert.notEqual(replay.welcome.challenge, original.welcome.challenge);
      replay.ws.send(JSON.stringify(captured));
      await assert.rejects(replay.receive(), /closed/);

      const stream = await connect();
      stream.ws.send(
        JSON.stringify(
          stream.cipher.seal({
            type: "request",
            id: crypto.randomUUID(),
            challenge: stream.welcome.challenge,
            expiresAt: Date.now() + 60_000,
            path: "/events",
            method: "GET",
          }),
        ),
      );
      assert.equal(stream.cipher.open(JSON.parse(await stream.receive())).status, 200);
      const event = stream.cipher.open(JSON.parse(await stream.receive()));
      assert.equal(event.type, "chunk");
      assert.match(Buffer.from(event.body as string, "base64").toString(), /data:|:/);
      assert.equal((await local("revoke", { id: keyId(phone.publicKey) })).status, 200);
      await eventually(
        () => stream.ws.readyState,
        (state) => state === WebSocket.CLOSED,
      );
      await eventually(
        async () => (await local("status")).body.activeConnections,
        (n) => n === 0,
      );
      await assert.rejects(connect({ lan: lanURL }), /closed/);
      const again = await connect({ pair: false });
      assert.equal(again.welcome.authorized, false);
      assert.equal(
        (await local("status")).body.pending.length,
        0,
        "background reconnects cannot re-prompt after revocation",
      );
      again.ws.close();

      assert.equal((await local("disconnect", {})).status, 200);
      await eventually(
        () => broker.list("alice"),
        (list) => list.length === 0,
      );
      assert.equal((await local("status")).body.enabled, false);
    } finally {
      for (const ws of sockets) ws.terminate();
      broker.close();
      await new Promise<void>((r) => mac.close(() => r()));
      cloud.closeAllConnections();
      await new Promise<void>((r) => cloud.close(() => r()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
