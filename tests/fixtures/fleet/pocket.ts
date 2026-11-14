/** A Pocket protocol client against the real encrypted relay and LAN listeners in integration tests. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  identity,
  keyId,
  LinkCipher,
  pairingCommitment,
  pairingNonce,
} from "../../../src/remote/protocol.js";

export function pocket(home: string, token: string) {
  const device = identity();
  async function channel(pair = false, lan = false) {
    const stored = JSON.parse(fs.readFileSync(path.join(home, "remote-link.json"), "utf8"));
    const key = stored.identity.publicKey;
    const salt = crypto.randomBytes(32).toString("base64");
    const cipher = new LinkCipher(device, key, salt, "client");
    const nonce = pairingNonce();
    const relay = new URL("/api/relay/client", stored.base);
    relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
    relay.searchParams.set("host", keyId(key));
    const ws = lan
      ? new WebSocket(`ws://127.0.0.1:${stored.lanPort}/link`)
      : new WebSocket(relay, { headers: { authorization: "Bearer " + token } });
    const queue: string[] = [];
    let ended = false,
      wake = () => {};
    ws.on("message", (data) => {
      queue.push(data.toString());
      wake();
    });
    ws.on("close", () => {
      ended = true;
      wake();
    });
    ws.on("error", () => {
      ended = true;
      wake();
    });
    const next = async () => {
      const deadline = Date.now() + 5000;
      while (!queue.length) {
        if (ended || Date.now() > deadline) throw Error("link_closed");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      return cipher.open(JSON.parse(queue.shift()!));
    };
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        type: "hello",
        publicKey: device.publicKey,
        salt,
        name: "Test Pocket",
        v: 2,
        pair,
        ...(pair ? { commit: pairingCommitment(key, device.publicKey, nonce) } : {}),
      }),
    );
    const welcome = await next();
    return { ws, cipher, nonce, welcome, next };
  }
  return {
    deviceId: keyId(device.publicKey),
    async pair() {
      const c = await channel(true);
      try {
        c.ws.send(JSON.stringify(c.cipher.seal({ type: "pair", nonce: c.nonce })));
        return String((await c.next()).code);
      } finally {
        c.ws.close();
      }
    },
    async read<T>(route: string, method = "GET", lan = false) {
      const c = await channel(false, lan);
      try {
        if (!c.welcome.authorized) throw Error("not_paired");
        c.ws.send(
          JSON.stringify(
            c.cipher.seal({
              type: "request",
              id: crypto.randomUUID(),
              challenge: c.welcome.challenge,
              expiresAt: Date.now() + 60000,
              method,
              path: route,
              body: "",
            }),
          ),
        );
        let status = 0;
        const chunks: Buffer[] = [];
        while (true) {
          const msg = await c.next();
          if (msg.type === "headers") status = Number(msg.status);
          if (msg.type === "chunk") chunks.push(Buffer.from(String(msg.body), "base64"));
          if (msg.type === "end")
            return { status, data: JSON.parse(Buffer.concat(chunks).toString()) as T };
        }
      } finally {
        c.ws.close();
      }
    },
  };
}
