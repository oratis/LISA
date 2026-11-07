import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import { RemoteHost } from "../src/remote/host.js";
const sessionFile = process.env.LISA_RELAY_TEST_SESSION_FILE;
if (!sessionFile)
  throw new Error(
    "Set LISA_RELAY_TEST_SESSION_FILE to a protected file containing a test account session",
  );
const token = fs.readFileSync(sessionFile, "utf8").trim();
const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const body = { token, uid: claims.uid };
const base = process.env.LISA_RELAY_TEST_ORIGIN ?? "https://cloud.meetlisa.ai";
fs.mkdirSync(".tmp/release", { recursive: true, mode: 0o700 });
const home = fs.mkdtempSync(".tmp/release/live-host-");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const control = crypto.randomBytes(24).toString("hex");
const remote = new RemoteHost(home, 18789);
type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
let lanUpgrade: UpgradeHandler | undefined;
const api = http.createServer((req, res) => {
  void handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.headers["x-fixture-control"] === control) {
    let raw = "";
    for await (const part of req) raw += part;
    if (req.url === "/approve") {
      const code = JSON.parse(raw).code;
      const p = remote.status().pending.find((x) => x.code === code);
      if (!p) {
        res.writeHead(409);
        res.end();
        return;
      }
      remote.approve(p.id, p.code);
    } else if (req.url === "/lan/off") {
      for (const ws of remote["lanSockets"]?.clients ?? []) ws.terminate();
      const lan = remote["lan"];
      if (!lan) throw new Error("LAN fixture is unavailable");
      lanUpgrade ??= lan.listeners("upgrade")[0] as UpgradeHandler;
      lan.removeAllListeners("upgrade");
      lan.on("upgrade", (_req: http.IncomingMessage, socket: Duplex) => socket.destroy());
    } else if (req.url === "/lan/on") {
      if (lanUpgrade) {
        const lan = remote["lan"];
        if (!lan) throw new Error("LAN fixture is unavailable");
        lan.removeAllListeners("upgrade");
        lan.on("upgrade", lanUpgrade);
        lanUpgrade = undefined;
      }
    }
    res.end("{}");
    return;
  }
  if (!remote.authorized(req)) {
    res.writeHead(403);
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, remote: remote.remoteAddress(req) }));
}
await new Promise<void>((r) => api.listen(18789, "127.0.0.1", r));
await remote.connect(base, body.token);
for (let n = 0; n < 60 && !remote.status().online; n++)
  await new Promise((r) => setTimeout(r, 1000));
if (!remote.status().online) throw new Error("Relay did not connect: " + remote.status().error);
const saved = JSON.parse(fs.readFileSync(home + "/remote-link.json", "utf8"));
const config = {
  target: {
    id: remote.status().hostId,
    name: "Release validation Mac",
    publicKey: saved.identity.publicKey,
    cloudOrigin: base,
    accountUID: body.uid,
  },
  token: body.token,
  control,
  controlURL: "http://127.0.0.1:18789",
};
fs.writeFileSync(".tmp/release/live-fixture.json", JSON.stringify(config), { mode: 0o600 });
console.log("Production relay host online; fixture ready");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    remote.disable();
    api.close();
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(0);
  });
