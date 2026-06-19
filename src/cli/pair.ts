/**
 * `lisa pair` — mint a per-device token and show a scannable QR so a phone pairs
 * without hand-typing host/token (docs/IOS_COMPANION_PLAN.md §5.3). This is the
 * Mac-side counterpart to Lisa Pocket's QR scanner.
 *
 * A thin client to a running `lisa serve --web` (loopback, like `lisa agents
 * pty`): it POSTs /api/pair/start — which is loopback-only and mints a per-device
 * token, returned ONCE — then builds a `lisa-pair://` URL and renders it as a
 * terminal QR. The token rides in the QR (and the printed URL fallback); the
 * phone then authenticates with it like any device token.
 */
// qrcode-terminal is CommonJS — Node's ESM loader only exposes its default
// export, so import the module object and call .generate off it.
import qrcodeTerminal from "qrcode-terminal";
import os from "node:os";

const DEFAULT_PORT = 5757;

export interface PairArgs {
  /** Host the phone will reach the Mac at (LAN IP or tailnet name). */
  host?: string;
  /** Port of the running serve (loopback target + encoded for the phone). */
  port: number;
  /** Device label stored alongside the minted token. */
  name: string;
}

const USAGE = "usage: lisa pair [--host <ip-or-tailnet>] [--port N] [--name <label>]";

/** Parse `lisa pair` argv. Pure (no I/O). */
export function parsePairArgs(argv: string[]): PairArgs | { error: string } {
  let host: string | undefined;
  let port = Number(process.env.LISA_WEB_PORT) || DEFAULT_PORT;
  let name = "phone";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const valOf = (flag: string): string | undefined =>
      a === flag ? argv[++i] : a.startsWith(flag + "=") ? a.slice(flag.length + 1) : undefined;
    if (a === "--host" || a.startsWith("--host=")) {
      const v = valOf("--host");
      if (!v) return { error: "--host needs a value (an IP or tailnet name)" };
      host = v;
    } else if (a === "--port" || a.startsWith("--port=")) {
      const v = valOf("--port");
      if (!v) return { error: "--port needs a value" };
      port = Number(v);
    } else if (a === "--name" || a.startsWith("--name=")) {
      const v = valOf("--name");
      if (!v) return { error: "--name needs a value" };
      name = v;
    } else {
      return { error: `unknown argument "${a}"\n${USAGE}` };
    }
  }
  if (!Number.isInteger(port) || port <= 0) return { error: "--port must be a positive integer" };
  return { host, port, name };
}

/** First non-internal IPv4 — a reasonable default host when --host is omitted. Pure. */
export function detectLanHost(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | undefined {
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

/** Build the `lisa-pair://` deep-link the phone scans/pastes. Pure. */
export function buildPairUrl(host: string, port: number, token: string, name: string): string {
  const q = new URLSearchParams({ host, port: String(port), token, name });
  return `lisa-pair://v1?${q.toString()}`;
}

export async function runPairCommand(argv: string[]): Promise<number> {
  const parsed = parsePairArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const { port, name } = parsed;
  const host = parsed.host ?? detectLanHost();
  if (!host) {
    console.error("Couldn't detect a LAN IP — pass --host <ip-or-tailnet-name>.");
    return 1;
  }

  const base = `http://127.0.0.1:${port}`;
  let res: Response;
  try {
    res = await fetch(`${base}/api/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, platform: "ios" }),
    });
  } catch (err) {
    console.error(
      `Could not reach LISA at ${base} — is \`lisa serve --web\` running? (${(err as Error).message})`,
    );
    return 1;
  }
  if (res.status === 403) {
    console.error("Pairing can only be started on the Mac itself (localhost).");
    return 1;
  }
  if (!res.ok) {
    console.error(`pair failed (${res.status}): ${(await res.text().catch(() => "")).trim()}`);
    return 1;
  }

  const body = (await res.json().catch(() => ({}))) as { token?: string; id?: string; port?: number };
  if (!body.token) {
    console.error("server returned no token");
    return 1;
  }
  const url = buildPairUrl(host, body.port ?? port, body.token, name);

  console.log(`\nScan in Lisa Pocket → Settings → Scan QR code:\n`);
  await new Promise<void>((resolve) => qrcodeTerminal.generate(url, { small: true }, () => resolve()));
  console.log(`\nOr paste this in Settings → Pair:\n  ${url}\n`);
  console.log(`Paired device "${name}" (id ${body.id ?? "?"}). Revoke it later from the app or POST /api/devices/revoke.`);
  console.log(
    `The phone must reach http://${host}:${port} — run serve with --host 0.0.0.0 on the same Wi-Fi, or use a Tailscale name as --host.`,
  );
  return 0;
}
