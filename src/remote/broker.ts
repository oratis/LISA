import crypto from "node:crypto";
import type http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { keyId, MAX_BUFFER, MAX_FRAME, RELAY_PING, RELAY_PONG, type HostInfo } from "./protocol.js";

export type RelayAccount = { uid: string; expiresAt: number };
type Host = { socket: WebSocket; info: HostInfo; clients: Map<string, WebSocket> };
export function sendFrame(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFER) {
    socket.terminate();
    return;
  }
  socket.send(JSON.stringify(value));
}

/** Ephemeral routing only. The broker never receives device secrets or HTTP plaintext.
 * Run ONE relay instance; horizontal replicas need an explicit routing layer. */
export class RelayBroker {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    perMessageDeflate: false,
  });
  private readonly hosts = new Map<string, Host>();
  private readonly connections = new Map<
    WebSocket,
    { token: string; account: RelayAccount; alive: boolean }
  >();
  private readonly timer: NodeJS.Timeout;
  private checking = false;
  constructor(
    server: http.Server,
    private readonly authenticate: (token: string) => Promise<RelayAccount | null>,
  ) {
    server.on("upgrade", (req, socket, head) => {
      socket.on("error", () => {});
      void (async () => {
        const url = new URL(req.url ?? "/", "http://relay");
        const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        // Native Bearer clients only: neither cookies, URL tokens nor browser origins.
        let account: RelayAccount | null | false;
        try {
          account = !req.headers.origin && (await authenticate(token));
        } catch {
          // The account service is down: retryable, never a sign-out (403).
          socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          return;
        }
        if (!account || !["/api/relay/host", "/api/relay/client"].includes(url.pathname)) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        if (
          this.connections.size >= 256 ||
          [...this.connections.values()].filter((c) => c.account.uid === account.uid).length >= 80
        ) {
          socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.connections.set(ws, { token, account, alive: true });
          ws.on("error", () => {});
          ws.on("pong", () => {
            const c = this.connections.get(ws);
            if (c) c.alive = true;
          });
          ws.on("close", () => this.connections.delete(ws));
          if (url.pathname === "/api/relay/host") this.host(ws, account.uid);
          else this.client(ws, account.uid, url.searchParams.get("host") ?? "");
        });
      })().catch(() => socket.destroy());
    });
    this.timer = setInterval(() => {
      void this.checkConnections();
    }, 15_000);
    this.timer.unref();
    server.on("close", () => this.close());
  }
  list(uid: string): HostInfo[] {
    return [...this.hosts.entries()]
      .filter(([key]) => key.startsWith(`${uid}:`))
      .map(([, host]) => host.info);
  }
  private async checkConnections(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const [ws, c] of this.connections) {
        if (!c.alive || c.account.expiresAt <= Date.now()) {
          ws.terminate();
          continue;
        }
        c.alive = false;
        try {
          if (!(await this.authenticate(c.token))) {
            ws.terminate();
            continue;
          }
        } catch {
          ws.terminate();
          continue;
        }
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }
    } finally {
      this.checking = false;
    }
  }
  private host(ws: WebSocket, uid: string): void {
    let registered: Host | undefined;
    let key = "";
    const deadline = setTimeout(() => {
      if (!registered) ws.terminate();
    }, 5_000);
    ws.on("message", (data) => {
      try {
        const text = data.toString();
        // Same answer as the Cloudflare relay's WebSocket auto-response.
        if (text === RELAY_PING) {
          if (ws.readyState === WebSocket.OPEN) ws.send(RELAY_PONG);
          return;
        }
        const msg = JSON.parse(text);
        if (!registered) {
          if (msg.type !== "register" || typeof msg.name !== "string") throw new Error();
          const id = keyId(msg.publicKey);
          key = `${uid}:${id}`;
          // The same Mac reconnecting (after sleep or a network change) replaces the
          // socket it left behind. Only this account can register here, and a host
          // without the private key cannot complete any phone's handshake.
          const stale = this.hosts.get(key);
          if (!stale && this.list(uid).length >= 10) throw new Error();
          if (stale) {
            this.hosts.delete(key);
            stale.socket.terminate();
          }
          registered = {
            socket: ws,
            info: { id, publicKey: msg.publicKey, name: msg.name.slice(0, 80), online: true },
            clients: new Map(),
          };
          this.hosts.set(key, registered);
          clearTimeout(deadline);
          sendFrame(ws, { type: "registered", id });
        } else {
          const client = registered.clients.get(msg.channel);
          if (!client) return;
          if (msg.type === "frame") sendFrame(client, msg.payload);
          else if (msg.type === "close") client.close(1000);
          else throw new Error();
        }
      } catch {
        ws.close(1008, "invalid_message");
      }
    });
    ws.on("close", () => {
      clearTimeout(deadline);
      if (registered && this.hosts.get(key) === registered) this.hosts.delete(key);
      for (const client of registered?.clients.values() ?? []) client.close(1013, "mac_offline");
    });
  }
  private client(ws: WebSocket, uid: string, id: string): void {
    const host = this.hosts.get(`${uid}:${id}`);
    if (!host || host.clients.size >= 64) {
      ws.close(1013, "mac_offline");
      return;
    }
    const channel = crypto.randomUUID();
    host.clients.set(channel, ws);
    ws.on("message", (data) => {
      try {
        sendFrame(host.socket, { type: "frame", channel, payload: JSON.parse(data.toString()) });
      } catch {
        ws.close(1008, "invalid_message");
      }
    });
    ws.on("close", () => {
      host.clients.delete(channel);
      sendFrame(host.socket, { type: "close", channel });
    });
  }
  close(): void {
    clearInterval(this.timer);
    for (const ws of this.connections.keys()) ws.terminate();
    this.connections.clear();
    this.hosts.clear();
    this.wss.close();
  }
  revokeAccount(uid: string): void {
    for (const [ws, c] of this.connections) if (c.account.uid === uid) ws.terminate();
  }
}
