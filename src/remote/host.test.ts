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
import {
  identity,
  keyId,
  LinkCipher,
  pairingCode,
  pairingCommitment,
  pairingNonce,
  verificationCode,
  type LinkIdentity,
} from "./protocol.js";

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
  /** forbid: answer the Mac's relay upgrade 403, as a relay does for a refused session. */
  const control = { forbid: false, forbidden: 0 };
  cloud.on("upgrade", (req, socket, head) => {
    if (control.forbid) {
      control.forbidden++;
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
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
  const base = `http://127.0.0.1:${cloudPort}`;
  const host = new RemoteHost(home, backendPort);
  const uplink = new Promise<WebSocket>((resolve) => nextUplink.push(resolve));
  await host.connect(base, "alice");
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
    base,
    control,
    /** The cloud stops answering at all (connection refused), as in an outage. */
    async cloudDown() {
      await new Promise<void>((r) => {
        cloud.close(() => r());
        cloud.closeAllConnections();
        for (const s of uplinks) s.terminate();
      });
    },
    async cloudUp() {
      await new Promise<void>((r) => cloud.listen(cloudPort, "127.0.0.1", r));
    },
    lanPort(target = host): number {
      return ((target as unknown as { lan: http.Server }).lan.address() as AddressInfo).port;
    },
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
    async hello(
      channel: string,
      key: LinkIdentity = phone,
      pair = true,
      extra: Record<string, unknown> = {},
    ) {
      const salt = crypto.randomBytes(32).toString("base64");
      const cipher = new LinkCipher(key, hostKey, salt, "client");
      this.send(channel, {
        type: "hello",
        publicKey: key.publicKey,
        salt,
        name: "Test",
        pair,
        ...extra,
      });
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
      await new Promise<void>((r) => (cloud.listening ? cloud.close(() => r()) : r()));
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

type Harness = Awaited<ReturnType<typeof harness>>;

/** RemoteMacTransport's v2 pairing round: commit in the hello, receive Nm, then reveal. */
async function pairV2(
  h: Harness,
  channel: string,
  key: LinkIdentity = h.phone,
  nonce = pairingNonce(),
  reveal = nonce,
) {
  const commit = pairingCommitment(h.hostKey, key.publicKey, nonce);
  const { cipher, welcome } = await h.hello(channel, key, true, { v: 2, commit });
  if (typeof welcome.nonce !== "string") return { welcome, code: null };
  h.send(channel, cipher.seal({ type: "pair", nonce: reveal }));
  const frame = await h.nextFrame(channel);
  if (frame === "closed") return { welcome, code: null };
  const paired = cipher.open(frame as never);
  assert.equal(paired.type, "paired");
  assert.equal(paired.code, pairingCode(h.hostKey, key.publicKey, nonce, welcome.nonce));
  return { welcome, code: paired.code };
}

test("agent-host and Pocket grants cannot cross protocol roles on the encrypted bridge", async () => {
  const forwarded: string[] = [];
  const h = await harness((req, res) => {
    forwarded.push(req.url!);
    res.end("ok");
  });
  try {
    const nonce = pairingNonce();
    const first = await h.hello("f0", h.phone, true, {
      v: 2,
      commit: pairingCommitment(h.hostKey, h.phone.publicKey, nonce),
    });
    h.send("f0", first.cipher.seal({ type: "pair", nonce, role: "agent-host" }));
    const paired = first.cipher.open((await h.nextFrame("f0")) as never);
    assert.equal(paired.role, "agent-host");
    h.host.approve(keyId(h.phone.publicKey), String(paired.code), {
      control: false,
      workspaces: [crypto.randomUUID()],
    });
    for (const [i, route] of [
      "/chat",
      "/api/control/policy",
      "/api/agents/sessions",
      "/api/fleet/local",
      "/events",
    ].entries()) {
      const channel = "reject" + i;
      const p = await h.hello(channel, h.phone, false, { v: 2 });
      h.send(channel, request(p.cipher, p.welcome.challenge, route));
      assert.equal(await h.nextFrame(channel), "closed");
    }
    const allowed = "/api/agent-host/v1/capabilities",
      p = await h.hello("caps", h.phone, false, { v: 2 });
    h.send("caps", request(p.cipher, p.welcome.challenge, allowed));
    assert.equal((await readBody(h, "caps", p.cipher)).status, 200);
    const pocket = identity(),
      old = await pairV2(h, "p0", pocket);
    h.host.approve(keyId(pocket.publicKey), String(old.code));
    const phone = await h.hello("p1", pocket, false, { v: 2 });
    h.send("p1", request(phone.cipher, phone.welcome.challenge, allowed));
    assert.equal(await h.nextFrame("p1"), "closed");
    assert.deepEqual(forwarded, [allowed]);
  } finally {
    await h.close();
  }
});

test("granting, re-granting and revoking an agent-host device tells the executor", async () => {
  const h = await harness((_req, res) => res.end("ok"));
  const calls: [string, unknown][] = [];
  h.host.onFleetGrantChange = (id, grant) => calls.push([id, grant]);
  try {
    const device = keyId(h.phone.publicKey);
    const pairFleet = async (channel: string) => {
      const nonce = pairingNonce();
      const c = await h.hello(channel, h.phone, true, {
        v: 2,
        commit: pairingCommitment(h.hostKey, h.phone.publicKey, nonce),
      });
      h.send(channel, c.cipher.seal({ type: "pair", nonce, role: "agent-host" }));
      return String(c.cipher.open((await h.nextFrame(channel)) as never).code);
    };
    const wide = { control: true, workspaces: [crypto.randomUUID(), crypto.randomUUID()] };
    h.host.approve(device, await pairFleet("g0"), wide);
    const narrow = { control: false, workspaces: [wide.workspaces[0]!] };
    h.host.approve(device, await pairFleet("g1"), narrow);
    // A Pocket device never had agent-host rights, so revoking it is not reported.
    const pocket = identity(),
      old = await pairV2(h, "p0", pocket);
    h.host.approve(keyId(pocket.publicKey), String(old.code));
    h.host.revoke(keyId(pocket.publicKey));
    h.host.revoke(device);
    assert.deepEqual(calls, [
      [device, wide],
      [device, narrow],
      [device, undefined],
    ]);
  } finally {
    await h.close();
  }
});

test("negotiation on a v2 Mac: v2 phones get a committed code, Pocket 1.3 the flagged v1 code", async () => {
  const h = await harness((_req, res) => res.end("ok"));
  try {
    const id = keyId(h.phone.publicKey);
    const nonce = pairingNonce();
    const commit = pairingCommitment(h.hostKey, h.phone.publicKey, nonce);
    const first = await h.hello("n1", h.phone, true, { v: 2, commit });
    assert.equal(first.welcome.v, 2);
    assert.equal(first.welcome.code, undefined, "a v2 phone never gets the uncommitted code");
    assert.equal(first.welcome.authorized, false);
    assert.equal(first.welcome.pending, true);
    assert.match(first.welcome.nonce as string, /^[A-Za-z0-9+/]{43}=$/);
    // Nothing to compare (or approve) until the phone opens its commitment; the slot it
    // holds is visible to the owner as waiting.
    assert.deepEqual(
      h.host.status().pending.map((p) => [p.id, p.code, p.waiting]),
      [[id, "", true]],
    );
    assert.throws(() => h.host.approve(id, ""), /pairing_expired/);
    // Retrying the same commitment returns the same Mac nonce: no free re-roll.
    const retry = await h.hello("n2", h.phone, true, { v: 2, commit });
    assert.equal(retry.welcome.nonce, first.welcome.nonce);
    h.send("n2", retry.cipher.seal({ type: "pair", nonce }));
    const code = pairingCode(h.hostKey, h.phone.publicKey, nonce, first.welcome.nonce as string);
    assert.deepEqual(retry.cipher.open((await h.nextFrame("n2")) as never), {
      type: "paired",
      code,
    });
    assert.notEqual(code, verificationCode(h.hostKey, h.phone.publicKey));
    // A reveal channel cannot also carry a request.
    h.send("n2", request(retry.cipher, retry.welcome.challenge, "/api/x"));
    assert.equal(await h.nextFrame("n2"), "closed");
    assert.deepEqual(
      h.host.status().pending.map((p) => [p.id, p.code, p.secure, p.known]),
      [[id, code, true, false]],
    );
    // Pocket then polls without a commitment; the open request is reported, not replaced.
    const poll = await h.hello("n3", h.phone, false, { v: 2 });
    assert.deepEqual(
      [poll.welcome.authorized, poll.welcome.pending, poll.welcome.nonce],
      [false, true, undefined],
    );
    assert.throws(() => h.host.approve(id, verificationCode(h.hostKey, h.phone.publicKey)));
    h.host.approve(id, code);
    assert.deepEqual(
      h.host.status().devices.map((d) => [d.id, d.secure]),
      [[id, true]],
    );
    const approved = await h.hello("n4", h.phone, false, { v: 2 });
    assert.equal(approved.welcome.authorized, true);
    h.send("n4", request(approved.cipher, approved.welcome.challenge, "/api/x"));
    assert.equal((await readBody(h, "n4", approved.cipher)).body.toString(), "ok");

    // Pocket 1.3 (no `v`) on the same Mac: the unchanged v1 flow, flagged as weaker.
    const old = identity();
    const legacy = await h.hello("o1", old);
    assert.equal(legacy.welcome.v, undefined);
    assert.equal(legacy.welcome.code, verificationCode(h.hostKey, old.publicKey));
    const listed = h.host.status().pending.find((p) => p.id === keyId(old.publicKey))!;
    assert.deepEqual([listed.code, listed.secure], [legacy.welcome.code, false]);
    h.host.approve(listed.id, listed.code);
    assert.equal(h.host.status().devices.find((d) => d.id === listed.id)?.secure, false);
    const again = await h.hello("o2", old);
    assert.equal(again.welcome.authorized, true);
    assert.equal(again.welcome.code, legacy.welcome.code, "Pocket 1.3 checks it on every link");
    h.send("o2", request(again.cipher, again.welcome.challenge, "/api/x"));
    assert.equal((await readBody(h, "o2", again.cipher)).body.toString(), "ok");
    // The grant record is unchanged for older Macs reading the same file.
    const saved = JSON.parse(fs.readFileSync(path.join(h.home, "remote-link.json"), "utf8"));
    assert.equal(saved.version, 1);
    assert.deepEqual(
      saved.grants.map((g: { pairing?: number }) => g.pairing),
      [2, undefined],
    );
  } finally {
    await h.close();
  }
});

test(
  "probe: a relay substituting both keys in v2 pairing is detected and cannot re-roll a match",
  { timeout: 20_000 },
  async () => {
    const h = await harness((_req, res) => res.end("ok"));
    try {
      // The relay controls discovery and every frame. It shows the phone its own "Mac"
      // key and introduces itself to the real Mac as a phone with another key of its own.
      const fakeMac = identity();
      const fakePhone = identity();
      const fakeId = keyId(fakePhone.publicKey);
      // 1. The real phone commits to (fake Mac key, its key, Np) before learning anything.
      const np = pairingNonce();
      // 2. Toward the real Mac the relay must commit too, and only then learns Nm.
      const atMac = await pairV2(h, "m1", fakePhone);
      assert.ok(atMac.code);
      assert.deepEqual(
        h.host.status().pending.map((p) => [p.id, p.code]),
        [[fakeId, atMac.code]],
      );
      // 3. Toward the phone it now picks Nm' knowing the Mac's code but not Np (only the
      //    commitment). Whatever it picks, the phone's code is a hash of the unseen Np.
      const phoneCode = pairingCode(fakeMac.publicKey, h.phone.publicKey, np, pairingNonce());
      assert.notEqual(phoneCode, atMac.code, "the owner sees two different codes");
      assert.throws(() => h.host.approve(fakeId, phoneCode), /pairing_expired/);
      // 4. Having seen Np, the relay re-rolls the Mac side. Every new commitment gets a
      //    never-before-offered Mac nonce, and a request accepts at most five.
      const offered = new Set([atMac.welcome.nonce]);
      let rounds = 1;
      for (let i = 2; i < 12; i++) {
        const next = await pairV2(h, `m${i}`, fakePhone);
        if (!next.code) {
          assert.equal(next.welcome.nonce, undefined);
          break;
        }
        rounds++;
        assert.ok(!offered.has(next.welcome.nonce), "a Mac nonce is never reused");
        offered.add(next.welcome.nonce);
        assert.notEqual(next.code, phoneCode);
      }
      assert.equal(rounds, 5, "five blind 2^-48 guesses per pairing request, then refused");
      // 5. It cannot open a commitment to a different nonce than the one it committed to.
      const cheat = identity();
      const opened = await pairV2(h, "x1", cheat, pairingNonce(), pairingNonce());
      assert.equal(opened.code, null);
      assert.equal(
        h.host.status().pending.find((p) => p.id === keyId(cheat.publicKey))?.code,
        "",
        "no code, nothing to approve",
      );
      // 6. Nor answer a nonce issued to a superseded commitment (a mid-flight re-roll).
      const racer = identity();
      const np1 = pairingNonce();
      const c1 = await h.hello("r1", racer, true, {
        v: 2,
        commit: pairingCommitment(h.hostKey, racer.publicKey, np1),
      });
      await pairV2(h, "r2", racer);
      h.send("r1", c1.cipher.seal({ type: "pair", nonce: np1 }));
      assert.equal(await h.nextFrame("r1"), "closed");
      assert.deepEqual(h.host.status().devices, [], "nothing was approved");
    } finally {
      await h.close();
    }
  },
);

test("an already-allowed phone that pairs again must still verify this Mac's code", async () => {
  const h = await harness((_req, res) => res.end("ok"));
  try {
    const id = keyId(h.phone.publicKey);
    const first = await pairV2(h, "k1");
    h.host.approve(id, first.code!);
    // E.g. after signing out of Pocket: the phone re-selects a Mac from the relay's list.
    const again = await pairV2(h, "k2");
    assert.equal(again.welcome.authorized, true);
    assert.ok(again.code && again.code !== first.code);
    assert.deepEqual(
      h.host.status().pending.map((p) => [p.id, p.code, p.known, p.secure]),
      [[id, again.code, true, true]],
    );
    // Pairing never runs over LAN: an allowed device's LAN hello gets no nonce.
    const port = ((h.host as unknown as { lan: http.Server }).lan.address() as AddressInfo).port;
    const lan = new WebSocket(`ws://127.0.0.1:${port}/link`);
    lan.on("error", () => {});
    await once(lan, "open");
    const salt = crypto.randomBytes(32).toString("base64");
    const lanCipher = new LinkCipher(h.phone, h.hostKey, salt, "client");
    const lanWelcome = once(lan, "message");
    lan.send(
      JSON.stringify({
        type: "hello",
        publicKey: h.phone.publicKey,
        salt,
        pair: true,
        v: 2,
        commit: pairingCommitment(h.hostKey, h.phone.publicKey, pairingNonce()),
      }),
    );
    const viaLan = lanCipher.open(JSON.parse(String((await lanWelcome)[0])));
    assert.deepEqual([viaLan.authorized, viaLan.nonce], [true, undefined]);
    lan.terminate();
    // Once the user confirms on the phone, its first real request closes the prompt.
    const use = await h.hello("k3", h.phone, false, { v: 2 });
    h.send("k3", request(use.cipher, use.welcome.challenge, "/api/x"));
    assert.equal((await readBody(h, "k3", use.cipher)).body.toString(), "ok");
    assert.deepEqual(h.host.status().pending, []);
  } finally {
    await h.close();
  }
});

test("requireSecurePairing refuses new v1 pairings and keeps existing devices working", async () => {
  const h = await harness((_req, res) => res.end("ok"));
  try {
    const old = identity();
    const a = await h.hello("a1", old);
    h.host.approve(keyId(old.publicKey), a.welcome.code as string);
    const newer = identity();
    const b = await h.hello("b1", newer);
    assert.equal(h.host.status().pending.length, 1);
    h.host.setPolicy({ requireSecurePairing: true });
    assert.deepEqual(h.host.status().pending, [], "open v1 requests are withdrawn");
    assert.throws(() => h.host.approve(keyId(newer.publicKey), b.welcome.code as string));
    const retried = await h.hello("b2", newer);
    assert.equal(retried.welcome.authorized, false);
    assert.deepEqual(h.host.status().pending, []);
    assert.equal(h.host.status().legacyRefused?.name, "Test");
    // An existing v1 device is unaffected.
    const existing = await h.hello("a2", old, false);
    assert.equal(existing.welcome.authorized, true);
    h.send("a2", request(existing.cipher, existing.welcome.challenge, "/api/x"));
    assert.equal((await readBody(h, "a2", existing.cipher)).body.toString(), "ok");
    // v2 phones still pair.
    assert.ok((await pairV2(h, "c1", identity())).code);
    assert.equal(h.host.status().requireSecurePairing, true);
    const saved = JSON.parse(fs.readFileSync(path.join(h.home, "remote-link.json"), "utf8"));
    assert.equal(saved.requireSecurePairing, true);
    assert.throws(() => h.host.setPolicy({ requireSecurePairing: "yes" }), /invalid_policy/);
    h.host.setPolicy({ requireSecurePairing: false });
    assert.equal(h.host.status().legacyRefused, null);
    await h.hello("b3", newer);
    assert.equal(
      h.host.status().pending.find((p) => p.id === keyId(newer.publicKey))?.secure,
      false,
    );
  } finally {
    await h.close();
  }
});

/** A hello carries no proof of key possession: anyone on the relay can send one. */
async function forgedHello(h: Harness, channel: string, publicKey: string) {
  h.send(channel, {
    type: "hello",
    publicKey,
    salt: crypto.randomBytes(32).toString("base64"),
    name: "Forged",
    pair: true,
    v: 2,
    commit: crypto.randomBytes(32).toString("base64"),
  });
  assert.notEqual(await h.nextFrame(channel), "closed");
}

test("forged hellos cannot replace an opened request or extend its lifetime", async () => {
  const h = await harness((_req, res) => res.end("ok"));
  try {
    const id = keyId(h.phone.publicKey);
    const paired = await pairV2(h, "f0");
    const before = h.host.status().pending.find((p) => p.id === id)!;
    for (let i = 1; i <= 6; i++) await forgedHello(h, `f${i}`, h.phone.publicKey);
    // The relay used up this request's Mac nonces (its rounds), but the code the phone
    // opened stays listed, unchanged, with its original expiry, and stays approvable.
    const after = h.host.status().pending.find((p) => p.id === id)!;
    assert.deepEqual(
      [after.code, after.name, after.expiresAt, after.waiting],
      [paired.code, "Test", before.expiresAt, false],
    );
    // A new commitment from the real phone gets no nonce now: a denial of service the
    // relay could cause anyway by dropping frames, never a changed code.
    assert.equal((await pairV2(h, "f7")).code, null);
    h.host.approve(id, paired.code!);
    assert.equal(h.host.status().devices.find((d) => d.id === id)?.secure, true);
  } finally {
    await h.close();
  }
});

test("a phone that restarts replaces its own opened code only by opening the new one", async () => {
  const h = await harness((_req, res) => res.end("ok"));
  try {
    const id = keyId(h.phone.publicKey);
    const first = await pairV2(h, "a1");
    const np = pairingNonce();
    const commit = pairingCommitment(h.hostKey, h.phone.publicKey, np);
    const offer = await h.hello("a2", h.phone, true, { v: 2, commit });
    // Offered but not yet opened: the earlier code is still the one shown.
    assert.equal(h.host.status().pending.find((p) => p.id === id)?.code, first.code);
    h.send("a2", offer.cipher.seal({ type: "pair", nonce: np }));
    const opened = offer.cipher.open((await h.nextFrame("a2")) as never);
    assert.equal(opened.code, pairingCode(h.hostKey, h.phone.publicKey, np, offer.welcome.nonce));
    assert.equal(h.host.status().pending.find((p) => p.id === id)?.code, opened.code);
    assert.throws(() => h.host.approve(id, first.code!), /pairing_expired/);
  } finally {
    await h.close();
  }
});

test("waiting requests are listed and clearing one never disconnects a device", async () => {
  const h = await harness((_req, res) => res.end("ok"));
  try {
    const id = keyId(h.phone.publicKey);
    const first = await pairV2(h, "w1");
    h.host.approve(id, first.code!);
    // A re-pair hello (real or forged) that never opens its commitment.
    await forgedHello(h, "w2", h.phone.publicKey);
    assert.deepEqual(
      h.host.status().pending.map((p) => [p.id, p.waiting, p.known]),
      [[id, true, true]],
    );
    h.host.dismiss(id);
    assert.deepEqual(h.host.status().pending, []);
    assert.equal(h.host.status().devices.length, 1, "the device stays allowed");
    // Cleared requests stay cleared for their lifetime.
    assert.equal((await pairV2(h, "w3")).code, null);
    const use = await h.hello("w4", h.phone, false, { v: 2 });
    assert.equal(use.welcome.authorized, true);
  } finally {
    await h.close();
  }
});

test("downgrade: a key-substituting relay that speaks v1 to the Mac is flagged, or refused", async () => {
  const h = await harness((_req, res) => res.end("ok"));
  try {
    // The relay answers the real (v2) phone itself and introduces its own key to the
    // Mac as Pocket 1.3, where the code depends on the keys alone.
    const fakePhone = identity();
    const asOld = await h.hello("d1", fakePhone);
    assert.equal(asOld.welcome.v, undefined);
    assert.deepEqual(
      h.host.status().pending.map((p) => [p.id, p.secure, p.waiting]),
      [[keyId(fakePhone.publicKey), false, false]],
      "lenient Mac: the request is shown, marked as the older method",
    );
    h.host.dismiss(keyId(fakePhone.publicKey));
    // Strict Mac: no request at all, only a note for the owner. Its text must not advise
    // turning strict mode off (the "old" phone may be a relay).
    h.host.setPolicy({ requireSecurePairing: true });
    const refused = identity();
    const strict = await h.hello("d2", refused);
    assert.equal(strict.welcome.authorized, false);
    assert.deepEqual(h.host.status().pending, []);
    assert.equal(h.host.status().legacyRefused?.name, "Test");
    // ...while a v2 pairing on the same strict Mac goes through, with its rounds capped.
    assert.ok((await pairV2(h, "d3", identity())).code);
  } finally {
    await h.close();
  }
});

async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** An allowed phone's whole request over the LAN listener, as Pocket does on Wi-Fi. */
async function overLan(port: number, phone: LinkIdentity, hostKey: string, route: string) {
  const lan = new WebSocket(`ws://127.0.0.1:${port}/link`);
  lan.on("error", () => {});
  const inbox: Frame[] = [];
  lan.on("message", (data) => inbox.push(JSON.parse(data.toString())));
  await once(lan, "open");
  const next = async () => {
    await until(() => inbox.length > 0 || lan.readyState !== WebSocket.OPEN, 5000, "LAN frame");
    assert.ok(inbox.length, "the LAN channel closed");
    return inbox.shift()!;
  };
  try {
    const salt = crypto.randomBytes(32).toString("base64");
    const cipher = new LinkCipher(phone, hostKey, salt, "client");
    lan.send(JSON.stringify({ type: "hello", publicKey: phone.publicKey, salt, name: "Test" }));
    const welcome = cipher.open((await next()) as never);
    assert.equal(welcome.authorized, true);
    lan.send(JSON.stringify(request(cipher, welcome.challenge, route)));
    const chunks: Buffer[] = [];
    while (true) {
      const msg = cipher.open((await next()) as never);
      if (msg.type === "chunk") chunks.push(Buffer.from(msg.body as string, "base64"));
      if (msg.type === "end") return Buffer.concat(chunks).toString();
    }
  } finally {
    lan.terminate();
  }
}

test(
  "Reconnect while the cloud is down keeps LAN devices working, and the Mac comes back with the cloud",
  { timeout: 40_000 },
  async () => {
    const h = await harness((_req, res) => res.end("ok"));
    try {
      const { welcome } = await h.hello("c1");
      h.host.approve(keyId(h.phone.publicKey), welcome.code as string);
      const port = h.lanPort();
      assert.equal(await overLan(port, h.phone, h.hostKey, "/api/x"), "ok");
      await h.cloudDown();
      await until(() => !h.host.status().online, 5000, "the relay to drop");
      // The owner presses Reconnect: account validation fails before anything is torn down.
      await assert.rejects(h.host.connect(h.base, "alice"));
      assert.equal(h.lanPort(), port, "the LAN listener must survive a failed Reconnect");
      assert.equal(await overLan(port, h.phone, h.hostKey, "/api/x"), "ok");
      assert.equal(h.host.status().enabled, true);
      // ...and the relay retry loop kept running: the Mac returns once the cloud does.
      await h.cloudUp();
      await until(() => h.host.status().online, 25_000, "the Mac to come back online");
      assert.equal(h.host.status().error, "");
    } finally {
      await h.close();
    }
  },
);

test(
  "a relay 403 keeps phone connections on, keeps retrying and reports sign_in_required",
  { timeout: 30_000 },
  async () => {
    const h = await harness((_req, res) => res.end("ok"));
    try {
      h.control.forbid = true;
      h.ws.terminate();
      await until(() => h.control.forbidden >= 1, 5000, "a refused reconnect");
      // The generic `error` event that follows the aborted handshake must not win.
      await new Promise((r) => setTimeout(r, 200));
      const status = h.host.status();
      assert.deepEqual(
        [status.enabled, status.online, status.error],
        [true, false, "sign_in_required"],
      );
      const saved = JSON.parse(fs.readFileSync(path.join(h.home, "remote-link.json"), "utf8"));
      assert.equal(saved.enabled, true, "a 403 must not turn phone connections off for good");
      // LAN devices are unaffected, and the relay is retried with backoff until it lets
      // the Mac in again (e.g. after an account-service hiccup).
      await until(() => h.control.forbidden >= 2, 10_000, "a second attempt");
      h.control.forbid = false;
      await until(() => h.host.status().online, 15_000, "the Mac to come back online");
      assert.equal(h.host.status().error, "");
    } finally {
      await h.close();
    }
  },
);

test("restore with an expired session starts LAN and says the owner must sign in again", async () => {
  const h = await harness((_req, res) => res.end("ok"));
  const claims = (exp: number) =>
    `s1.${Buffer.from(JSON.stringify({ uid: "alice", exp })).toString("base64url")}.sig`;
  const restored = new RemoteHost(h.home, 1);
  try {
    const { welcome } = await h.hello("c1");
    h.host.approve(keyId(h.phone.publicKey), welcome.code as string);
    h.host.stop();
    h.control.forbid = true; // what any relay answers an expired session
    await restored.restore(h.base, claims(Date.now() - 1000));
    const status = restored.status();
    assert.deepEqual(
      [status.enabled, status.signedIn, status.sessionExpired, status.error],
      [true, true, true, "sign_in_required"],
    );
    // An approved device on the same Wi-Fi still reaches this Mac.
    const lan = new WebSocket(`ws://127.0.0.1:${h.lanPort(restored)}/link`);
    lan.on("error", () => {});
    await once(lan, "open");
    lan.terminate();
    await until(() => h.control.forbidden >= 1, 5000, "the relay attempt");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(restored.status().error, "sign_in_required");
    // A live session is not reported as expired.
    const fresh = new RemoteHost(h.home, 1);
    await fresh.restore(h.base, claims(Date.now() + 60_000));
    assert.equal(fresh.status().sessionExpired, false);
    fresh.stop();
  } finally {
    restored.stop();
    await h.close();
  }
});
