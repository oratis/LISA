import http from "node:http";
import crypto from "node:crypto";
import { registerChannel } from "./registry.js";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

interface FeishuOptions {
  /** Feishu / Lark App ID (cli_...) */
  appId: string;
  /** Feishu / Lark App Secret */
  appSecret: string;
  /** Verification token from Feishu Event Subscription page (for v1 challenge) */
  verificationToken?: string;
  /** Encrypt key — if set, Feishu encrypts the event payload */
  encryptKey?: string;
  /** HTTP port for receiving Feishu event webhooks */
  port: number;
  /** Optional allow-list of Feishu open_id / union_id / user_id strings */
  allowedUserIds?: string[];
}

interface TenantAccessTokenCache {
  token: string;
  expiresAt: number;
}

/**
 * Feishu (Lark) channel adapter.
 *
 * Setup steps in the Feishu Open Platform (open.feishu.cn):
 *   1. Go to your app → "事件订阅" (Event Subscriptions).
 *   2. Set Request URL to https://<tunnel>:<port>/feishu  (expose via ngrok / cloudflare).
 *   3. Subscribe to: im.message.receive_v1
 *   4. Under "权限管理" add: im:message (receive) + im:message:send_as_bot (send)
 *   5. Release / publish a new version so scopes take effect.
 *   6. Add the bot to a group or let users DM it.
 *
 * Inbound events:
 *   - Feishu sends a JSON POST to your endpoint.
 *   - If encryptKey is set the body is AES-CBC encrypted; we decrypt it.
 *   - We reply with the challenge on URL verification and 200 on events.
 *
 * Outbound:
 *   - We get a tenant_access_token via client credentials and POST to
 *     /open-apis/im/v1/messages.
 */
export class FeishuChannel implements ChannelAdapter {
  readonly name = "feishu";
  private opts: FeishuOptions;
  private server?: http.Server;
  private handler?: (msg: IncomingMessage) => Promise<void>;
  private tokenCache?: TenantAccessTokenCache;
  private seenMessageIds = new Set<string>();

  constructor(opts: FeishuOptions) {
    if (!opts.appId || !opts.appSecret) {
      throw new Error("feishu: appId and appSecret are required");
    }
    this.opts = opts;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    await new Promise<void>((resolve) =>
      this.server!.listen(this.opts.port, resolve),
    );
    console.error(
      `[feishu] listening on http://localhost:${this.opts.port}/feishu`,
    );
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
    }
  }

  // ─── Send ─────────────────────────────────────────────────────────────────

  async send(msg: OutgoingMessage): Promise<void> {
    const token = await this.getTenantAccessToken();
    // msg.to = open_id of the target user; msg.threadId = chat_id for group threads
    const receiveIdType = msg.threadId ? "chat_id" : "open_id";
    const receiveId = msg.threadId ?? msg.to;

    const body = {
      receive_id: receiveId,
      msg_type: "text",
      content: JSON.stringify({ text: msg.text }),
    };

    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
    const json = (await res.json()) as { code: number; msg: string };
    if (json.code !== 0) {
      throw new Error(`feishu send error ${json.code}: ${json.msg}`);
    }
  }

  // ─── HTTP handler ─────────────────────────────────────────────────────────

  private async onRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST" || !req.url?.startsWith("/feishu")) {
      res.writeHead(404);
      res.end();
      return;
    }

    const rawBody = await readBody(req);

    let payload: Record<string, unknown>;
    try {
      payload = this.opts.encryptKey
        ? this.decrypt(rawBody)
        : (JSON.parse(rawBody) as Record<string, unknown>);
    } catch (e) {
      console.error("[feishu] failed to parse/decrypt payload:", e);
      res.writeHead(400);
      res.end("bad payload");
      return;
    }

    // ── URL verification challenge ──────────────────────────────────────────
    if (typeof payload.challenge === "string") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ challenge: payload.challenge }));
      return;
    }

    // ── Ack immediately ─────────────────────────────────────────────────────
    res.writeHead(200);
    res.end();

    void this.handleEvent(payload);
  }

  // ─── Event dispatch ───────────────────────────────────────────────────────

  private async handleEvent(payload: Record<string, unknown>): Promise<void> {
    try {
      const header = payload.header as Record<string, unknown> | undefined;
      const eventType = header?.event_type as string | undefined;

      if (eventType !== "im.message.receive_v1") return;

      const event = payload.event as Record<string, unknown> | undefined;
      if (!event) return;

      const message = event.message as Record<string, unknown> | undefined;
      const sender = event.sender as Record<string, unknown> | undefined;
      if (!message || !sender) return;

      const messageId = message.message_id as string;
      if (this.seenMessageIds.has(messageId)) return;
      this.seenMessageIds.add(messageId);
      if (this.seenMessageIds.size > 2000) {
        const first = this.seenMessageIds.values().next().value;
        if (first !== undefined) this.seenMessageIds.delete(first);
      }

      // Only handle text messages
      if (message.message_type !== "text") return;

      const senderId = sender.sender_id as Record<string, string> | undefined;
      const openId = senderId?.open_id ?? "";

      if (
        this.opts.allowedUserIds?.length &&
        !this.opts.allowedUserIds.includes(openId)
      )
        return;

      const contentRaw = message.content as string;
      let text = "";
      try {
        const parsed = JSON.parse(contentRaw) as { text?: string };
        text = parsed.text ?? "";
      } catch {
        text = contentRaw;
      }

      // Strip @bot mention if present
      text = text.replace(/@\S+\s*/g, "").trim();
      if (!text) return;

      const chatId = message.chat_id as string | undefined;

      await this.handler?.({
        channel: this.name,
        from: openId,
        text,
        threadId: chatId,
        receivedAt: new Date(),
      });
    } catch (err) {
      console.error("[feishu] handleEvent error:", err);
    }
  }

  // ─── Token ────────────────────────────────────────────────────────────────

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }
    const res = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_id: this.opts.appId,
          app_secret: this.opts.appSecret,
        }),
      },
    );
    const json = (await res.json()) as {
      code: number;
      msg: string;
      tenant_access_token: string;
      expire: number;
    };
    if (json.code !== 0) {
      throw new Error(
        `feishu get token error ${json.code}: ${json.msg}`,
      );
    }
    this.tokenCache = {
      token: json.tenant_access_token,
      expiresAt: now + json.expire * 1000,
    };
    return this.tokenCache.token;
  }

  // ─── AES-CBC decrypt (when encryptKey is set) ────────────────────────────

  private decrypt(rawBody: string): Record<string, unknown> {
    const key = this.opts.encryptKey!;
    const json = JSON.parse(rawBody) as { encrypt: string };
    const encrypted = json.encrypt;

    // Feishu AES key = SHA256(encryptKey) — raw 32 bytes
    const aesKey = crypto.createHash("sha256").update(key).digest();

    // First 16 bytes of the base64-decoded payload are the IV
    const buf = Buffer.from(encrypted, "base64");
    const iv = buf.subarray(0, 16);
    const data = buf.subarray(16);

    const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
    const decrypted = Buffer.concat([
      decipher.update(data),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(decrypted) as Record<string, unknown>;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ─── Register ─────────────────────────────────────────────────────────────────

registerChannel("feishu", (cfg) => {
  return new FeishuChannel({
    appId: String(cfg.appId ?? ""),
    appSecret: String(cfg.appSecret ?? ""),
    verificationToken: cfg.verificationToken
      ? String(cfg.verificationToken)
      : undefined,
    encryptKey: cfg.encryptKey ? String(cfg.encryptKey) : undefined,
    port: typeof cfg.port === "number" ? cfg.port : 5820,
    allowedUserIds: Array.isArray(cfg.allowedUserIds)
      ? (cfg.allowedUserIds as string[])
      : undefined,
  });
});
