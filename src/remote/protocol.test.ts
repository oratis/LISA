import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  identity,
  keyId,
  LinkCipher,
  pairingCode,
  pairingCommitment,
  pairingNonce,
  verificationCode,
} from "./protocol.js";

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

// Shared with RemoteMacTests.swift (CryptoKit must derive the same values).
const HOST = "KrJrgJEp9nhDoI/3HXlFlO1Mm1ai02/ctyxk+Ybl9RE=";
const CLIENT = "2ktl0gKyLFDz+RxC+xSJZJan3hmcEZGlJpN5aHyx+VQ=";
const NP = Buffer.alloc(32, 1).toString("base64");
const NM = Buffer.alloc(32, 2).toString("base64");

test("pairing v2 vectors: commitment and code are fixed functions of both keys and both nonces", () => {
  assert.equal(verificationCode(HOST, CLIENT), "4743 E65C 73A8");
  assert.equal(pairingCommitment(HOST, CLIENT, NP), "DSe7C3jhbYZodmP6aO0RbluFgaefJv9IVQQ1g/fN/j8=");
  assert.equal(pairingCode(HOST, CLIENT, NP, NM), "1657 5A0B 6CB6");
  // Every input matters, including which Mac key the phone believed in.
  const other = identity().publicKey;
  for (const changed of [
    pairingCommitment(other, CLIENT, NP),
    pairingCommitment(HOST, other, NP),
    pairingCommitment(HOST, CLIENT, NM),
  ])
    assert.notEqual(changed, pairingCommitment(HOST, CLIENT, NP));
  for (const changed of [
    pairingCode(HOST, CLIENT, NM, NM),
    pairingCode(HOST, CLIENT, NP, NP),
    pairingCode(other, CLIENT, NP, NM),
  ])
    assert.notEqual(changed, pairingCode(HOST, CLIENT, NP, NM));
  assert.throws(() => pairingCommitment(HOST, CLIENT, "short"), /invalid_nonce/);
  assert.match(pairingNonce(), /^[A-Za-z0-9+/]{43}=$/);
});

test("probe: the v1 code depends on the keys alone, so a relay can grind a match offline", () => {
  // Truncated to 16 bits so the birthday search takes milliseconds; the full 48-bit
  // code needs ~2^24 keygens per side (minutes on one core) and nothing more.
  const short = (code: string) => code.slice(0, 4);
  const mac = identity().publicKey;
  const phone = identity().publicKey;
  // The relay shows the phone a fake Mac key, and the real Mac a fake phone key.
  const phoneSees = new Map<string, string>();
  for (let i = 0; i < 2048; i++) {
    const fakeMac = identity().publicKey;
    phoneSees.set(short(verificationCode(fakeMac, phone)), fakeMac);
  }
  let found = false;
  for (let i = 0; i < 2048 && !found; i++) {
    const fakePhone = identity().publicKey;
    const fakeMac = phoneSees.get(short(verificationCode(mac, fakePhone)));
    if (fakeMac)
      found = short(verificationCode(fakeMac, phone)) === short(verificationCode(mac, fakePhone));
  }
  assert.ok(found, "v1: substitute keys with matching codes exist and are cheap to find");
  // v2 also hashes nonces that are fixed only after each side has committed, so no table
  // can be built in advance. host.test.ts runs the same relay against the real Mac.
});
