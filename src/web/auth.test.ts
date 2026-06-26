import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackAddress, isRequestAuthorized } from "./server.js";

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

describe("isRequestAuthorized — the RCE gate (red-team)", () => {
  const TOKEN = "s3cret-web-token";

  test("loopback is always allowed, token or not", () => {
    assert.equal(isRequestAuthorized("127.0.0.1", null, null), true);
    assert.equal(isRequestAuthorized("::1", TOKEN, null), true);
    assert.equal(isRequestAuthorized("::ffff:127.0.0.1", null, "anything"), true);
  });

  test("a LAN request with NO token is rejected", () => {
    assert.equal(isRequestAuthorized("192.168.1.20", TOKEN, null), false);
    assert.equal(isRequestAuthorized("10.0.0.5", TOKEN, ""), false);
  });

  test("a LAN request with the WRONG token is rejected", () => {
    assert.equal(isRequestAuthorized("192.168.1.20", TOKEN, "guess"), false);
    assert.equal(isRequestAuthorized("192.168.1.20", TOKEN, TOKEN + "x"), false);
  });

  test("no token configured ⇒ NO non-loopback request can pass", () => {
    assert.equal(isRequestAuthorized("192.168.1.20", null, "anything"), false);
    assert.equal(isRequestAuthorized("8.8.8.8", null, null), false);
  });

  test("a LAN request with the correct token is allowed", () => {
    assert.equal(isRequestAuthorized("192.168.1.20", TOKEN, TOKEN), true);
  });

  // Cloud edition: loopback is NOT a free pass — the container must not trust
  // its own/proxy loopback, so trustLoopback=false forces a token everywhere.
  test("trustLoopback=false (cloud) makes loopback require the token", () => {
    assert.equal(isRequestAuthorized("127.0.0.1", TOKEN, null, false), false);
    assert.equal(isRequestAuthorized("::1", TOKEN, "wrong", false), false);
    assert.equal(isRequestAuthorized("127.0.0.1", TOKEN, TOKEN, false), true);
    // default (Mac edition) still trusts loopback
    assert.equal(isRequestAuthorized("127.0.0.1", TOKEN, null), true);
  });
});
