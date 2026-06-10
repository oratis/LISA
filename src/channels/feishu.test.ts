import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { FeishuChannel } from "./feishu.js";

// Drive the real HTTP listener on an ephemeral port and assert the
// verification behavior added after the v0.9 review: unauthenticated events
// were previously accepted as long as they parsed.

const ENCRYPT_KEY = "test-encrypt-key";
const TOKEN = "verify-token-123";

function makeChannel(opts: { token?: string; encryptKey?: string }): FeishuChannel {
  return new FeishuChannel({
    appId: "cli_x",
    appSecret: "secret",
    verificationToken: opts.token,
    encryptKey: opts.encryptKey,
    port: 0, // ephemeral
  });
}

function encrypt(payload: object): string {
  const aesKey = crypto.createHash("sha256").update(ENCRYPT_KEY).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return JSON.stringify({ encrypt: Buffer.concat([iv, data]).toString("base64") });
}

async function post(
  port: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/feishu`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe("feishu — inbound event verification", () => {
  const started: FeishuChannel[] = [];
  const start = async (ch: FeishuChannel): Promise<number> => {
    const received: unknown[] = [];
    await ch.start(async (msg) => {
      received.push(msg);
    });
    started.push(ch);
    // @ts-expect-error reach into the private server for the ephemeral port
    return (ch.server.address() as { port: number }).port;
  };
  after(async () => {
    await Promise.all(started.map((c) => c.stop().catch(() => {})));
  });

  test("constructor refuses a config with neither verificationToken nor encryptKey", () => {
    assert.throws(
      () => makeChannel({}),
      /verificationToken \(or encryptKey\) is required/,
    );
  });

  test("challenge with a wrong token → 403; right token → echoed", async () => {
    const ch = makeChannel({ token: TOKEN });
    const port = await start(ch);

    const bad = await post(port, JSON.stringify({ challenge: "abc", token: "WRONG" }));
    assert.equal(bad.status, 403);

    const ok = await post(port, JSON.stringify({ challenge: "abc", token: TOKEN }));
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { challenge: "abc" });
  });

  test("v2 event with missing/wrong header.token → 403", async () => {
    const ch = makeChannel({ token: TOKEN });
    const port = await start(ch);

    const event = {
      header: { event_type: "im.message.receive_v1", token: "WRONG" },
      event: { message: { message_id: "m1", message_type: "text", content: '{"text":"hi"}' }, sender: { sender_id: { open_id: "u" } } },
    };
    const r = await post(port, JSON.stringify(event));
    assert.equal(r.status, 403);

    const noToken = await post(
      port,
      JSON.stringify({ ...event, header: { event_type: "im.message.receive_v1" } }),
    );
    assert.equal(noToken.status, 403);
  });

  test("v2 event with the right header.token → 200", async () => {
    const ch = makeChannel({ token: TOKEN });
    const port = await start(ch);
    const event = {
      header: { event_type: "im.message.receive_v1", token: TOKEN },
      event: { message: { message_id: "m2", message_type: "text", content: '{"text":"hi"}' }, sender: { sender_id: { open_id: "u" } } },
    };
    const r = await post(port, JSON.stringify(event));
    assert.equal(r.status, 200);
  });

  test("encrypted mode verifies X-Lark-Signature and rejects forgeries", async () => {
    const ch = makeChannel({ encryptKey: ENCRYPT_KEY });
    const port = await start(ch);
    const body = encrypt({ challenge: "xyz" });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "n1";
    const goodSig = crypto
      .createHash("sha256")
      .update(ts + nonce + ENCRYPT_KEY + body)
      .digest("hex");

    const forged = await post(port, body, {
      "x-lark-signature": "deadbeef",
      "x-lark-request-timestamp": ts,
      "x-lark-request-nonce": nonce,
    });
    assert.equal(forged.status, 403);

    const ok = await post(port, body, {
      "x-lark-signature": goodSig,
      "x-lark-request-timestamp": ts,
      "x-lark-request-nonce": nonce,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { challenge: "xyz" });
  });

  test("encrypted mode rejects stale timestamps (replay window)", async () => {
    const ch = makeChannel({ encryptKey: ENCRYPT_KEY });
    const port = await start(ch);
    const body = encrypt({ challenge: "old" });
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    const nonce = "n2";
    const sig = crypto
      .createHash("sha256")
      .update(staleTs + nonce + ENCRYPT_KEY + body)
      .digest("hex");
    const r = await post(port, body, {
      "x-lark-signature": sig,
      "x-lark-request-timestamp": staleTs,
      "x-lark-request-nonce": nonce,
    });
    assert.equal(r.status, 403);
  });
});
