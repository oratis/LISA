import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  identity,
  keyId,
  LinkCipher,
  MAX_FRAME,
  verificationCode,
  type LinkIdentity,
  type SealedFrame,
} from "./protocol.js";
import { sendFrame } from "./broker.js";

interface Grant {
  id: string;
  publicKey: string;
  name: string;
  createdAt: number;
}
interface Stored {
  version: 1;
  enabled: boolean;
  uid: string;
  base: string;
  identity: LinkIdentity;
  grants: Grant[];
  lanPort?: number;
}
interface Pending extends Grant {
  code: string;
  expiresAt: number;
}
interface Channel {
  send: (frame: unknown) => void;
  close: () => void;
  /** Bytes queued on the socket carrying this channel (the relay uplink is shared). */
  buffered: () => number;
  cipher?: LinkCipher;
  deviceId?: string;
  challenge?: string;
  used?: boolean;
  request?: http.ClientRequest;
  deadline: NodeJS.Timeout;
  drain?: NodeJS.Timeout;
}
/** Per-transport cap, so idle LAN sockets can never starve the cloud route (or vice versa). */
const MAX_CHANNELS = 64;
/** Response bytes stop flowing into a socket above this queue and resume once it drains. */
const HIGH_WATER = 1024 * 1024;
const PAIRING_TTL = 10 * 60_000;
/** Pocket stamps expiresAt with its own clock (now + 60 s). Replay is already bound to
 * the channel's single-use challenge and 10 s request deadline, so tolerate phone/Mac
 * clock skew instead of failing every request as "interrupted". */
const CLOCK_SKEW = 5 * 60_000;
const REQUEST_TTL = 120_000;

export function cloudBase(raw: string): string {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("invalid_cloud_url");
  return url.origin;
}
function wsURL(base: string, route: string): string {
  const url = new URL(route, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
function loopback(addr: string): boolean {
  return addr === "::1" || addr === "127.0.0.1" || addr === "::ffff:127.0.0.1";
}

/** Mac-owned grants and keys; only ciphertext is exposed by the LAN listener. */
export class RemoteHost {
  private stored?: Stored;
  private session = "";
  private relay?: WebSocket;
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private lan?: http.Server;
  private lanSockets?: WebSocketServer;
  private generation = 0;
  private failures = 0;
  private readonly bridgeSecret = crypto.randomBytes(32).toString("hex");
  private readonly pending = new Map<string, Pending>();
  /** Requests the owner dismissed; a phone polling its pairing screen cannot re-raise them. */
  private readonly dismissed = new Map<string, number>();
  private readonly channels = new Map<string, Channel>();
  private readonly requests = new Map<string, number>();
  private online = false;
  private error = "";
  private readonly file: string;
  constructor(
    private readonly home: string,
    private readonly backendPort: number,
  ) {
    this.file = path.join(home, "remote-link.json");
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as Stored;
      if (value.version !== 1 || !Array.isArray(value.grants) || !value.uid || !value.base)
        throw new Error();
      keyId(value.identity.publicKey);
      this.stored = value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        this.error = "saved_connection_unavailable";
    }
  }
  private save(): void {
    if (!this.stored) return;
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.stored), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  async restore(base?: string, session?: string): Promise<void> {
    if (!this.stored?.enabled || !base || !session || cloudBase(base) !== this.stored.base) return;
    try {
      const claims = JSON.parse(Buffer.from(session.split(".")[1] ?? "", "base64url").toString());
      if (claims.uid !== this.stored.uid || claims.exp <= Date.now()) return;
    } catch {
      return;
    }
    // Previously approved LAN devices remain reachable during an internet outage.
    this.session = session;
    const generation = this.generation;
    await this.startLan();
    this.openRelay(generation);
  }
  async connect(rawBase: string, session: string): Promise<void> {
    const base = cloudBase(rawBase);
    if (!session) throw new Error("sign_in_required");
    this.stop();
    const generation = this.generation;
    // Resolve the authority from the server, never from unverified token claims.
    const response = await fetch(`${base}/api/auth/me`, {
      headers: { authorization: `Bearer ${session}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("sign_in_required");
    const me = (await response.json()) as { signedIn?: boolean; uid?: string };
    if (!me.signedIn || !me.uid) throw new Error("sign_in_required");
    if (generation !== this.generation) throw new Error("connection_cancelled");
    if (this.stored?.uid !== me.uid || this.stored.base !== base) {
      this.stored = {
        version: 1,
        enabled: true,
        uid: me.uid,
        base,
        identity: identity(),
        grants: [],
      };
    }
    this.stored.enabled = true;
    this.session = session;
    this.save();
    await this.startLan();
    this.openRelay(generation);
  }
  status() {
    this.expirePending();
    return {
      enabled: this.stored?.enabled ?? false,
      online: this.online,
      signedIn: !!this.session,
      name: os.hostname(),
      error: this.error,
      hostId: this.stored ? keyId(this.stored.identity.publicKey) : null,
      activeConnections: this.channels.size,
      pending: [...this.pending.values()].map(({ publicKey: _key, ...p }) => p),
      devices: this.stored?.grants.map(({ publicKey: _key, ...d }) => d) ?? [],
    };
  }
  approve(id: string, code: string): void {
    this.expirePending();
    const pending = this.pending.get(id);
    if (
      !this.stored?.enabled ||
      !pending ||
      pending.code !== code ||
      this.stored.grants.length >= 20
    )
      throw new Error("pairing_expired");
    this.stored.grants = this.stored.grants.filter((g) => g.id !== id);
    this.stored.grants.push({
      id,
      publicKey: pending.publicKey,
      name: pending.name,
      createdAt: Date.now(),
    });
    this.save();
    this.pending.delete(id);
  }
  revoke(id: string): void {
    const pending = this.pending.get(id);
    if (pending) this.dismissed.set(id, pending.expiresAt);
    this.pending.delete(id);
    if (this.stored) {
      this.stored.grants = this.stored.grants.filter((g) => g.id !== id);
      this.save();
    }
    for (const [key, channel] of this.channels) if (channel.deviceId === id) this.closeChannel(key);
  }
  disable(): void {
    if (this.stored) {
      this.stored.enabled = false;
      this.save();
    }
    this.stop();
    this.session = "";
  }
  /** A marker can only DOWNGRADE loopback to a remote caller, never grant local-owner powers. */
  remoteAddress(req: http.IncomingMessage): string {
    return req.headers["x-lisa-link"] !== undefined
      ? "remote-link"
      : (req.socket.remoteAddress ?? "");
  }
  authorized(req: http.IncomingMessage): boolean {
    const marker = req.headers["x-lisa-link"];
    return (
      loopback(req.socket.remoteAddress ?? "") &&
      typeof marker === "string" &&
      Buffer.byteLength(marker) === Buffer.byteLength(this.bridgeSecret) &&
      crypto.timingSafeEqual(Buffer.from(marker), Buffer.from(this.bridgeSecret)) &&
      !!this.stored?.enabled &&
      !!this.stored.grants.find((g) => g.id === req.headers["x-lisa-link-device"])
    );
  }
  private expirePending(): void {
    for (const [id, p] of this.pending) if (p.expiresAt < Date.now()) this.pending.delete(id);
    for (const [id, until] of this.dismissed) if (until < Date.now()) this.dismissed.delete(id);
  }
  private channelCount(kind: "lan" | "cloud"): number {
    let n = 0;
    for (const id of this.channels.keys()) if (id.startsWith(`${kind}:`)) n++;
    return n;
  }
  private async startLan(): Promise<void> {
    const generation = this.generation;
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME,
      perMessageDeflate: false,
    });
    this.lan = server;
    this.lanSockets = wss;
    server.on("upgrade", (req, socket, head) => {
      socket.on("error", () => {});
      if (req.url !== "/link" || req.headers.origin || this.channelCount("lan") >= MAX_CHANNELS) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const id = `lan:${crypto.randomUUID()}`;
        ws.on("error", () => {});
        this.newChannel(
          id,
          (frame) => sendFrame(ws, frame),
          () => ws.close(),
          () => ws.bufferedAmount,
        );
        ws.on("message", (data) => {
          try {
            this.receive(id, JSON.parse(data.toString()), false);
          } catch {
            this.closeChannel(id);
          }
        });
        ws.on("close", () => this.closeChannel(id));
      });
    });
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", () => {
          server.off("error", reject);
          resolve();
        });
      });
    try {
      await listen(this.stored?.lanPort ?? 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      await listen(0);
    }
    if (generation !== this.generation) {
      wss.close();
      server.close();
      throw new Error("connection_cancelled");
    }
    const address = server.address();
    if (this.stored && address && typeof address !== "string") {
      this.stored.lanPort = address.port;
      this.save();
    }
  }
  private lanURLs(): string[] {
    const address = this.lan?.address();
    if (!address || typeof address === "string") return [];
    return Object.entries(os.networkInterfaces())
      .filter(([name]) => /^en\d|^eth\d|^wlan\d/.test(name))
      .flatMap(([, entries]) =>
        (entries ?? [])
          .filter((e) => e.family === "IPv4" && !e.internal)
          .map((e) => `ws://${e.address}:${address.port}/link`),
      )
      .slice(0, 4);
  }
  private openRelay(generation: number): void {
    if (generation !== this.generation || !this.stored?.enabled) return;
    const ws = new WebSocket(wsURL(this.stored.base, "/api/relay/host"), {
      headers: { authorization: `Bearer ${this.session}` },
      maxPayload: MAX_FRAME,
      handshakeTimeout: 10_000,
      followRedirects: false,
      perMessageDeflate: false,
    });
    this.relay = ws;
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("open", () => {
      sendFrame(ws, {
        type: "register",
        publicKey: this.stored!.identity.publicKey,
        name: os.hostname(),
      });
      this.heartbeat = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 20_000);
      this.heartbeat.unref();
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") {
          this.online = true;
          this.error = "";
          this.failures = 0;
          return;
        }
        if (typeof msg.channel !== "string" || msg.channel.length > 64) throw new Error();
        const id = `cloud:${msg.channel}`;
        if (msg.type === "close") {
          this.closeChannel(id);
          return;
        }
        if (msg.type !== "frame") throw new Error();
        if (!this.channels.has(id))
          this.newChannel(
            id,
            (payload) => sendFrame(ws, { type: "frame", channel: msg.channel, payload }),
            () => sendFrame(ws, { type: "close", channel: msg.channel }),
            () => ws.bufferedAmount,
          );
        this.receive(id, msg.payload, true);
      } catch {
        /* An invalid phone frame closes only that channel in receive(). */
      }
    });
    ws.on("error", () => {
      this.error = "relay_unreachable";
    });
    ws.on("unexpected-response", (_request, response) => {
      this.error = response.statusCode === 403 ? "sign_in_required" : "relay_unavailable";
      response.resume();
      ws.terminate();
      if (response.statusCode === 403) this.disable();
    });
    ws.on("close", () => {
      if (generation !== this.generation) return;
      this.online = false;
      clearInterval(this.heartbeat);
      for (const id of this.channels.keys()) if (id.startsWith("cloud:")) this.closeChannel(id);
      // Backoff with jitter; no requests are replayed on reconnect.
      this.reconnect = setTimeout(
        () => this.openRelay(generation),
        Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)) + Math.random() * 500,
      );
      this.reconnect.unref();
    });
  }
  private newChannel(
    id: string,
    send: Channel["send"],
    close: Channel["close"],
    buffered: Channel["buffered"],
  ): void {
    if (this.channelCount(id.startsWith("lan:") ? "lan" : "cloud") >= MAX_CHANNELS) {
      close();
      return;
    }
    this.channels.set(id, {
      send,
      close,
      buffered,
      deadline: setTimeout(() => this.closeChannel(id), 10_000),
    });
  }
  private closeChannel(id: string): void {
    const c = this.channels.get(id);
    if (!c) return;
    this.channels.delete(id);
    clearTimeout(c.deadline);
    clearTimeout(c.drain);
    c.request?.destroy();
    c.close();
  }
  private receive(id: string, frame: Record<string, unknown>, fromCloud: boolean): void {
    const c = this.channels.get(id);
    if (!c || !this.stored?.enabled) return;
    try {
      if (!c.cipher) {
        if (
          frame.type !== "hello" ||
          typeof frame.publicKey !== "string" ||
          typeof frame.salt !== "string"
        )
          throw new Error();
        c.deviceId = keyId(frame.publicKey);
        const grant = this.stored.grants.find((g) => g.id === c.deviceId);
        if (!grant && !fromCloud) throw new Error(); // LAN cannot create pairing prompts.
        c.cipher = new LinkCipher(this.stored.identity, frame.publicKey, frame.salt, "host");
        const code = verificationCode(this.stored.identity.publicKey, frame.publicKey);
        this.expirePending();
        if (
          !grant &&
          frame.pair === true &&
          !this.pending.has(c.deviceId) &&
          !this.dismissed.has(c.deviceId)
        ) {
          if (this.pending.size >= 10) throw new Error();
          this.pending.set(c.deviceId, {
            id: c.deviceId,
            publicKey: frame.publicKey,
            name: typeof frame.name === "string" ? frame.name.slice(0, 80) : "Lisa Pocket",
            code,
            createdAt: Date.now(),
            expiresAt: Date.now() + PAIRING_TTL,
          });
        }
        c.challenge = crypto.randomBytes(32).toString("base64");
        c.send(
          c.cipher.seal({
            type: "welcome",
            authorized: !!grant,
            code,
            challenge: c.challenge,
            lanURLs: grant ? this.lanURLs() : [],
          }),
        );
        return;
      }
      if (!this.stored.grants.some((g) => g.id === c.deviceId) || c.used) throw new Error();
      const message = c.cipher.open(frame as unknown as SealedFrame);
      if (
        message.type !== "request" ||
        message.challenge !== c.challenge ||
        typeof message.id !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(message.id) ||
        typeof message.expiresAt !== "number" ||
        !Number.isFinite(message.expiresAt) ||
        message.expiresAt < Date.now() - CLOCK_SKEW ||
        message.expiresAt > Date.now() + REQUEST_TTL + CLOCK_SKEW
      )
        throw new Error();
      for (const [key, expiry] of this.requests) if (expiry < Date.now()) this.requests.delete(key);
      if (this.requests.has(message.id) || this.requests.size >= 10_000) throw new Error();
      this.requests.set(message.id, Date.now() + REQUEST_TTL + 2 * CLOCK_SKEW);
      c.used = true;
      clearTimeout(c.deadline);
      c.deadline = setTimeout(() => this.closeChannel(id), 55 * 60_000);
      this.forward(id, c, message);
    } catch {
      this.closeChannel(id);
    }
  }
  private forward(id: string, c: Channel, msg: Record<string, unknown>): void {
    const route = typeof msg.path === "string" ? msg.path : "";
    const method = typeof msg.method === "string" ? msg.method : "";
    // Fixed loopback target, canonical relative path, no supplied headers or URLs.
    if (
      !/^(\/api\/|\/assets\/(?:lisa|visuals)\/|\/chat(?:\?|$)|\/events(?:\?|$))/.test(route) ||
      route.length > 4096 ||
      route.includes("\\") ||
      /[\r\n#]/.test(route) ||
      new URL(route, "http://mac").pathname !== route.split("?")[0] ||
      route.startsWith("/api/remote/") ||
      route.startsWith("/api/relay/") ||
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)
    ) {
      this.closeChannel(id);
      return;
    }
    const body = typeof msg.body === "string" ? Buffer.from(msg.body, "base64") : Buffer.alloc(0);
    if (body.length > 512 * 1024) {
      this.closeChannel(id);
      return;
    }
    const send = (value: unknown) => {
      if (!this.stored?.grants.some((g) => g.id === c.deviceId)) {
        this.closeChannel(id);
        return;
      }
      c.send(c.cipher!.seal(value));
    };
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: this.backendPort,
        path: route,
        method,
        agent: false,
        headers: {
          "x-lisa-link": this.bridgeSecret,
          "x-lisa-link-device": c.deviceId!,
          "content-type": "application/json",
          "content-length": body.length,
        },
      },
      (response) => {
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "x-lisa-api-version"]) {
          const value = response.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        send({ type: "headers", status: response.statusCode, headers });
        // Flow control: loopback produces bytes far faster than a phone or relay
        // drains them. Queue frames per channel, write only while the carrying
        // socket is below HIGH_WATER, and pause the local response meanwhile, so
        // a large body never trips sendFrame's overflow guard on the shared uplink.
        const queue: Buffer[] = [];
        let ended = false;
        const flush = () => {
          c.drain = undefined;
          while (queue.length && c.buffered() < HIGH_WATER && this.channels.get(id) === c)
            send({ type: "chunk", body: queue.shift()!.toString("base64") });
          if (this.channels.get(id) !== c) return;
          if (queue.length) {
            response.pause();
            c.drain = setTimeout(flush, 20);
          } else if (ended) {
            send({ type: "end" });
            this.closeChannel(id);
          } else response.resume();
        };
        response.on("data", (chunk: Buffer) => {
          for (let i = 0; i < chunk.length; i += 32 * 1024)
            queue.push(chunk.subarray(i, i + 32 * 1024));
          if (!c.drain) flush();
        });
        response.on("end", () => {
          ended = true;
          if (!c.drain) flush();
        });
        response.on("error", () => this.closeChannel(id));
      },
    );
    c.request = request;
    request.on("error", () => this.closeChannel(id));
    request.end(body);
  }
  stop(): void {
    ++this.generation;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.relay?.terminate();
    for (const id of this.channels.keys()) this.closeChannel(id);
    this.pending.clear();
    for (const ws of this.lanSockets?.clients ?? []) ws.terminate();
    this.lanSockets?.close();
    this.lan?.close();
    this.lan = undefined;
    this.online = false;
  }
}
