#!/usr/bin/env tsx
/**
 * LAN auth red-team (FOUNDATIONS §2.3). Verifies the RCE gate on a LIVE server:
 * every endpoint drives a full-tool agent, so a non-loopback request without the
 * token MUST be rejected. The decision logic is unit-tested (isRequestAuthorized
 * in src/web/auth.test.ts); this is the end-to-end check against a real bind.
 *
 * Usage:
 *   # one terminal — bind the LAN with a token:
 *   LISA_WEB_TOKEN=$(openssl rand -hex 24) lisa serve --web --host 0.0.0.0
 *   # another terminal — same LISA_WEB_TOKEN in env:
 *   LISA_WEB_TOKEN=<same> npx tsx scripts/redteam-lan.ts [--port 5757]
 *
 * Exit 0 = the gate holds (no-token LAN request rejected, correct-token allowed,
 * loopback bypass works). Exit 1 = a probe failed → a real hole.
 */
import os from "node:os";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function lanIPv4(): string | undefined {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return undefined;
}

async function status(url: string, headers: Record<string, string> = {}): Promise<number | string> {
  try {
    const r = await fetch(url, { headers });
    return r.status;
  } catch (e) {
    return `unreachable (${(e as Error).message})`;
  }
}

async function main(): Promise<void> {
  const port = arg("port") ?? "5757";
  const token = process.env.LISA_WEB_TOKEN?.trim();
  const lan = lanIPv4();
  const probe = "/api/island/ping"; // any endpoint — the gate is before routing

  if (!lan) {
    console.error("No non-loopback IPv4 interface found — can't simulate a LAN client. Connect to a network and retry.");
    process.exit(1);
  }
  console.log(`Red-teaming the LAN auth gate at ${lan}:${port}${probe}`);
  console.log(`(server must be running: lisa serve --web --host 0.0.0.0, with LISA_WEB_TOKEN set)\n`);

  const checks: Array<{ name: string; got: number | string; want: (s: number | string) => boolean; pass?: boolean }> = [];
  const lanBase = `http://${lan}:${port}`;

  // 1. LAN + no token → must be 401.
  checks.push({ name: "LAN request, no token → 401", got: await status(lanBase + probe), want: (s) => s === 401 });
  // 2. LAN + wrong token → must be 401.
  checks.push({ name: "LAN request, wrong token → 401", got: await status(lanBase + probe, { authorization: "Bearer wrong-token" }), want: (s) => s === 401 });
  // 3. LAN + correct token → must NOT be 401 (gate opens).
  if (token) {
    checks.push({ name: "LAN request, correct token → allowed", got: await status(lanBase + probe, { authorization: `Bearer ${token}` }), want: (s) => s !== 401 && typeof s === "number" });
  } else {
    console.log("  (skip correct-token check — set LISA_WEB_TOKEN in this shell to the server's token)\n");
  }
  // 4. Loopback + no token → must be allowed (the local user).
  checks.push({ name: "loopback, no token → allowed", got: await status(`http://127.0.0.1:${port}${probe}`), want: (s) => s !== 401 && typeof s === "number" });

  let ok = true;
  for (const c of checks) {
    c.pass = c.want(c.got);
    ok = ok && c.pass;
    console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}  (got ${c.got})`);
  }
  console.log(ok ? "\n✅ gate holds." : "\n❌ a probe failed — investigate before binding non-loopback.");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("redteam-lan failed:", e);
  process.exit(1);
});
