import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { identity, keyId, LinkCipher, verificationCode } from "./protocol.js";

test("directions interoperate; ciphertext hides content and rejects replay, reflection and tampering", () => {
  const mac = identity(),
    phone = identity(),
    salt = crypto.randomBytes(32).toString("base64");
  const host = new LinkCipher(mac, phone.publicKey, salt, "host");
  const client = new LinkCipher(phone, mac.publicKey, salt, "client");
  const request = client.seal({ secret: "private user message" });
  assert.ok(!JSON.stringify(request).includes("private user message"));
  assert.throws(() => client.open(request));
  assert.deepEqual(host.open(request), { secret: "private user message" });
  assert.throws(() => host.open(request));
  const response = host.seal({ status: 200 });
  const damaged = Buffer.from(response.box, "base64");
  damaged[14] ^= 1;
  assert.throws(() => client.open({ ...response, box: damaged.toString("base64") }));
  assert.deepEqual(client.open(response), { status: 200 });
  const wrongPeer = new LinkCipher(identity(), mac.publicKey, salt, "client");
  assert.throws(() => wrongPeer.open(host.seal({ secret: "only the authorized phone" })));
  assert.match(keyId(mac.publicKey), /^[a-f0-9]{32}$/);
  assert.match(
    verificationCode(mac.publicKey, phone.publicKey),
    /^[A-F0-9]{4} [A-F0-9]{4} [A-F0-9]{4}$/,
  );
});

test("fresh connection salts and invalid X25519 keys cannot reuse a channel", () => {
  const a = identity(),
    b = identity();
  const first = new LinkCipher(a, b.publicKey, crypto.randomBytes(32).toString("base64"), "host");
  const second = new LinkCipher(
    b,
    a.publicKey,
    crypto.randomBytes(32).toString("base64"),
    "client",
  );
  assert.throws(() => second.open(first.seal({ hello: true })));
  assert.throws(() => new LinkCipher(a, Buffer.alloc(32).toString("base64"), b.publicKey, "host"));
  assert.throws(() => keyId("bad-key"));
});
