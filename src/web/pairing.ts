/**
 * Pairing helpers shared by the CLI (`lisa pair`), the web server's
 * `/api/pair/start`, and (by mirroring) the Mac menu-bar app. Dependency-free so
 * the always-loaded web server can reuse it without pulling in the CLI's
 * `qrcode-terminal`. See docs/IOS_COMPANION_PLAN.md §5.3.
 */
import os from "node:os";

/**
 * Rank a network interface by how likely a phone on the same Wi-Fi can reach it.
 * Mirrors the Mac app's PairController.interfaceRank: real Ethernet/Wi-Fi (`en*`)
 * beats unknowns, which beat VPN/virtual/Internet-Sharing, which beat Apple
 * wireless-direct (`awdl`/`llw`, up but not LAN-routable).
 */
export function interfaceRank(name: string): number {
  if (name.startsWith("awdl") || name.startsWith("llw")) return 0; // not routable
  for (const p of ["utun", "ipsec", "ppp", "bridge", "vmnet", "vnic", "tap", "tun"]) {
    if (name.startsWith(p)) return 1; // VPN / virtualization / Internet Sharing
  }
  if (name.startsWith("en")) return 3; // Ethernet / Wi-Fi — what we want
  return 2; // unknown: beats VPN, loses to en*
}

/**
 * Best-guess LAN IPv4 for a phone to reach this Mac. Prefers `en*` interfaces and
 * skips link-local (169.254). Among equal ranks the first interface wins (en0
 * before en1), so a stable, reachable address surfaces. Pure (interfaces injected
 * for tests).
 */
export function detectLanHost(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | undefined {
  let best: { rank: number; ip: string } | undefined;
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254")) continue; // link-local
      const rank = interfaceRank(name);
      // Strictly-greater keeps the first interface at each rank as the tiebreak.
      if (!best || rank > best.rank) best = { rank, ip: a.address };
    }
  }
  return best?.ip;
}

/** Build the `lisa-pair://` deep-link the phone scans/pastes. Pure. */
export function buildPairUrl(host: string, port: number, token: string, name: string): string {
  // %20 (not "+") for spaces so the device label round-trips through iOS URLComponents.
  const q = new URLSearchParams({ host, port: String(port), token, name }).toString().replace(/\+/g, "%20");
  return `lisa-pair://v1?${q}`;
}
