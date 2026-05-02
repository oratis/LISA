import { registerChannel } from "./registry.js";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

interface TelegramOptions {
  token: string;
  /** Optional allow-list of chat IDs (numeric, both private and group). */
  allowedChatIds?: number[];
  /** Optional allow-list of @usernames (case-insensitive, no @ prefix). */
  allowedUsernames?: string[];
  /** Long-poll timeout in seconds. Default 30. */
  longPollSec?: number;
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  };
}

const API = (token: string) => `https://api.telegram.org/bot${token}`;

export class TelegramChannel implements ChannelAdapter {
  readonly name = "telegram";
  private opts: TelegramOptions;
  private offset = 0;
  private running = false;
  private handler?: (msg: IncomingMessage) => Promise<void>;

  constructor(opts: TelegramOptions) {
    if (!opts.token) throw new Error("telegram: token is required");
    this.opts = opts;
  }

  async start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
    this.running = true;
    // Disable any old webhook so long-poll works.
    try {
      await this.api("deleteWebhook", { drop_pending_updates: false });
    } catch {}
    void this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const chatId = msg.threadId ?? msg.to;
    await this.api("sendMessage", {
      chat_id: parseInt(chatId, 10) || chatId,
      text: msg.text,
      parse_mode: "Markdown",
    });
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api<TgUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: this.opts.longPollSec ?? 30,
          allowed_updates: ["message"],
        });
        for (const u of updates) {
          if (u.update_id >= this.offset) this.offset = u.update_id + 1;
          const m = u.message;
          if (!m || !m.text) continue;
          if (!this.allowed(m)) continue;
          await this.handler?.({
            channel: this.name,
            from: String(m.chat.id),
            text: m.text,
            threadId: String(m.chat.id),
            receivedAt: new Date(m.date * 1000),
          });
        }
      } catch (err) {
        console.error(`[telegram] poll error: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }

  private allowed(m: NonNullable<TgUpdate["message"]>): boolean {
    if (this.opts.allowedChatIds?.length) {
      if (!this.opts.allowedChatIds.includes(m.chat.id)) return false;
    }
    if (this.opts.allowedUsernames?.length) {
      const u = (m.from?.username ?? "").toLowerCase();
      if (!u || !this.opts.allowedUsernames.map((x) => x.toLowerCase()).includes(u)) {
        return false;
      }
    }
    return true;
  }

  private async api<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API(this.opts.token)}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
    return json.result as T;
  }
}

registerChannel("telegram", (cfg) => {
  return new TelegramChannel({
    token: String(cfg.token ?? ""),
    allowedChatIds: Array.isArray(cfg.allowedChatIds)
      ? (cfg.allowedChatIds as number[])
      : undefined,
    allowedUsernames: Array.isArray(cfg.allowedUsernames)
      ? (cfg.allowedUsernames as string[])
      : undefined,
    longPollSec: typeof cfg.longPollSec === "number" ? cfg.longPollSec : undefined,
  });
});
