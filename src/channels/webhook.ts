import http from "node:http";
import crypto from "node:crypto";
import { registerChannel } from "./registry.js";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

interface WebhookOptions {
  port: number;
  /** Bearer token expected in `Authorization: Bearer <token>` header. */
  token: string;
  /** Optional outbound webhook URL to POST replies to. */
  replyUrl?: string;
}

interface PendingReply {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  res: http.ServerResponse;
}

/**
 * Generic webhook channel for any sender that can POST JSON.
 *
 * Inbound:  POST /  with Authorization: Bearer <token>
 *           body: {"from": "<sender id>", "text": "...", "threadId"?: "..."}
 *           Lisa replies inline (long-running response) — the HTTP request stays
 *           open until she's done answering, then her reply is the response body.
 *
 * Outbound: if `replyUrl` is configured, replies are also POSTed there as
 *           {"to": "<sender>", "text": "...", "threadId"?: "...", "channel": "webhook"}.
 */
export class WebhookChannel implements ChannelAdapter {
  readonly name = "webhook";
  private server?: http.Server;
  private opts: WebhookOptions;
  private handler?: (msg: IncomingMessage) => Promise<void>;
  private pending = new Map<string, PendingReply>();

  constructor(opts: WebhookOptions) {
    if (!opts.token) throw new Error("webhook: token is required (set a shared secret)");
    this.opts = opts;
  }

  async start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, resolve));
    console.error(
      `[webhook] listening on http://localhost:${this.opts.port} (Bearer auth required)`,
    );
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  async send(msg: OutgoingMessage): Promise<void> {
    // Resolve any pending HTTP request for this thread.
    const key = msg.threadId ?? msg.to;
    const pending = this.pending.get(key);
    if (pending) {
      this.pending.delete(key);
      pending.resolve(msg.text);
    }
    // Also POST to the configured replyUrl if set.
    if (this.opts.replyUrl) {
      try {
        await fetch(this.opts.replyUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: this.name,
            to: msg.to,
            text: msg.text,
            threadId: msg.threadId,
          }),
        });
      } catch (err) {
        console.error(`[webhook] reply POST failed: ${(err as Error).message}`);
      }
    }
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (!this.checkAuth(auth)) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed: { from?: string; text?: string; threadId?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      if (!parsed.from || !parsed.text) {
        res.writeHead(400);
        res.end('expected {"from":"...","text":"..."[,"threadId":"..."]}');
        return;
      }
      const key = parsed.threadId ?? parsed.from;
      const replyPromise = new Promise<string>((resolve, reject) => {
        this.pending.set(key, { resolve, reject, res });
      });
      try {
        await this.handler?.({
          channel: this.name,
          from: parsed.from,
          text: parsed.text,
          threadId: parsed.threadId,
          receivedAt: new Date(),
        });
        // Wait up to 5 minutes for Lisa's reply.
        const reply = await Promise.race([
          replyPromise,
          new Promise<string>((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), 300_000),
          ),
        ]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ reply }));
      } catch (err) {
        this.pending.delete(key);
        res.writeHead(504);
        res.end((err as Error).message);
      }
    });
  }

  private checkAuth(header: string): boolean {
    const m = header.match(/^Bearer\s+(.+)$/);
    if (!m) return false;
    try {
      return crypto.timingSafeEqual(
        Buffer.from(m[1]!.trim()),
        Buffer.from(this.opts.token),
      );
    } catch {
      return false;
    }
  }
}

registerChannel("webhook", (cfg) => {
  return new WebhookChannel({
    port: typeof cfg.port === "number" ? cfg.port : 5800,
    token: String(cfg.token ?? ""),
    replyUrl: typeof cfg.replyUrl === "string" ? cfg.replyUrl : undefined,
  });
});
