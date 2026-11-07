/** RemoteHost against a scripted relay and a stub loopback backend (no Mac server boot). */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { RemoteHost } from "./host.js";
import { identity, keyId, LinkCipher, type LinkIdentity } from "./protocol.js";

type Frame = Record<string, unknown>;

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A relay that the test drives directly: it plays both the cloud and the phone side. */
async function harness(backend: http.RequestListener) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-remote-host-"));
  const api = http.createServer(backend);
  const backendPort = await listen(api);
  const cloud = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/auth/me" && req.headers.authorization === "Bearer alice") {
      res.end(JSON.stringify({ signedIn: true, uid: "alice" }));
      return;
    }
    res.writeHead(401);
    res.end("{}");
  });
  const wss = new WebSocketServer({ noServer: true });
  const uplinks: WebSocket[] = [];
  const nextUplink: Array<(ws: WebSocket) => void> = [];
  cloud.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {});
      ws.once("message", (data) => {
        const msg = JSON.parse(data.toString());
        assert.equal(msg.type, "register");
        ws.send(JSON.stringify({ type: "registered", id: keyId(msg.publicKey) }));
        (ws as WebSocket & { hostKey?: string }).hostKey = msg.publicKey;
        uplinks.push(ws);
        nextUplink.shift()?.(ws);
      });
    });
  });
  const cloudPort = await listen(cloud);
  const host = new RemoteHost(home, backendPort);
  const uplink = new Promise<WebSocket>((resolve) => nextUplink.push(resolve));
  await host.connect(`http://127.0.0.1:${cloudPort}`, "alice");
  const ws = await uplink;
  const hostKey = (ws as WebSocket & { hostKey?: string }).hostKey!;
  const frames = new Map<string, Frame[]>();
  const waiters = new Map<string, () => void>();
  const closed = new Set<string>();
  const listenFrames = (socket: WebSocket) =>
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; channel: string; payload?: Frame };
      if (msg.type === "registered") return;
      if (msg.type === "close") closed.add(msg.channel);
      else
        (frames.get(msg.channel) ?? frames.set(msg.channel, []).get(msg.channel)!).push(
          msg.payload!,
        );
      waiters.get(msg.channel)?.();
    });
  listenFrames(ws);
  const phone = identity();
  return {
    home,
    host,
    ws,
    hostKey,
    phone,
    closed,
    async nextFrame(channel: string, timeoutMs = 3000): Promise<Frame | "closed"> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const queue = frames.get(channel) ?? [];
        if (queue.length) return queue.shift()!;
        if (closed.has(channel) || ws.readyState !== WebSocket.OPEN) return "closed";
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 50);
          waiters.set(channel, () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      throw new Error(`no frame on ${channel}`);
    },
    send(channel: string, payload: unknown, socket = ws) {
      socket.send(JSON.stringify({ type: "frame", channel, payload }));
    },
    async hello(channel: string, key: LinkIdentity = phone, pair = true) {
      const salt = crypto.randomBytes(32).toString("base64");
      const cipher = new LinkCipher(key, hostKey, salt, "client");
      this.send(channel, { type: "hello", publicKey: key.publicKey, salt, name: "Test", pair });
      const first = await this.nextFrame(channel);
      assert.notEqual(first, "closed");
      return { cipher, welcome: cipher.open(first as never) };
    },
    async close() {
      host.stop();
      for (const s of uplinks) s.terminate();
      wss.close();
      api.closeAllConnections();
      cloud.closeAllConnections();
      await new Promise<void>((r) => api.close(() => r()));
      await new Promise<void>((r) => cloud.close(() => r()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function request(
  cipher: LinkCipher,
  challenge: unknown,
  route: string,
  method = "GET",
  expiresAt = Date.now() + 60_000,
) {
  return cipher.seal({
    type: "request",
    id: crypto.randomUUID(),
    challenge,
    expiresAt,
    path: route,
    method,
    body: "",
  });
}

async function readBody(
  h: Awaited<ReturnType<typeof harness>>,
  channel: string,
  cipher: LinkCipher,
): Promise<{ status: number; body: Buffer }> {
  const chunks: Buffer[] = [];
  let status = 0;
  while (true) {
    const frame = await h.nextFrame(channel, 10_000);
    assert.notEqual(frame, "closed", `${channel} closed before the response finished`);
    const msg = cipher.open(frame as never);
    if (msg.type === "headers") status = msg.status as number;
    if (msg.type === "chunk") chunks.push(Buffer.from(msg.body as string, "base64"));
    if (msg.type === "end") return { status, body: Buffer.concat(chunks) };
  }
}

test(
  "a large response over a stalled relay is flow-controlled instead of killing the shared uplink",
  { timeout: 30_000 },
  async () => {
    // Larger than sendFrame's 4 MiB overflow guard once sealed (Pocket's portrait atlas is 2.7 MB).
    const big = crypto.randomBytes(9 * 1024 * 1024);
    const h = await harness((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(req.url === "/api/big" ? big : "small");
    });
    try {
      const { welcome } = await h.hello("c1");
      h.host.approve(keyId(h.phone.publicKey), welcome.code as string);
      const large = await h.hello("c2");
      const small = await h.hello("c3");
      assert.equal(large.welcome.authorized, true);
      // The relay stops reading the Mac uplink, like a congested cellular hop.
      const raw = (h.ws as unknown as { _socket: import("node:net").Socket })._socket;
      h.send("c2", request(large.cipher, large.welcome.challenge, "/api/big"));
      raw.pause();
      await new Promise((r) => setTimeout(r, 1500));
      h.send("c3", request(small.cipher, small.welcome.challenge, "/api/small"));
      raw.resume();
      const [a, b] = await Promise.all([
        readBody(h, "c2", large.cipher),
        readBody(h, "c3", small.cipher),
      ]);
      assert.ok(a.body.equals(big));
      assert.equal(b.body.toString(), "small");
      assert.equal(h.ws.readyState, WebSocket.OPEN, "the shared relay uplink must survive");
    } finally {
      await h.close();
    }
  },
);

test(
  "idle LAN sockets cannot exhaust the cloud route's channels",
  { timeout: 20_000 },
  async () => {
    const h = await harness((_req, res) => res.end("{}"));
    const lan: WebSocket[] = [];
    try {
      const port = (h.host as unknown as { lan: http.Server }).lan.address() as AddressInfo;
      for (let i = 0; i < 64; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port.port}/link`);
        ws.on("error", () => {});
        lan.push(ws);
        await once(ws, "open");
      }
      const refused = new WebSocket(`ws://127.0.0.1:${port.port}/link`);
      refused.on("error", () => {});
      lan.push(refused);
      await assert.rejects(once(refused, "open"));
      // A LAN neighbour holding every LAN slot still leaves the relay usable.
      const { welcome } = await h.hello("cloud-1");
      assert.equal(welcome.authorized, false);
    } finally {
      for (const ws of lan) ws.terminate();
      await h.close();
    }
  },
);

test("a dismissed pairing request stays dismissed while the phone keeps polling", async () => {
  const h = await harness((_req, res) => res.end("{}"));
  try {
    const id = keyId(h.phone.publicKey);
    const first = await h.hello("p1");
    assert.equal(h.host.status().pending.length, 1);
    h.host.revoke(id); // "Dismiss request" on the Mac
    await h.hello("p2"); // Pocket 1.3 re-polls with pair:true every 3 s
    assert.deepEqual(h.host.status().pending, []);
    assert.throws(() => h.host.approve(id, first.welcome.code as string), /pairing_expired/);
    // A different phone is unaffected.
    await h.hello("p3", identity());
    assert.equal(h.host.status().pending.length, 1);
  } finally {
    await h.close();
  }
});

test("phone clock skew within five minutes is tolerated; far-off expiries are refused", async () => {
  const h = await harness((_req, res) => res.end("ok"));
  try {
    const { welcome } = await h.hello("s0");
    h.host.approve(keyId(h.phone.publicKey), welcome.code as string);
    // Pocket stamps its own clock + 60 s: 3 min behind, 4 min ahead, then 30 min ahead.
    for (const [channel, skew, ok] of [
      ["s1", -3 * 60_000, true],
      ["s2", 4 * 60_000, true],
      ["s3", 30 * 60_000, false],
    ] as const) {
      const c = await h.hello(channel);
      h.send(
        channel,
        request(c.cipher, c.welcome.challenge, "/api/x", "GET", Date.now() + skew + 60_000),
      );
      if (ok) assert.equal((await readBody(h, channel, c.cipher)).body.toString(), "ok");
      else assert.equal(await h.nextFrame(channel), "closed");
    }
  } finally {
    await h.close();
  }
});
