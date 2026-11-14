import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-devices-"));
process.env.LISA_HOME = TMP;
const FILE = path.join(TMP, "devices.json");

const {
  mintDevice,
  verifyDeviceToken,
  touchDevice,
  listDevices,
  revokeDevice,
  loadDevices,
  trackDeviceResponse,
} = await import("./devices.js");

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

describe("device tokens", () => {
  test("mint → verify matches; wrong / empty token → null", () => {
    const { id, token } = mintDevice("iPhone", "ios");
    assert.equal(verifyDeviceToken(token)?.id, id);
    assert.equal(verifyDeviceToken("wrong"), null);
    assert.equal(verifyDeviceToken(""), null);
  });

  test("the raw token is never persisted — only its hash", () => {
    const { token } = mintDevice("x", "ios");
    const raw = fs.readFileSync(FILE, "utf8");
    assert.equal(raw.includes(token), false);
    assert.match(raw, /tokenHash/);
  });

  test(
    "the token-hash store is written private (0600), like config.env",
    { skip: process.platform === "win32" },
    () => {
      mintDevice("x", "ios");
      assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
    },
  );

  test("revoke → token no longer verifies; revoking an unknown id → false", () => {
    const { id, token } = mintDevice("x", "ios");
    assert.ok(verifyDeviceToken(token));
    assert.equal(revokeDevice(id), true);
    assert.equal(verifyDeviceToken(token), null);
    assert.equal(revokeDevice("nope"), false);
  });

  test("revoke closes that device's tracked responses, and only those still open", () => {
    const a = mintDevice("A", "ios");
    const b = mintDevice("B", "ios");
    const closed: string[] = [];
    trackDeviceResponse(a.id, () => closed.push("a-events"));
    const untrack = trackDeviceResponse(a.id, () => closed.push("a-finished"));
    trackDeviceResponse(b.id, () => closed.push("b-events"));
    untrack(); // that response already ended
    assert.equal(revokeDevice(a.id), true);
    assert.deepEqual(closed, ["a-events"]);
    // Once is enough: a second revoke finds nothing left to close.
    assert.equal(revokeDevice(a.id), false);
    assert.deepEqual(closed, ["a-events"]);
  });

  test("listDevices excludes the hash; touch updates lastSeenAt", () => {
    const { id } = mintDevice("x", "ios", 1000);
    const [pub] = listDevices();
    assert.equal("tokenHash" in pub, false);
    assert.equal(pub.lastSeenAt, 1000);
    touchDevice(id, 5000);
    assert.equal(listDevices()[0].lastSeenAt, 5000);
  });

  test("multiple devices: each token maps to its own record", () => {
    const a = mintDevice("A", "ios");
    const b = mintDevice("B", "android");
    assert.equal(verifyDeviceToken(a.token)?.id, a.id);
    assert.equal(verifyDeviceToken(b.token)?.id, b.id);
    assert.equal(loadDevices().length, 2);
  });

  test("corrupt file → empty list (no throw)", () => {
    fs.writeFileSync(FILE, "{not json");
    assert.deepEqual(loadDevices(), []);
  });
});
