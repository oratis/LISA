import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { lanConnectionURLs } from "./host.js";

const entry = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  internal,
  family: "IPv4",
  netmask: "255.255.255.0",
  mac: "00:00:00:00:00:00",
  cidr: `${address}/24`,
});

test("LAN discovery accepts macOS and predictable Linux ethernet and Wi-Fi names", () => {
  for (const name of ["en0", "eth0", "wlan0", "enp0s3", "ens5", "eno1", "wlp2s0"]) {
    assert.deepEqual(
      lanConnectionURLs({ [name]: [entry("192.168.1.2")] }, 1234),
      ["ws://192.168.1.2:1234/link"],
      name,
    );
  }
});

test("LAN discovery excludes virtual, internal and IPv6 interfaces and caps invitations", () => {
  assert.deepEqual(
    lanConnectionURLs(
      {
        lo0: [entry("127.0.0.1", true)],
        utun0: [entry("10.0.0.1")],
        docker0: [entry("172.17.0.1")],
        tailscale0: [entry("100.64.0.1")],
        en0: [entry("127.0.0.1", true), { ...entry("::1"), family: "IPv6", scopeid: 0 }],
      },
      1234,
    ),
    [],
  );
  assert.equal(
    lanConnectionURLs(
      { en0: Array.from({ length: 6 }, (_, i) => entry(`192.168.1.${i + 1}`)) },
      1234,
    ).length,
    4,
  );
});
