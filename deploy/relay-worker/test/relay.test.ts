import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from "miniflare";

const token = (uid: string, exp = Date.now() + 60_000) =>
  `s1.${Buffer.from(JSON.stringify({ uid, exp })).toString("base64url")}.valid`;
function message(ws: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 5000);
    ws.addEventListener(
      "message",
      (event: any) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data));
      },
      { once: true },
    );
  });
}
test(
  "account actor routes binary iOS hello, isolates accounts, rechecks revocation and closes peers",
  { timeout: 40_000 },
  async () => {
    let revoked = false;
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        scriptPath: ".tmp/build/index.js",
        compatibilityDate: "2026-11-07",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { ACCOUNTS: { className: "AccountRelay", useSQLite: true } },
        bindings: { AUTH_ORIGIN: "https://account.example" },
        outboundService: async (request) => {
          assert.equal(request.url, "https://account.example/api/auth/me");
          const value = request.headers.get("Authorization")!.slice(7);
          const claims = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString());
          return MFResponse.json({ signedIn: !revoked, uid: claims.uid });
        },
      }),
    );
    const sockets: any[] = [];
    const call = (path: string, t = token("alice"), headers: Record<string, string> = {}) =>
      mf.dispatchFetch(`https://relay.example/api/relay/${path}`, {
        headers: { Authorization: `Bearer ${t}`, ...headers },
      });
    try {
      assert.equal((await call("macs", "bad")).status, 403);
      assert.equal((await call("macs", token("alice", 1))).status, 403);
      assert.equal(
        (await call("macs", token("alice"), { Origin: "https://evil.example" })).status,
        403,
      );
      const r = await call("host", token("alice"), { Upgrade: "websocket" });
      assert.equal(r.status, 101, r.status === 101 ? undefined : await r.text());
      const host = r.webSocket!;
      host.accept();
      sockets.push(host);
      const key = randomBytes(32).toString("base64");
      const registered = message(host);
      host.send(JSON.stringify({ type: "register", name: "Test Mac", publicKey: key }));
      const id = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
      assert.equal((await registered).id, id);
      const listed = (await (await call("macs")).json()) as any;
      assert.equal(listed.hosts[0].id, id);
      assert.deepEqual(((await (await call("macs", token("bob"))).json()) as any).hosts, []);
      assert.equal(
        (await call(`client?host=${id}`, token("bob"), { Upgrade: "websocket" })).status,
        503,
      );
      const cr = await call(`client?host=${id}`, token("alice"), { Upgrade: "websocket" });
      assert.equal(cr.status, 101);
      const client = cr.webSocket!;
      client.accept();
      sockets.push(client);
      const hello = { type: "hello", publicKey: key, salt: key, name: "iPhone", pair: true };
      const received = message(host);
      client.send(new TextEncoder().encode(JSON.stringify(hello)));
      const forwarded = await received;
      assert.deepEqual(forwarded.payload, hello);
      const response = message(client);
      host.send(
        JSON.stringify({
          type: "frame",
          channel: forwarded.channel,
          payload: { seq: 0, box: "opaque" },
        }),
      );
      assert.deepEqual(await response, { seq: 0, box: "opaque" });
      // A small numeric encoding expands during JSON normalization. Close only
      // this offending phone, preserving the host and another active phone.
      const large = await call(`client?host=${id}`, token("alice"), { Upgrade: "websocket" });
      const bad = large.webSocket!;
      bad.accept();
      sockets.push(bad);
      const badClosed = new Promise((resolve) =>
        bad.addEventListener("close", resolve, { once: true }),
      );
      bad.send("[" + Array(160000).fill("1e-6").join(",") + "]");
      await badClosed;
      assert.equal(((await (await call("macs")).json()) as any).hosts[0].id, id);
      const closed = new Promise((resolve) =>
        client.addEventListener("close", resolve, { once: true }),
      );
      revoked = true;
      await closed;
      assert.equal((await call("macs")).status, 403);
    } finally {
      for (const ws of sockets)
        try {
          ws.close();
        } catch {}
      await mf.dispose();
    }
  },
);
