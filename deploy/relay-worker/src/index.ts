import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

type Account = { uid: string; expiresAt: number };
type HostInfo = { id: string; name: string; publicKey: string; online: true };
type Attachment = Account & {
  token: string;
  role: "host" | "client";
  opened: number;
  checked: number;
  host?: HostInfo;
  hostID?: string;
  channel?: string;
};
const MAX_FRAME = 1024 * 1024;
const RECHECK_MS = 15_000;

function error(status: number, reason: string): Response {
  return Response.json({ error: reason }, { status, headers: { "cache-control": "no-store" } });
}

/** Trust only the existing account service's answer, never unsigned token claims. */
async function authenticate(token: string, origin: string): Promise<Account | null> {
  if (token.length > 4096 || !/^s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  let claims: { uid?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return null;
  }
  if (
    typeof claims.uid !== "string" ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= Date.now()
  )
    return null;
  const response = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "LISA-Relay/1" },
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const body = await response.json<{ signedIn?: boolean; uid?: string }>();
  return body.signedIn === true && typeof body.uid === "string" && body.uid === claims.uid
    ? { uid: body.uid, expiresAt: claims.exp }
    : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!["/api/relay/macs", "/api/relay/host", "/api/relay/client"].includes(path))
      return error(404, "not_found");
    if (request.method !== "GET" || request.headers.has("Origin") || url.searchParams.has("token"))
      return error(403, "native_session_required");
    if (path !== "/api/relay/macs" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return error(426, "websocket_required");
    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    let account: Account | null;
    try {
      account = await authenticate(token, env.AUTH_ORIGIN);
    } catch {
      return error(503, "account_service_unavailable");
    }
    if (!account) return error(403, "account_session_required");
    // Every edge/revision deterministically reaches the same account actor.
    const relay = env.ACCOUNTS.getByName(account.uid);
    if (path === "/api/relay/macs") {
      return Response.json(
        { hosts: await relay.list() },
        { headers: { "cache-control": "no-store" } },
      );
    }
    // WebSocket responses use the native fetch channel; RPC cannot serialize sockets.
    const headers = new Headers({
      Upgrade: "websocket",
      Authorization: `Bearer ${token}`,
      "X-Relay-Account": JSON.stringify(account),
    });
    return relay.fetch(
      new Request(
        `https://relay.internal${path}?host=${encodeURIComponent(url.searchParams.get("host") ?? "")}`,
        { headers },
      ),
    );
  },
} satisfies ExportedHandler<Env>;

/** Socket attachments survive hibernation. No keys, messages or account tokens go to SQL. */
export class AccountRelay extends DurableObject<Env> {
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }
  private attachment(ws: WebSocket): Attachment {
    return ws.deserializeAttachment() as Attachment;
  }
  private host(id: string): WebSocket | undefined {
    return this.sockets().find(
      (ws) => this.attachment(ws).role === "host" && this.attachment(ws).host?.id === id,
    );
  }
  list(): HostInfo[] {
    return this.sockets().flatMap((ws) => {
      const a = this.attachment(ws);
      return a.host && a.expiresAt > Date.now() && a.checked + 30_000 > Date.now() ? [a.host] : [];
    });
  }
  async fetch(request: Request): Promise<Response> {
    // This actor is reachable only through the binding. The outer Worker creates
    // fresh headers after authenticating; caller-supplied identity is never forwarded.
    const account = JSON.parse(request.headers.get("X-Relay-Account") ?? "null") as Account;
    const token = (request.headers.get("Authorization") ?? "").slice(7);
    const url = new URL(request.url);
    const role = url.pathname === "/api/relay/host" ? "host" : "client";
    const hostID = url.searchParams.get("host") ?? "";
    if (!account || !account.uid || account.expiresAt <= Date.now())
      return error(403, "account_session_required");
    if (this.sockets().length >= 80) return error(429, "account_capacity");
    if (
      role === "host" &&
      this.sockets().filter((ws) => this.attachment(ws).role === "host").length >= 10
    )
      return error(429, "host_capacity");
    if (role === "client") {
      if (!/^[a-f0-9]{32}$/.test(hostID) || !this.host(hostID)) return error(503, "mac_offline");
      if (this.sockets().filter((ws) => this.attachment(ws).hostID === hostID).length >= 64)
        return error(429, "host_capacity");
    }
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);
    ws.serializeAttachment({
      ...account,
      token,
      role,
      opened: Date.now(),
      checked: Date.now(),
      ...(role === "client" ? { hostID, channel: crypto.randomUUID() } : {}),
    } satisfies Attachment);
    // Storage input gate serializes admission; always retain the earliest pending check.
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + RECHECK_MS)
      await this.ctx.storage.setAlarm(Date.now() + RECHECK_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private send(ws: WebSocket, value: unknown): void {
    try {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > MAX_FRAME) {
        this.close(ws, 1009, "frame_too_large");
        return;
      }
      ws.send(text);
    } catch {
      this.close(ws, 1011, "send_failed");
    }
  }
  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    this.cleanup(ws);
  }
  private cleanup(ws: WebSocket): void {
    const a = this.attachment(ws);
    // Clear the attachment's routing fields before recursively closing peers.
    ws.serializeAttachment({ ...a, host: undefined, hostID: undefined, channel: undefined });
    if (a.host) {
      for (const client of this.sockets()) {
        if (this.attachment(client).hostID === a.host.id) this.close(client, 1013, "mac_offline");
      }
    } else if (a.hostID && a.channel) {
      const host = this.host(a.hostID);
      if (host) this.send(host, { type: "close", channel: a.channel });
    }
  }
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    const a = this.attachment(ws);
    if (a.expiresAt <= Date.now() || a.checked + 30_000 < Date.now()) {
      this.close(ws, 1008, "session_expired");
      return;
    }
    if ((typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength) > MAX_FRAME) {
      this.close(ws, 1009, "frame_too_large");
      return;
    }
    try {
      const text =
        typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
      const msg = JSON.parse(text);
      if (!msg || typeof msg !== "object") throw new Error();
      if (a.role === "host") {
        if (!a.host) {
          if (
            msg.type !== "register" ||
            typeof msg.name !== "string" ||
            typeof msg.publicKey !== "string" ||
            !/^[A-Za-z0-9+/]{43}=$/.test(msg.publicKey)
          )
            throw new Error();
          const id = createHash("sha256")
            .update(Buffer.from(msg.publicKey, "base64"))
            .digest("hex")
            .slice(0, 32);
          if (this.host(id)) throw new Error();
          a.host = { id, name: msg.name.slice(0, 80), publicKey: msg.publicKey, online: true };
          ws.serializeAttachment(a);
          this.send(ws, { type: "registered", id });
        } else {
          const client = this.sockets().find((peer) => {
            const c = this.attachment(peer);
            return c.role === "client" && c.hostID === a.host!.id && c.channel === msg.channel;
          });
          if (!client) return;
          if (msg.type === "frame") this.send(client, msg.payload);
          else if (msg.type === "close") this.close(client, 1000, "complete");
          else throw new Error();
        }
      } else {
        const host = a.hostID ? this.host(a.hostID) : undefined;
        if (!host) {
          this.close(ws, 1013, "mac_offline");
          return;
        }
        const envelope = { type: "frame", channel: a.channel, payload: msg };
        // Measure the serialized envelope: parsing numbers/escapes can expand JSON.
        // An oversized phone must not close the shared Mac uplink.
        if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_FRAME) {
          this.close(ws, 1009, "frame_too_large");
          return;
        }
        this.send(host, envelope);
      }
    } catch {
      this.close(ws, 1008, "invalid_message");
    }
  }
  webSocketClose(ws: WebSocket): void {
    this.close(ws, 1000, "closed");
  }
  webSocketError(ws: WebSocket): void {
    this.close(ws, 1011, "connection_failed");
  }
  async alarm(): Promise<void> {
    // One validation per distinct token, regardless of the number of REST/SSE channels.
    const sockets = this.sockets();
    const tokens = [...new Set(sockets.map((ws) => this.attachment(ws).token))];
    const checked = await Promise.all(
      tokens.map(async (token) => {
        try {
          return [token, await authenticate(token, this.env.AUTH_ORIGIN)] as const;
        } catch {
          return [token, null] as const;
        }
      }),
    );
    const accounts = new Map(checked);
    for (const ws of sockets) {
      const a = this.attachment(ws);
      const account = accounts.get(a.token);
      if (
        !account ||
        account.uid !== a.uid ||
        a.expiresAt <= Date.now() ||
        (a.role === "host" && !a.host && a.opened + 5000 < Date.now())
      ) {
        this.close(ws, 1008, "session_expired");
      } else {
        ws.serializeAttachment({ ...a, checked: Date.now() });
      }
    }
    if (this.sockets().length) await this.ctx.storage.setAlarm(Date.now() + RECHECK_MS);
  }
}
