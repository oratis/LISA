/**
 * Lisa Pocket's side of the Mac link, in Node. It mirrors
 * packaging/ios-companion/Sources/RemoteMacTransport.swift: the hello Pocket sends (binary,
 * announcing pairing v2), the pairing v2 round (commit → Mac nonce → reveal → compare), and
 * one sealed request per channel answered by `headers`, `chunk`s and `end`.
 *
 * Every wait is bounded, so a broken peer fails a test instead of hanging it.
 */
import crypto from "node:crypto";
import { WebSocket } from "ws";
import {
  identity,
  keyId,
  LinkCipher,
  PAIRING_VERSION,
  pairingCode,
  pairingCommitment,
  pairingNonce,
  verificationCode,
  type LinkIdentity,
  type SealedFrame,
} from "../../../src/remote/protocol.js";

export type Frame = Record<string, unknown>;
/** A Mac as `GET /api/relay/macs` lists it. */
export interface MacTarget {
  id: string;
  publicKey: string;
}

/** How long any single step may take before the phone gives up. */
export const STEP_MS = 5_000;

/** The socket closed (the Mac or the relay refused or ended the channel). */
export class LinkClosedError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(`link closed (${code}${reason ? ` ${reason}` : ""})`);
  }
}
/** RemoteLinkError.notAllowed: the welcome says this phone has no grant. */
export class NotAllowedError extends Error {
  constructor() {
    super("not_allowed");
  }
}

/** One WebSocket channel to the Mac, after its sealed welcome arrived. */
export class LinkConnection {
  welcome: Frame = {};
  /** Resolves when the socket closes, from either side. */
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly queue: string[] = [];
  private waiter?: { resolve: (text: string) => void; reject: (error: Error) => void };
  private closedWith?: { code: number; reason: string };
  constructor(
    readonly ws: WebSocket,
    private readonly cipher: LinkCipher,
  ) {
    ws.on("error", () => {});
    ws.on("message", (data: Buffer) => {
      const waiter = this.waiter;
      this.waiter = undefined;
      if (waiter) waiter.resolve(data.toString());
      else this.queue.push(data.toString());
    });
    this.closed = new Promise((resolve) => {
      ws.once("close", (code: number, reason: Buffer) => {
        this.closedWith = { code, reason: reason.toString() };
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.reject(new LinkClosedError(code, this.closedWith.reason));
        resolve(this.closedWith);
      });
    });
  }
  send(value: Frame): void {
    this.ws.send(JSON.stringify(this.cipher.seal(value)));
  }
  /** The next frame from the Mac, decrypted. Rejects on close or after `ms`. */
  async receive(ms = STEP_MS): Promise<Frame> {
    return this.cipher.open(JSON.parse(await this.next(ms)) as SealedFrame);
  }
  /** Pocket's Stop and its normal teardown: close the socket. */
  close(): void {
    this.ws.close();
  }
  terminate(): void {
    this.ws.terminate();
  }
  private next(ms: number): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closedWith)
      return Promise.reject(new LinkClosedError(this.closedWith.code, this.closedWith.reason));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error(`no frame from the Mac within ${ms} ms`));
      }, ms);
      this.waiter = {
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }
}

/** RemoteMacTransport.open(): socket, binary hello with a fresh salt, sealed welcome. */
export async function openLink(
  url: string,
  opts: { key: LinkIdentity; host: MacTarget; token?: string; hello: Frame; name?: string },
): Promise<LinkConnection> {
  // Pocket pins the Mac by key id before it ever dials.
  if (keyId(opts.host.publicKey) !== opts.host.id) throw new Error("invalid_peer");
  const ws = new WebSocket(url, {
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    handshakeTimeout: STEP_MS,
    perMessageDeflate: false,
  });
  const salt = crypto.randomBytes(32).toString("base64");
  const link = new LinkConnection(
    ws,
    new LinkCipher(opts.key, opts.host.publicKey, salt, "client"),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("close", (code: number, reason: Buffer) =>
        reject(new LinkClosedError(code, reason.toString())),
      );
    });
    ws.send(
      Buffer.from(
        JSON.stringify({
          type: "hello",
          publicKey: opts.key.publicKey,
          salt,
          name: opts.name ?? "Test iPhone",
          ...opts.hello,
        }),
      ),
    );
    link.welcome = await link.receive();
    // verifyWelcome(): a v2 Mac never sends the uncommitted v1 code; a v1 Mac's must match.
    if (
      link.welcome.type !== "welcome" ||
      (link.welcome.v !== PAIRING_VERSION &&
        link.welcome.code !== verificationCode(opts.host.publicKey, opts.key.publicKey))
    )
      throw new Error("invalid_peer");
    return link;
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

/** One request on its own channel, as Pocket's perform() reads it. */
export class LinkExchange {
  status = 0;
  headers: Record<string, string> = {};
  private ended = false;
  private sse = "";
  private readonly events: Frame[] = [];
  constructor(readonly link: LinkConnection) {}
  /** Waits for the response head; any other first frame is a protocol error. */
  async head(): Promise<void> {
    const frame = await this.link.receive();
    if (frame.type !== "headers" || typeof frame.status !== "number")
      throw new Error(`expected headers, got ${String(frame.type)}`);
    this.status = frame.status;
    this.headers = (frame.headers ?? {}) as Record<string, string>;
  }
  /** The next body chunk, or undefined once the Mac sent `end`. */
  async chunk(ms = STEP_MS): Promise<Buffer | undefined> {
    if (this.ended) return undefined;
    const frame = await this.link.receive(ms);
    if (frame.type === "end") {
      this.ended = true;
      return undefined;
    }
    if (frame.type !== "chunk" || typeof frame.body !== "string")
      throw new Error(`expected a chunk, got ${String(frame.type)}`);
    return Buffer.from(frame.body, "base64");
  }
  /** The rest of the body, through `end`. */
  async text(): Promise<string> {
    const parts: Buffer[] = [];
    for (let chunk = await this.chunk(); chunk; chunk = await this.chunk()) parts.push(chunk);
    return Buffer.concat(parts).toString();
  }
  /** The next `data:` payload of an SSE body (comments skipped), or undefined at `end`. */
  async event(ms = STEP_MS): Promise<Frame | undefined> {
    while (this.events.length === 0) {
      const chunk = await this.chunk(ms);
      if (!chunk) return undefined;
      this.sse += chunk.toString();
      let split: number;
      while ((split = this.sse.indexOf("\n\n")) >= 0) {
        const block = this.sse.slice(0, split);
        this.sse = this.sse.slice(split + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) this.events.push(JSON.parse(data) as Frame);
      }
    }
    return this.events.shift();
  }
  close(): void {
    this.link.close();
  }
}

/** One paired-or-pairing iPhone: its own device key and one account session. */
export class Phone {
  readonly key: LinkIdentity = identity();
  /** LAN URLs from the last cloud welcome; Pocket tries these first next time. */
  lanURLs: string[] = [];
  private readonly links = new Set<LinkConnection>();
  constructor(readonly opts: { cloud: string; token: string; host: MacTarget; name?: string }) {}
  get id(): string {
    return keyId(this.key.publicKey);
  }
  /** Drops every channel this phone still holds (test teardown). */
  dispose(): void {
    for (const link of this.links) link.terminate();
  }
  relayURL(): string {
    const url = new URL("/api/relay/client", this.opts.cloud);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("host", this.opts.host.id);
    return url.toString();
  }
  /** A channel through the relay (account Bearer), or to a LAN `/link` URL (no token). */
  async connect(hello: Frame = {}, lan?: string): Promise<LinkConnection> {
    const link = await openLink(lan ?? this.relayURL(), {
      key: this.key,
      host: this.opts.host,
      token: lan ? undefined : this.opts.token,
      name: this.opts.name,
      // Every hello announces pairing v2.
      hello: { v: PAIRING_VERSION, pair: false, ...hello },
    });
    this.links.add(link);
    void link.closed.then(() => this.links.delete(link));
    if (!lan) {
      const urls = link.welcome.lanURLs;
      this.lanURLs = Array.isArray(urls) ? urls.filter((u) => typeof u === "string") : [];
    }
    return link;
  }
  /**
   * The first poll of Pocket's pairing screen: commit to a nonce over the relay and take
   * the Mac's. `reveal()` then opens the commitment and checks that the Mac derived the
   * same code, which is the code the person compares with the Mac's screen.
   */
  async startPairing(): Promise<{ welcome: Frame; reveal: () => Promise<string> }> {
    const host = this.opts.host.publicKey;
    const nonce = pairingNonce();
    const link = await this.connect({
      pair: true,
      commit: pairingCommitment(host, this.key.publicKey, nonce),
    });
    const macNonce = link.welcome.nonce;
    return {
      welcome: link.welcome,
      reveal: async () => {
        try {
          if (typeof macNonce !== "string") throw new Error("the Mac opened no pairing request");
          link.send({ type: "pair", nonce });
          const reply = await link.receive();
          const code = pairingCode(host, this.key.publicKey, nonce, macNonce);
          if (reply.type !== "paired" || reply.code !== code) throw new Error("invalid_peer");
          return code;
        } finally {
          link.close();
        }
      },
    };
  }
  async pair(): Promise<string> {
    return (await this.startPairing()).reveal();
  }
  /** Sends one request on a fresh channel and waits for its head. */
  async open(
    path: string,
    opts: { method?: string; body?: unknown; lan?: string } = {},
  ): Promise<LinkExchange> {
    const link = await this.connect({}, opts.lan);
    if (link.welcome.authorized !== true) {
      link.close();
      throw new NotAllowedError();
    }
    link.send({
      type: "request",
      id: crypto.randomUUID(),
      challenge: link.welcome.challenge,
      expiresAt: Date.now() + 60_000,
      path,
      method: opts.method ?? "GET",
      body:
        opts.body === undefined ? "" : Buffer.from(JSON.stringify(opts.body)).toString("base64"),
    });
    const exchange = new LinkExchange(link);
    try {
      await exchange.head();
    } catch (error) {
      link.terminate();
      throw error;
    }
    return exchange;
  }
  /** A whole request: head, body and `end`. */
  async request(
    path: string,
    opts: { method?: string; body?: unknown; lan?: string } = {},
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const exchange = await this.open(path, opts);
    try {
      const body = await exchange.text();
      return { status: exchange.status, headers: exchange.headers, body };
    } finally {
      exchange.close();
    }
  }
}
