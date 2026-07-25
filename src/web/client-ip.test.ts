import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveClientIp } from "./client-ip.js";

describe("trusted proxy client IP resolution", () => {
  test("ignores forwarding headers by default", () => {
    assert.equal(
      resolveClientIp(
        { "x-forwarded-for": "198.51.100.1" },
        "10.0.0.5",
        {},
      ),
      "10.0.0.5",
    );
  });

  test("one trusted proxy resolves the rightmost forwarded address", () => {
    assert.equal(
      resolveClientIp(
        { "x-forwarded-for": "203.0.113.10" },
        "10.0.0.5",
        { LISA_TRUST_PROXY_HOPS: "1" },
      ),
      "203.0.113.10",
    );
  });

  test("a caller-prepended fake first hop is not selected", () => {
    assert.equal(
      resolveClientIp(
        { "x-forwarded-for": "198.51.100.99, 203.0.113.10" },
        "10.0.0.5",
        { LISA_TRUST_PROXY_HOPS: "1" },
      ),
      "203.0.113.10",
    );
  });

  test("multiple trusted hops are explicit and invalid chains fail closed", () => {
    assert.equal(
      resolveClientIp(
        { "x-forwarded-for": "203.0.113.10, 10.0.0.4" },
        "10.0.0.5",
        { LISA_TRUST_PROXY_HOPS: "2" },
      ),
      "203.0.113.10",
    );
    assert.equal(
      resolveClientIp(
        { "x-forwarded-for": "attacker, 203.0.113.10" },
        "10.0.0.5",
        { LISA_TRUST_PROXY_HOPS: "1" },
      ),
      "10.0.0.5",
    );
    assert.equal(
      resolveClientIp(
        { "x-forwarded-for": "203.0.113.10" },
        "10.0.0.5",
        { LISA_TRUST_PROXY_HOPS: "999" },
      ),
      "10.0.0.5",
    );
  });
});
