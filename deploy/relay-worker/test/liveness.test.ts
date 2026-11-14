/** Host liveness, offline Macs and slow phones on the production relay (miniflare). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from "miniflare";
import { WebSocket as NodeWebSocket } from "ws";

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';
const HOST_TIMEOUT_MS = 1500;
const token = (uid: string, exp = Date.now() + 120_000) =>
  `s1.${Buffer.from(JSON.stringify({ uid, exp })).toString("base64url")}.valid`;
const idOf = (key: string) =>
  createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function relay() {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: ".tmp/build/index.js",
      compatibilityDate: "2026-11-07",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { ACCOUNTS: { className: "AccountRelay", useSQLite: true } },
      bindings: { AUTH_ORIGIN: "https://account.example", HOST_TIMEOUT_MS: String(HOST_TIMEOUT_MS) },
      outboundService: async (request) => {
        const value = request.headers.get("Authorization")!.slice(7);
        const claims = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString());
        return MFResponse.json({ signedIn: true, uid: claims.uid });
      },
    }),
  );
}

type Socket = NodeWebSocket & {
  _socket: import("node:net").Socket;
  _closeFrameReceived: boolean;
  _closeCode: number;
  _closeMessage: Buffer;
};

/** A real TCP client (so a test can stop reading) with an inbox and close-frame tracking. */
async function open(base: URL, path: string) {
  const ws = new NodeWebSocket(new URL(`/api/relay/${path}`, base), {
    headers: { Authorization: `Bearer ${token("alice")}` },
    perMessageDeflate: false,
  }) as Socket;
  ws.on("error", () => {});
  const inbox: string[] = [];
  ws.on("message", (data) => inbox.push(data.toString()));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return {
    ws,
    inbox,
    /** The relay's close frame. Local workerd ends the TCP connection of a socket closed
     * from ANOTHER socket's event only much later; a phone reacts to the frame. */
    get closed(): { code: number; reason: string } | undefined {
      return ws._closeFrameReceived
        ? { code: ws._closeCode, reason: ws._closeMessage.toString() }
        : undefined;
    },
    async next(timeoutMs = 5000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (!inbox.length) {
        if (ws._closeFrameReceived) throw new Error(`closed ${ws._closeCode}`);
        if (Date.now() > deadline) throw new Error("message timeout");
        await sleep(20);
      }
      return inbox.shift()!;
    },
    async close(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (!ws._closeFrameReceived && Date.now() < deadline) await sleep(20);
      if (!ws._closeFrameReceived) throw new Error("close timeout");
      return { code: ws._closeCode, reason: ws._closeMessage.toString() };
    },
  };
}

async function harness() {
  const mf = relay();
  const base = await mf.ready;
  const sockets: NodeWebSocket[] = [];
  const call = (path: string, t = token("alice"), headers: Record<string, string> = {}) =>
    mf.dispatchFetch(`https://relay.example/api/relay/${path}`, {
      headers: { Authorization: `Bearer ${t}`, ...headers },
    });
  return {
    call,
    async listed(): Promise<string[]> {
      return (((await (await call("macs")).json()) as any).hosts as { id: string }[]).map(
        (h) => h.id,
      );
    },
    /** A Mac; `legacy` is one from before the heartbeat (0.31 and earlier). */
    async host(key: string, legacy = false) {
      const c = await open(base, "host");
      sockets.push(c.ws);
      c.ws.send(
        JSON.stringify({
          type: "register",
          name: "Mac",
          publicKey: key,
          ...(legacy ? {} : { heartbeat: true }),
        }),
      );
      assert.deepEqual(JSON.parse(await c.next()), { type: "registered", id: idOf(key) });
      return { ...c, closed: () => c.closed, id: idOf(key) };
    },
    async phone(id: string) {
      const c = await open(base, `client?host=${id}`);
      sockets.push(c.ws);
      return { ...c, closed: () => c.closed };
    },
    async dispose() {
      for (const ws of sockets) ws.terminate();
      await mf.dispose();
    },
  };
}

test(
  "a silent heartbeat host is unlisted, refused before upgrade, replaced by its own re-registration and timed out",
  { timeout: 45_000 },
  async () => {
    const h = await harness();
    try {
      const pinging = await h.host(randomBytes(32).toString("base64"));
      const silentKey = randomBytes(32).toString("base64");
      const silent = await h.host(silentKey);
      const legacyKey = randomBytes(32).toString("base64");
      const legacy = await h.host(legacyKey, true);
      assert.deepEqual(
        new Set(await h.listed()),
        new Set([pinging.id, silent.id, legacy.id]),
      );
      // The runtime answers the Mac's ping itself (auto-response), byte-exact.
      pinging.ws.send(PING);
      assert.equal(await pinging.next(), PONG);
      // A phone already talking to the soon-silent Mac.
      const before = await h.phone(silent.id);
      const ticker = setInterval(() => pinging.ws.send(PING), 300);
      try {
        await sleep(HOST_TIMEOUT_MS + 700);
        // A Mac from before the heartbeat is never timed out, only replaced.
        assert.deepEqual(new Set(await h.listed()), new Set([pinging.id, legacy.id]));
        // Offline as far as phones are concerned: HTTP 503 before the WebSocket upgrade.
        const refused = await h.call(`client?host=${silent.id}`, token("alice"), {
          Upgrade: "websocket",
        });
        assert.equal(refused.status, 503);
        assert.equal(refused.webSocket, null);
        assert.deepEqual(await refused.json(), { error: "mac_offline" });
        // ...and its open channel is closed on its next frame instead of hanging.
        before.ws.send(JSON.stringify({ seq: 0, box: "opaque" }));
        assert.deepEqual(await before.close(), { code: 1013, reason: "mac_offline" });
        // The same Mac reconnecting replaces the socket it left behind (was 1008).
        const back = await h.host(silentKey);
        assert.deepEqual(await silent.close(), { code: 4000, reason: "replaced" });
        assert.ok((await h.listed()).includes(back.id));
        const legacyBack = await h.host(legacyKey, true);
        assert.deepEqual(await legacy.close(), { code: 4000, reason: "replaced" });
        assert.ok((await h.listed()).includes(legacyBack.id));
        // The alarm (every 15 s) closes a silent host for good.
        const gone = await h.host(randomBytes(32).toString("base64"));
        assert.deepEqual(await gone.close(25_000), { code: 4408, reason: "heartbeat_timeout" });
        assert.equal(pinging.closed(), undefined, "a pinging host survives the alarm");
        assert.equal(legacyBack.closed(), undefined, "a legacy host survives the alarm");
        assert.equal((await h.phone(pinging.id)).closed(), undefined);
      } finally {
        clearInterval(ticker);
      }
    } finally {
      await h.dispose();
    }
  },
);

test("a phone reaching an offline Mac gets 503 before the upgrade; open channels get 1013", async () => {
  const h = await harness();
  try {
    const unknown = await h.call(`client?host=${"0".repeat(32)}`, token("alice"), {
      Upgrade: "websocket",
    });
    assert.equal(unknown.status, 503);
    const mac = await h.host(randomBytes(32).toString("base64"));
    const phone = await h.phone(mac.id);
    mac.ws.close(1000, "sleep");
    assert.deepEqual(await phone.close(), { code: 1013, reason: "mac_offline" });
    const r = await h.call(`client?host=${mac.id}`, token("alice"), { Upgrade: "websocket" });
    assert.equal(r.status, 503);
    assert.equal(r.webSocket, null);
    assert.deepEqual(await r.json(), { error: "mac_offline" });
    assert.deepEqual(await h.listed(), []);
  } finally {
    await h.dispose();
  }
});

test(
  "a phone that stops reading neither stalls the Mac uplink nor other phones",
  { timeout: 40_000 },
  async () => {
    const h = await harness();
    try {
      const mac = await h.host(randomBytes(32).toString("base64"));
      const slow = await h.phone(mac.id);
      slow.ws.send(JSON.stringify({ type: "hello", n: "slow" }));
      const channel = JSON.parse(await mac.next()).channel as string;
      // Like a phone on a congested cellular hop: the TCP socket stops being read.
      slow.ws._socket.pause();
      // 8 MiB for the slow phone: twice the Node relay's per-client cap (MAX_BUFFER).
      const box = randomBytes(192 * 1024).toString("base64");
      const frames = 32;
      for (let seq = 0; seq < frames; seq++)
        mac.ws.send(JSON.stringify({ type: "frame", channel, payload: { seq, box } }));
      // Meanwhile another phone still gets a round trip through the same Mac uplink.
      const fast = await h.phone(mac.id);
      const started = Date.now();
      fast.ws.send(JSON.stringify({ type: "hello", n: "fast" }));
      const hello = JSON.parse(await mac.next());
      assert.equal(hello.payload.n, "fast");
      mac.ws.send(JSON.stringify({ type: "frame", channel: hello.channel, payload: { ok: 1 } }));
      assert.deepEqual(JSON.parse(await fast.next()), { ok: 1 });
      assert.ok(Date.now() - started < 3000, "the fast phone waited on the slow one");
      assert.equal(mac.closed(), undefined, "the Mac uplink must survive a slow phone");
      // The Worker cannot see a phone's socket buffer (Workers have no bufferedAmount),
      // so unlike the Node relay it buffers instead of cutting the phone off: once the
      // phone reads again, every frame arrives, in order.
      slow.ws._socket.resume();
      const deadline = Date.now() + 20_000;
      while (slow.inbox.length < frames && Date.now() < deadline) await sleep(50);
      assert.deepEqual(
        slow.inbox.map((r) => JSON.parse(r).seq),
        [...Array(frames).keys()],
      );
      assert.equal(slow.closed(), undefined);
    } finally {
      await h.dispose();
    }
  },
);
