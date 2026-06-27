import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type os from "node:os";
import { detectLanHost, buildPairUrl, interfaceRank } from "./pairing.js";

const v4 = (address: string, internal = false): os.NetworkInterfaceInfo =>
  ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null } as os.NetworkInterfaceInfo);

describe("interfaceRank", () => {
  test("en* beats unknown beats VPN/virtual beats awdl", () => {
    assert.ok(interfaceRank("en0") > interfaceRank("foo0"));
    assert.ok(interfaceRank("foo0") > interfaceRank("utun3"));
    assert.ok(interfaceRank("utun3") > interfaceRank("awdl0"));
    assert.equal(interfaceRank("bridge100"), interfaceRank("vmnet1"));
  });
});

describe("detectLanHost", () => {
  test("returns the first non-internal IPv4", () => {
    const ifaces = {
      lo0: [v4("127.0.0.1", true)],
      en0: [v4("192.168.1.42")],
    };
    assert.equal(detectLanHost(ifaces), "192.168.1.42");
  });

  test("prefers en0 (Wi-Fi) over a VPN tunnel that enumerates first", () => {
    const ifaces = {
      utun0: [v4("10.99.0.2")], // VPN — listed first but not LAN-routable
      en0: [v4("192.168.1.42")],
    };
    assert.equal(detectLanHost(ifaces), "192.168.1.42");
  });

  test("skips link-local (169.254) and AWDL", () => {
    const ifaces = {
      awdl0: [v4("169.254.1.1")],
      en0: [v4("192.168.0.5")],
    };
    assert.equal(detectLanHost(ifaces), "192.168.0.5");
  });

  test("only loopback → undefined", () => {
    assert.equal(detectLanHost({ lo0: [v4("127.0.0.1", true)] }), undefined);
  });
});

describe("buildPairUrl", () => {
  test("encodes host/port/token/name into a lisa-pair:// v1 URL with %20 spaces", () => {
    const url = buildPairUrl("192.168.1.42", 5757, "abc123", "my phone");
    assert.match(url, /^lisa-pair:\/\/v1\?/);
    assert.match(url, /host=192\.168\.1\.42/);
    assert.match(url, /port=5757/);
    assert.match(url, /token=abc123/);
    assert.match(url, /name=my%20phone/);
    assert.doesNotMatch(url, /\+/);
  });
});
