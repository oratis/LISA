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
  nonceBytes,
  PAIRING_VERSION,
  pairingCode,
  pairingCommitment,
  pairingNonce,
  RELAY_PING,
  RELAY_PONG,
  verificationCode,
  type LinkIdentity,
  type SealedFrame,
} from "./protocol.js";
import { sendFrame } from "./broker.js";

import {
  fleetRoute,
  fleetViewRoute,
  type FleetGrant,
  type FleetPeer,
  type FleetViewer,
} from "./fleet/types.js";

interface Grant {
  fleet?: FleetGrant;
  id: string;
  publicKey: string;
  name: string;
  createdAt: number;
  /** 2: approved after a committed (v2) code comparison. Absent: v1, the weaker method. */
  pairing?: 2;
  pairingId?: string;
}
interface Stored {
  version: 1;
  enabled: boolean;
  uid: string;
  base: string;
  identity: LinkIdentity;
  grants: Grant[];
  lanPort?: number;
  /** Refuse NEW v1 pairings (Pocket 1.3 and earlier). Existing grants keep working. */
  requireSecurePairing?: boolean;
}
interface Pending {
  fleet?: boolean;
  id: string;
  publicKey: string;
  name: string;
  createdAt: number;
  /** Fixed when the request is created; new commitments never extend it. */
  expiresAt: number;
  /** The code to compare. v2: empty until the phone opens a commitment; never approvable before. */
  code: string;
  protocol: 1 | 2;
  /** The device is already allowed: its phone is (re)verifying this Mac's key. */
  known: boolean;
  /** v2: the opened commitment that produced `code`, and its Mac nonce. */
  commit?: string;
  nonce?: string;
  /** v2: the latest commitment not yet opened, and the Mac nonce offered against it. A
   * hello proves nothing about its key, so it can never replace an opened commitment. */
  offer?: { commit: string; nonce: string };
  /** v2: Mac nonces issued for this request. Counted at issue, not at opening: a relay
   * learns its candidate code as soon as it sees Nm, so every Nm is one guess. */
  rounds: number;
}
interface Channel {
  send: (frame: unknown) => void;
  close: () => void;
  /** Bytes queued on the socket carrying this channel (the relay uplink is shared). */
  buffered: () => number;
  cipher?: LinkCipher;
  deviceId?: string;
  challenge?: string;
  /** v2 pairing: the commitment and Mac nonce this channel's welcome answered. */
  commit?: string;
  nonce?: string;
  name?: string;
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
/** Each new commitment for one request gets a fresh Mac nonce, i.e. one more 2^-48 guess
 * for a key-substituting relay. A legitimate phone needs one (two if it is restarted). */
const MAX_PAIRING_ROUNDS = 5;
/** Pocket stamps expiresAt with its own clock (now + 60 s). Replay is already bound to
 * the channel's single-use challenge and 10 s request deadline, so tolerate phone/Mac
 * clock skew instead of failing every request as "interrupted". */
const CLOCK_SKEW = 5 * 60_000;
const REQUEST_TTL = 120_000;
const HEARTBEAT_MS = 20_000;

/** The unverified expiry of a session token, for display only (the relay decides). */
function sessionExpiry(session: string): number | undefined {
  try {
    const claims = JSON.parse(Buffer.from(session.split(".")[1] ?? "", "base64url").toString());
    return typeof claims.exp === "number" ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

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
  /** Last v1 pairing refused by requireSecurePairing, so the Mac can explain it. */
  private legacyRefused?: { name: string; at: number };
  private readonly file: string;
  /**
   * Told when an agent-host device loses its grant or gets a new one, so the
   * executor stops that device's agents outside what it may still control.
   */
  onFleetGrantChange?: (deviceId: string, grant: FleetGrant | undefined) => void;
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
      if (claims.uid !== this.stored.uid) return;
    } catch {
      return;
    }
    // Previously approved LAN devices remain reachable during an internet outage, and
    // after the session expires: they hold grants from this Mac, not from the account.
    // The relay keeps being retried; status() tells the owner to sign in again.
    this.session = session;
    if (this.sessionExpired()) this.error = "sign_in_required";
    const generation = this.generation;
    await this.startLan();
    this.openRelay(generation);
  }
  async connect(rawBase: string, session: string): Promise<void> {
    const base = cloudBase(rawBase);
    if (!session) throw new Error("sign_in_required");
    // Validate before tearing anything down: when the cloud is unreachable, the LAN
    // listener and the relay retry loop that are already running must keep running.
    const generation = this.generation;
    // Resolve the authority from the server, never from unverified token claims.
    const response = await fetch(`${base}/api/auth/me`, {
      headers: { authorization: `Bearer ${session}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        response.status === 401 || response.status === 403
          ? "sign_in_required"
          : "cloud_unavailable",
      );
    }
    const me = (await response.json()) as { signedIn?: boolean; uid?: string };
    if (!me.signedIn || !me.uid) throw new Error("sign_in_required");
    // A disconnect or another connect finished meanwhile: it wins.
    if (generation !== this.generation) throw new Error("connection_cancelled");
    this.stop();
    this.error = "";
    if (this.stored?.uid !== me.uid || this.stored.base !== base) {
      // A different account starts with no grants. Agents its devices started stop.
      for (const g of this.stored?.grants ?? [])
        if (g.fleet) this.onFleetGrantChange?.(g.id, undefined);
      this.stored = {
        version: 1,
        enabled: true,
        uid: me.uid,
        base,
        identity: identity(),
        grants: [],
        // A security preference, not account state: keep it across a reset.
        ...(this.stored?.requireSecurePairing ? { requireSecurePairing: true } : {}),
      };
    }
    this.stored.enabled = true;
    this.session = session;
    this.failures = 0;
    this.save();
    await this.startLan();
    this.openRelay(this.generation);
  }
  /**
   * A renewed session for the same account (see session-renewal.ts): use it from now
   * on and move the relay onto it before the old one expires. A host that is not
   * running a session (never connected, or turned off) ignores it; restore() and
   * connect() read the saved session when they start.
   */
  setSession(session: string): void {
    if (!session || !this.session || session === this.session || !this.stored?.enabled) return;
    try {
      const claims = JSON.parse(Buffer.from(session.split(".")[1] ?? "", "base64url").toString());
      if (claims.uid !== this.stored.uid) return;
    } catch {
      return;
    }
    this.session = session;
    if (this.error === "sign_in_required" && !this.sessionExpired()) this.error = "";
    const old = this.relay;
    if (!old) return; // restore() is still starting LAN; it opens the relay with this session.
    // Retire the current socket (its handlers check this.relay) and reconnect now.
    this.relay = undefined;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    old.terminate();
    this.online = false;
    for (const id of this.channels.keys()) if (id.startsWith("cloud:")) this.closeChannel(id);
    this.failures = 0;
    this.openRelay(this.generation);
  }
  /** The session's own expiry has passed: only signing in again brings the relay back. */
  private sessionExpired(): boolean {
    const exp = this.session ? sessionExpiry(this.session) : undefined;
    return exp !== undefined && exp <= Date.now();
  }
  status() {
    this.expirePending();
    return {
      enabled: this.stored?.enabled ?? false,
      online: this.online,
      signedIn: !!this.session,
      sessionExpired: this.sessionExpired(),
      name: os.hostname(),
      error: this.error,
      hostId: this.stored ? keyId(this.stored.identity.publicKey) : null,
      activeConnections: this.channels.size,
      pairingVersion: PAIRING_VERSION,
      requireSecurePairing: this.stored?.requireSecurePairing ?? false,
      legacyRefused:
        this.legacyRefused && this.legacyRefused.at + PAIRING_TTL > Date.now()
          ? this.legacyRefused
          : null,
      // `secure` describes this Mac's side only: false marks the v1 code, which a
      // key-substituting relay can forge. `waiting` requests have no code yet and hold
      // one of the ten slots; the owner can clear them.
      pending: [...this.pending.values()].map(
        ({ id, name, code, createdAt, expiresAt, protocol, known, fleet }) => ({
          id,
          name,
          code,
          createdAt,
          expiresAt,
          secure: protocol === 2,
          known,
          waiting: !code,
          ...(fleet ? { fleet: true } : {}),
        }),
      ),
      devices:
        this.stored?.grants.map(({ id, name, createdAt, pairing, fleet }) => ({
          id,
          name,
          createdAt,
          secure: pairing === 2,
          ...(fleet ? { fleet } : {}),
        })) ?? [],
    };
  }
  approve(id: string, code: string, fleet?: FleetGrant): void {
    this.expirePending();
    const pending = this.pending.get(id);
    const others = this.stored?.grants.filter((g) => g.id !== id) ?? [];
    if (
      !this.stored?.enabled ||
      !pending ||
      !pending.code ||
      pending.code !== code ||
      !!pending.fleet !== !!fleet ||
      (!!fleet && pending.protocol !== 2) ||
      this.stored.grants.some((g) => g.id === id && !!g.fleet !== !!fleet) ||
      others.length >= 20 ||
      (pending.protocol === 1 && this.stored.requireSecurePairing)
    )
      throw new Error("pairing_expired");
    this.stored.grants = [
      ...others,
      {
        id,
        publicKey: pending.publicKey,
        ...(fleet ? { fleet } : {}),
        name: pending.name,
        createdAt: Date.now(),
        pairingId: crypto.randomUUID(),
        ...(pending.protocol === 2 ? { pairing: 2 as const } : {}),
      },
    ];
    this.save();
    this.pending.delete(id);
    if (fleet) this.onFleetGrantChange?.(id, fleet);
  }
  /** Owner policy. requireSecurePairing refuses new v1 pairings; existing grants stay. */
  setPolicy(policy: Record<string, unknown>): void {
    if (!this.stored || typeof policy.requireSecurePairing !== "boolean")
      throw new Error("invalid_policy");
    this.stored.requireSecurePairing = policy.requireSecurePairing;
    if (policy.requireSecurePairing) {
      for (const [id, p] of this.pending) if (p.protocol === 1) this.pending.delete(id);
    } else this.legacyRefused = undefined;
    this.save();
  }
  /** Drop a pairing request (and keep it from coming back for its lifetime) without
   * touching any grant: clearing a re-pair prompt must not disconnect the device. */
  dismiss(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.dismissed.set(id, pending.expiresAt);
    this.pending.delete(id);
  }
  revoke(id: string): void {
    const pending = this.pending.get(id);
    if (pending) this.dismissed.set(id, pending.expiresAt);
    this.pending.delete(id);
    if (this.stored) {
      const revoked = this.stored.grants.find((g) => g.id === id);
      this.stored.grants = this.stored.grants.filter((g) => g.id !== id);
      this.save();
      if (revoked?.fleet) this.onFleetGrantChange?.(id, undefined);
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
  fleetPeer(req: http.IncomingMessage): FleetPeer | undefined {
    if (!this.authorized(req) || !this.stored) return;
    const grant = this.stored.grants.find((g) => g.id === req.headers["x-lisa-link-device"]);
    if (grant?.fleet && grant.pairing === 2)
      return { ...grant.fleet, deviceId: grant.id, hostId: keyId(this.stored.identity.publicKey) };
  }
  pocketDevice(id: string): FleetViewer | undefined {
    if (!this.stored?.enabled) return;
    const grant = this.stored.grants.find((g) => g.id === id);
    if (grant?.pairing === 2 && !grant.fleet)
      return {
        deviceId: grant.id,
        hostId: keyId(this.stored.identity.publicKey),
        pairingId: grant.pairingId ?? `legacy:${grant.createdAt}`,
      };
  }
  fleetViewer(req: http.IncomingMessage): FleetViewer | undefined {
    if (!this.authorized(req)) return;
    return this.pocketDevice(String(req.headers["x-lisa-link-device"]));
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
    // The most specific reason this attempt failed; the generic `error` event that
    // follows an aborted handshake must not replace it.
    let failure = "";
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("open", () => {
      sendFrame(ws, {
        type: "register",
        publicKey: this.stored!.identity.publicKey,
        name: os.hostname(),
        // This Mac sends RELAY_PING; a relay may drop it when the pings stop.
        heartbeat: true,
      });
      this.heartbeat = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        if (ws.readyState !== WebSocket.OPEN) return;
        // A protocol ping proves the TCP path; the application ping also proves, to a
        // hibernating relay, that this Mac is still there (a sleeping Mac stops both).
        ws.ping();
        ws.send(RELAY_PING);
      }, HEARTBEAT_MS);
      this.heartbeat.unref();
    });
    ws.on("message", (data) => {
      try {
        const text = data.toString();
        if (text === RELAY_PONG) {
          alive = true;
          return;
        }
        const msg = JSON.parse(text);
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
      if (generation !== this.generation || this.relay !== ws) return;
      this.error = failure || "relay_unreachable";
    });
    ws.on("unexpected-response", (_request, response) => {
      // 403: the relay refused this account session (expired, revoked, or an account
      // service hiccup on an older relay). Phone connections stay ON and the relay
      // keeps being retried; only the owner turns them off, and signing in again
      // (connect) replaces the session. LAN devices keep working meanwhile.
      failure = response.statusCode === 403 ? "sign_in_required" : "relay_unavailable";
      if (generation === this.generation && this.relay === ws) this.error = failure;
      response.resume();
      ws.terminate();
    });
    ws.on("close", () => {
      // A newer socket replaced this one (setSession) or the host stopped.
      if (generation !== this.generation || this.relay !== ws) return;
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
        this.hello(c, frame, fromCloud);
        return;
      }
      const message = c.cipher.open(frame as unknown as SealedFrame);
      if (message.type === "cancel") {
        // The phone's user tapped Cancel. Only the holder of this device key can seal
        // this, so its request goes: the Mac can no longer approve a code the user
        // never confirmed. Not dismissed, so the phone can pair again later; grants
        // are untouched.
        this.pending.delete(c.deviceId!);
        this.closeChannel(id);
        return;
      }
      if (c.used) throw new Error();
      if (message.type === "pair") {
        this.reveal(c, message);
        return;
      }
      if (!this.stored.grants.some((g) => g.id === c.deviceId)) throw new Error();
      if (
        message.type !== "request" ||
        message.challenge !== c.challenge ||
        typeof message.id !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(message.id) ||
        typeof message.expiresAt !== "number" ||
        !Number.isFinite(message.expiresAt)
      )
        throw new Error();
      if (
        message.expiresAt < Date.now() - CLOCK_SKEW ||
        message.expiresAt > Date.now() + REQUEST_TTL + CLOCK_SKEW
      ) {
        // An allowed phone whose clock is off: say so instead of a silent close,
        // which Pocket can only report as "interrupted". Nothing was run.
        this.refuseSkew(id, c);
        return;
      }
      for (const [key, expiry] of this.requests) if (expiry < Date.now()) this.requests.delete(key);
      if (this.requests.has(message.id) || this.requests.size >= 10_000) throw new Error();
      this.requests.set(message.id, Date.now() + REQUEST_TTL + 2 * CLOCK_SKEW);
      // An authenticated request means the phone finished (re)verifying this Mac.
      this.pending.delete(c.deviceId!);
      c.used = true;
      clearTimeout(c.deadline);
      c.deadline = setTimeout(() => this.closeChannel(id), 55 * 60_000);
      this.forward(id, c, message);
    } catch {
      this.closeChannel(id);
    }
  }
  /** A complete, sealed HTTP-style answer to a request outside the clock window, then close. */
  private refuseSkew(id: string, c: Channel): void {
    c.used = true;
    const body = JSON.stringify({
      error: "clock_skew",
      message:
        "This iPhone's clock is off by more than five minutes. Turn on Set Automatically in Settings → General → Date & Time.",
      serverTime: Date.now(),
    });
    c.send(
      c.cipher!.seal({
        type: "headers",
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    c.send(c.cipher!.seal({ type: "chunk", body: Buffer.from(body).toString("base64") }));
    c.send(c.cipher!.seal({ type: "end" }));
    this.closeChannel(id);
  }
  private hello(c: Channel, frame: Record<string, unknown>, fromCloud: boolean): void {
    const stored = this.stored!;
    if (
      frame.type !== "hello" ||
      typeof frame.publicKey !== "string" ||
      typeof frame.salt !== "string"
    )
      throw new Error();
    const deviceId = keyId(frame.publicKey);
    c.deviceId = deviceId;
    const grant = stored.grants.find((g) => g.id === deviceId);
    if (!grant && !fromCloud) throw new Error(); // LAN cannot create pairing prompts.
    c.cipher = new LinkCipher(stored.identity, frame.publicKey, frame.salt, "host");
    const name = typeof frame.name === "string" ? frame.name.slice(0, 80) : "Lisa Pocket";
    this.expirePending();
    c.challenge = crypto.randomBytes(32).toString("base64");
    const welcome: Record<string, unknown> = {
      type: "welcome",
      authorized: !!grant,
      challenge: c.challenge,
      lanURLs: grant ? this.lanURLs() : [],
    };
    if (frame.v === PAIRING_VERSION) {
      // A v2 phone never relies on the uncommitted v1 code, so it is not sent.
      welcome.v = PAIRING_VERSION;
      welcome.agentHostVersion = 1;
      if (grant?.fleet) welcome.role = "agent-host";
      // Pairing runs over the cloud route only. Already-allowed devices go through it
      // too: their phone must still verify THIS Mac's key against the Mac's screen.
      if (frame.pair === true && fromCloud && frame.commit !== undefined) {
        const commit = nonceBytes(frame.commit).toString("base64");
        const nonce = this.openPairing(deviceId, frame.publicKey, name, commit, !!grant);
        if (nonce) {
          c.commit = commit;
          c.nonce = nonce;
          c.name = name;
          welcome.nonce = nonce;
        }
      }
      welcome.pending = this.pending.has(deviceId);
    } else {
      // v1 peers (Pocket 1.3 and earlier) verify this code on every connection.
      welcome.code = verificationCode(stored.identity.publicKey, frame.publicKey);
      if (
        !grant &&
        frame.pair === true &&
        !this.pending.has(deviceId) &&
        !this.dismissed.has(deviceId)
      ) {
        if (stored.requireSecurePairing) this.legacyRefused = { name, at: Date.now() };
        else {
          if (this.pending.size >= 10) throw new Error();
          this.pending.set(deviceId, {
            id: deviceId,
            publicKey: frame.publicKey,
            name,
            code: welcome.code as string,
            createdAt: Date.now(),
            expiresAt: Date.now() + PAIRING_TTL,
            protocol: 1,
            known: false,
            rounds: 0,
          });
        }
      }
    }
    c.send(c.cipher.seal(welcome));
  }
  /** The Mac nonce for this commitment: one fresh nonce per commitment, never reused. */
  private openPairing(
    id: string,
    publicKey: string,
    name: string,
    commit: string,
    known: boolean,
  ): string | undefined {
    if (this.dismissed.has(id)) return undefined;
    const existing = this.pending.get(id);
    // The same commitment again (a retry, or a lost reply): the same nonce, no new guess.
    if (existing?.commit === commit) return existing.nonce;
    if (existing?.offer?.commit === commit) return existing.offer.nonce;
    if (existing) {
      // A new commitment for an open request: the phone restarted, or upgraded from v1.
      // It waits beside any opened one, which stays listed and approvable until a valid
      // opening replaces it, and it does not extend the request's lifetime.
      if (existing.rounds >= MAX_PAIRING_ROUNDS) return undefined;
      existing.offer = { commit, nonce: pairingNonce() };
      existing.rounds++;
      return existing.offer.nonce;
    }
    if (this.pending.size >= 10) return undefined;
    const now = Date.now();
    const offer = { commit, nonce: pairingNonce() };
    this.pending.set(id, {
      id,
      publicKey,
      name,
      code: "",
      protocol: 2,
      known,
      offer,
      rounds: 1,
      createdAt: now,
      expiresAt: now + PAIRING_TTL,
    });
    return offer.nonce;
  }
  /** The phone opens its commitment; only now can either side compute the code. */
  private reveal(c: Channel, message: Record<string, unknown>): void {
    const pending = c.deviceId ? this.pending.get(c.deviceId) : undefined;
    if (!pending || !c.commit || !c.nonce) throw new Error();
    // Bound to the exact commitment and Mac nonce this channel's welcome answered.
    const offered = pending.offer?.commit === c.commit && pending.offer.nonce === c.nonce;
    const opened = pending.commit === c.commit && pending.nonce === c.nonce;
    if (!offered && !opened) throw new Error();
    const hostKey = this.stored!.identity.publicKey;
    const nonce = nonceBytes(message.nonce).toString("base64");
    const check = Buffer.from(pairingCommitment(hostKey, pending.publicKey, nonce), "base64");
    if (!crypto.timingSafeEqual(check, Buffer.from(c.commit, "base64"))) throw new Error();
    // Only a phone holding this key can open a commitment on this channel.
    pending.fleet = message.role === "agent-host";
    pending.protocol = 2;
    pending.commit = c.commit;
    pending.nonce = c.nonce;
    pending.code = pairingCode(hostKey, pending.publicKey, nonce, c.nonce);
    if (c.name) pending.name = c.name;
    if (offered) pending.offer = undefined;
    c.used = true;
    c.send(
      c.cipher!.seal({
        type: "paired",
        code: pending.code,
        ...(pending.fleet ? { role: "agent-host" } : {}),
      }),
    );
  }
  private forward(id: string, c: Channel, msg: Record<string, unknown>): void {
    const route = typeof msg.path === "string" ? msg.path : "";
    const method = typeof msg.method === "string" ? msg.method : "";
    const grant = this.stored?.grants.find((g) => g.id === c.deviceId);
    if (
      !grant ||
      (grant.fleet
        ? !fleetRoute(method, route)
        : route.startsWith("/api/agent-host/") &&
          !(grant.pairing === 2 && fleetViewRoute(method, route)))
    ) {
      this.closeChannel(id);
      return;
    }
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
    this.relay = undefined;
    for (const id of this.channels.keys()) this.closeChannel(id);
    this.pending.clear();
    for (const ws of this.lanSockets?.clients ?? []) ws.terminate();
    this.lanSockets?.close();
    this.lan?.close();
    this.lan = undefined;
    this.online = false;
  }
}
