import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parsePairArgs, detectLanHost, buildPairUrl } from "./pair.js";
import type os from "node:os";

describe("parsePairArgs", () => {
  test("defaults: port 5757, name 'phone', host undefined", () => {
    const prevPort = process.env.LISA_WEB_PORT;
    delete process.env.LISA_WEB_PORT;
    assert.deepEqual(parsePairArgs([]), { host: undefined, port: 5757, name: "phone" });
    if (prevPort !== undefined) process.env.LISA_WEB_PORT = prevPort;
  });

  test("--host / --port / --name (space and = forms)", () => {
    assert.deepEqual(parsePairArgs(["--host", "mac.tailnet.ts.net", "--port", "6000", "--name", "iPhone"]), {
      host: "mac.tailnet.ts.net",
      port: 6000,
      name: "iPhone",
    });
    assert.deepEqual(parsePairArgs(["--host=10.0.0.5", "--port=8080", "--name=Pixel"]), {
      host: "10.0.0.5",
      port: 8080,
      name: "Pixel",
    });
  });

  test("missing value / bad port / unknown arg → error", () => {
    assert.ok("error" in parsePairArgs(["--host"]));
    assert.ok("error" in parsePairArgs(["--port", "0"]));
    assert.ok("error" in parsePairArgs(["--port", "abc"]));
    assert.ok("error" in parsePairArgs(["--nope"]));
  });
});

describe("detectLanHost", () => {
  test("returns the first non-internal IPv4", () => {
    const ifaces = {
      lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
      en0: [
        { family: "IPv6", internal: false, address: "fe80::1" },
        { family: "IPv4", internal: false, address: "192.168.1.42" },
      ],
    } as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    assert.equal(detectLanHost(ifaces), "192.168.1.42");
  });

  test("only loopback → undefined", () => {
    const ifaces = {
      lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    } as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    assert.equal(detectLanHost(ifaces), undefined);
  });
});

describe("buildPairUrl", () => {
  test("encodes host/port/token/name into a lisa-pair:// v1 URL", () => {
    const url = buildPairUrl("192.168.1.42", 5757, "abc123", "my phone");
    const u = new URL(url);
    assert.equal(u.protocol, "lisa-pair:");
    assert.equal(u.searchParams.get("host"), "192.168.1.42");
    assert.equal(u.searchParams.get("port"), "5757");
    assert.equal(u.searchParams.get("token"), "abc123");
    assert.equal(u.searchParams.get("name"), "my phone"); // spaces survive a round-trip
  });

  test("the app's pairing parser can read it back (host/token/port)", () => {
    // Mirrors AppState.applyPairing: read query items, fall back to URL parts.
    const url = buildPairUrl("10.0.0.5", 6000, "tok-XYZ", "iPad");
    const u = new URL(url);
    assert.equal(u.searchParams.get("host"), "10.0.0.5");
    assert.equal(Number(u.searchParams.get("port")), 6000);
    assert.equal(u.searchParams.get("token"), "tok-XYZ");
  });
});
