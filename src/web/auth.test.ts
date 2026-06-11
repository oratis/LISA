import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackAddress } from "./server.js";

describe("isLoopbackAddress — the web auth gate's loopback check", () => {
  test("accepts v4, v6, and v4-mapped-v6 loopback forms", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("127.0.0.53"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("localhost"), true);
  });

  test("rejects LAN / public / unspecified addresses", () => {
    assert.equal(isLoopbackAddress("192.168.1.20"), false);
    assert.equal(isLoopbackAddress("10.0.0.5"), false);
    assert.equal(isLoopbackAddress("0.0.0.0"), false);
    assert.equal(isLoopbackAddress("::"), false);
    assert.equal(isLoopbackAddress("::ffff:192.168.1.20"), false);
    assert.equal(isLoopbackAddress("8.8.8.8"), false);
    assert.equal(isLoopbackAddress(""), false);
  });

  test("does not treat 127-prefixed non-loopback as loopback", () => {
    // 1271.x / 12.7.x style lookalikes must not pass.
    assert.equal(isLoopbackAddress("1271.0.0.1"), false);
    assert.equal(isLoopbackAddress("12.70.0.1"), false);
  });
});
