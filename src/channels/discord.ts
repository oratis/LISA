import { registerChannel } from "./registry.js";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

interface DiscordOptions {
  token: string;
  /** Optional allow-list of Discord channel IDs. */
  allowedChannelIds?: string[];
  /** Optional allow-list of Discord guild (server) IDs. */
  allowedGuildIds?: string[];
  /** Allow DMs (default true). */
  allowDms?: boolean;
}

/**
 * Discord adapter — uses the optional `discord.js` peer dependency. Install with:
 *   npm install discord.js
 *
 * Required bot intents: GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT, DIRECT_MESSAGES.
 * Privileged intent "MESSAGE CONTENT" must be enabled in the Discord Developer Portal.
 */
export class DiscordChannel implements ChannelAdapter {
  readonly name = "discord";
  private opts: DiscordOptions;
  private client?: {
    on: (ev: string, fn: (...a: unknown[]) => unknown) => void;
    login: (token: string) => Promise<unknown>;
    destroy: () => Promise<void>;
    channels: { fetch: (id: string) => Promise<{ send: (s: string) => Promise<unknown> } | null> };
    user?: { id: string };
  };

  constructor(opts: DiscordOptions) {
    if (!opts.token) throw new Error("discord: token is required");
    this.opts = opts;
  }

  async start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    let djs: Record<string, unknown>;
    try {
      // @ts-expect-error optional peer dep, may not be installed at compile time
      djs = (await import("discord.js")) as Record<string, unknown>;
    } catch {
      throw new Error(
        "discord: discord.js is not installed. Run `npm install discord.js` to enable.",
      );
    }
    const Client = djs.Client as new (opts: object) => NonNullable<typeof this.client>;
    const GatewayIntentBits = djs.GatewayIntentBits as Record<string, number>;
    const Partials = djs.Partials as Record<string, number>;
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
    this.client = client;

    this.client.on("messageCreate", async (...args: unknown[]) => {
      const m = args[0] as {
        author: { bot: boolean; id: string };
        content: string;
        channelId: string;
        channel: { isDMBased?: () => boolean; type?: number };
        guildId: string | null;
        client: { user?: { id: string } };
      };
      if (m.author.bot) return;
      const isDm = m.channel.isDMBased?.() ?? m.channel.type === 1;
      if (isDm && this.opts.allowDms === false) return;
      if (!isDm) {
        if (this.opts.allowedGuildIds?.length && (!m.guildId || !this.opts.allowedGuildIds.includes(m.guildId))) return;
        if (this.opts.allowedChannelIds?.length && !this.opts.allowedChannelIds.includes(m.channelId)) return;
      }
      const myId = m.client.user?.id;
      // In guild channels, only respond when mentioned to avoid noise.
      if (!isDm && myId && !m.content.includes(`<@${myId}>`) && !m.content.includes(`<@!${myId}>`)) return;
      const text = myId ? m.content.replace(new RegExp(`<@!?${myId}>\\s*`, "g"), "").trim() : m.content;
      if (!text) return;
      await handler({
        channel: this.name,
        from: m.author.id,
        text,
        threadId: m.channelId,
        receivedAt: new Date(),
      });
    });

    this.client.on("ready", () => {
      console.error(`[discord] logged in as ${this.client?.user?.id ?? "?"}`);
    });

    await this.client.login(this.opts.token);
  }

  async stop(): Promise<void> {
    await this.client?.destroy();
  }

  async send(msg: OutgoingMessage): Promise<void> {
    if (!this.client) throw new Error("discord client not started");
    const channelId = msg.threadId ?? msg.to;
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`discord channel ${channelId} not found`);
    await channel.send(msg.text);
  }
}

registerChannel("discord", (cfg) => {
  return new DiscordChannel({
    token: String(cfg.token ?? ""),
    allowedChannelIds: Array.isArray(cfg.allowedChannelIds)
      ? (cfg.allowedChannelIds as string[])
      : undefined,
    allowedGuildIds: Array.isArray(cfg.allowedGuildIds)
      ? (cfg.allowedGuildIds as string[])
      : undefined,
    allowDms: typeof cfg.allowDms === "boolean" ? cfg.allowDms : true,
  });
});
