import http from "node:http";
import crypto from "node:crypto";
import { registerChannel } from "./registry.js";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

interface SlackOptions {
  /** Slack bot token (xoxb-...) — used to send messages. */
  botToken: string;
  /** Slack signing secret — used to verify inbound webhooks. */
  signingSecret: string;
  /** HTTP port for Slack Events API webhook. */
  port: number;
  /** Optional allow-list of Slack channel IDs (e.g. ["C0123456"]). */
  allowedChannelIds?: string[];
  /** Optional allow-list of Slack user IDs. */
  allowedUserIds?: string[];
}

interface SlackEvent {
  type: string;
  user?: string;
  channel?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

/**
 * Slack adapter using the Events API (HTTPS webhook with signing-secret auth).
 *
 * To wire up:
 *   1. Create a Slack app, enable bot token scopes: chat:write, im:history, im:write,
 *      app_mentions:read, channels:history (whatever channels you want).
 *   2. Install to your workspace; get xoxb-... bot token.
 *   3. Enable Event Subscriptions; point Request URL at https://<your-ngrok>/<port>/.
 *   4. Subscribe to bot events: message.im, app_mention.
 *   5. Drop botToken + signingSecret in ~/.lisa/channels.json.
 *
 * Lisa runs the HTTP receiver locally — exposing it publicly is up to you
 * (ngrok, cloudflare tunnel, your own proxy).
 */
export class SlackChannel implements ChannelAdapter {
  readonly name = "slack";
  private opts: SlackOptions;
  private server?: http.Server;
  private handler?: (msg: IncomingMessage) => Promise<void>;
  private seenEventIds = new Set<string>();

  constructor(opts: SlackOptions) {
    if (!opts.botToken || !opts.signingSecret) {
      throw new Error("slack: botToken and signingSecret are required");
    }
    this.opts = opts;
  }

  async start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, resolve));
    console.error(
      `[slack] listening for Events API webhooks on http://localhost:${this.opts.port}`,
    );
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
    }
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const channel = msg.threadId?.split(":")[0] ?? msg.to;
    const thread_ts = msg.threadId?.split(":")[1];
    const body: Record<string, unknown> = {
      channel,
      text: msg.text,
    };
    if (thread_ts) body.thread_ts = thread_ts;
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${this.opts.botToken}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`slack chat.postMessage: ${json.error}`);
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const ts = String(req.headers["x-slack-request-timestamp"] ?? "");
    const sig = String(req.headers["x-slack-signature"] ?? "");
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!this.verify(ts, body, sig)) {
        res.writeHead(401);
        res.end("bad signature");
        return;
      }
      let parsed: {
        type: string;
        challenge?: string;
        event?: SlackEvent;
        event_id?: string;
      };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      if (parsed.type === "url_verification" && parsed.challenge) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(parsed.challenge);
        return;
      }
      // Ack immediately (Slack requires <3s response).
      res.writeHead(200);
      res.end();
      if (parsed.type === "event_callback" && parsed.event) {
        if (parsed.event_id && this.seenEventIds.has(parsed.event_id)) return;
        if (parsed.event_id) {
          this.seenEventIds.add(parsed.event_id);
          if (this.seenEventIds.size > 1000) {
            // simple FIFO eviction
            const first = this.seenEventIds.values().next().value;
            if (first !== undefined) this.seenEventIds.delete(first);
          }
        }
        void this.handleEvent(parsed.event);
      }
    });
  }

  private async handleEvent(ev: SlackEvent): Promise<void> {
    if (ev.bot_id || ev.subtype === "bot_message") return;
    if (!ev.text || !ev.channel || !ev.user) return;
    if (this.opts.allowedChannelIds?.length && !this.opts.allowedChannelIds.includes(ev.channel)) return;
    if (this.opts.allowedUserIds?.length && !this.opts.allowedUserIds.includes(ev.user)) return;
    // Strip bot mention prefix like "<@U12345> " if present.
    const text = ev.text.replace(/^<@[A-Z0-9]+>\s*/, "");
    const threadKey = ev.thread_ts ? `${ev.channel}:${ev.thread_ts}` : ev.channel;
    await this.handler?.({
      channel: this.name,
      from: ev.user,
      text,
      threadId: threadKey,
      receivedAt: new Date(),
    });
  }

  private verify(ts: string, body: string, sig: string): boolean {
    if (!ts || !sig) return false;
    // Drift > 5 min → reject (replay protection).
    if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) return false;
    const baseString = `v0:${ts}:${body}`;
    const computed =
      "v0=" +
      crypto
        .createHmac("sha256", this.opts.signingSecret)
        .update(baseString)
        .digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig));
    } catch {
      return false;
    }
  }
}

registerChannel("slack", (cfg) => {
  return new SlackChannel({
    botToken: String(cfg.botToken ?? ""),
    signingSecret: String(cfg.signingSecret ?? ""),
    port: typeof cfg.port === "number" ? cfg.port : 5810,
    allowedChannelIds: Array.isArray(cfg.allowedChannelIds)
      ? (cfg.allowedChannelIds as string[])
      : undefined,
    allowedUserIds: Array.isArray(cfg.allowedUserIds)
      ? (cfg.allowedUserIds as string[])
      : undefined,
  });
});
