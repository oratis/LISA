import { runAgent } from "../agent.js";
import { getIdleWatcher } from "../idle/watcher.js";
import { providerForModel } from "../providers/registry.js";
import { buildSystemPromptSnapshot, type PromptSnapshot } from "../prompt.js";
import { reflectOnSession } from "../reflect.js";
import { SessionStore } from "../sessions/store.js";
import type {
  StoredMessage,
  ToolDefinition,
} from "../types.js";
import type { ChannelAdapter, IncomingMessage } from "./types.js";

export interface RouterOptions {
  channels: ChannelAdapter[];
  tools: ToolDefinition[];
  cwd: string;
  signal: AbortSignal;
  model: string;
  thinking?: boolean;
  compaction?: boolean;
  /** Reply with this prefix on transient errors so user knows something failed. */
  errorPrefix?: string;
}

interface ThreadContext {
  key: string;
  channel: string;
  thread: string;
  session: SessionStore;
  history: StoredMessage[];
  busy: boolean;
  /** queued messages while busy. */
  queue: IncomingMessage[];
}

export class ChannelRouter {
  private threads = new Map<string, ThreadContext>();
  private snapshot?: PromptSnapshot;
  private opts: RouterOptions;

  constructor(opts: RouterOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.snapshot = await buildSystemPromptSnapshot();
    for (const channel of this.opts.channels) {
      await channel.start((msg) => this.handleIncoming(channel, msg));
      console.error(`[router] ${channel.name} listening`);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.opts.channels.map((c) => c.stop().catch(() => {})));
  }

  private threadKey(channel: string, msg: IncomingMessage): string {
    return `${channel}:${msg.threadId ?? msg.from}`;
  }

  private async getOrCreateThread(
    channel: string,
    msg: IncomingMessage,
  ): Promise<ThreadContext> {
    const key = this.threadKey(channel, msg);
    let ctx = this.threads.get(key);
    if (ctx) return ctx;
    const session = await SessionStore.create({
      cwd: this.opts.cwd,
      model: this.opts.model,
    });
    ctx = {
      key,
      channel,
      thread: msg.threadId ?? msg.from,
      session,
      history: [],
      busy: false,
      queue: [],
    };
    this.threads.set(key, ctx);
    return ctx;
  }

  private async handleIncoming(
    channel: ChannelAdapter,
    msg: IncomingMessage,
  ): Promise<void> {
    // Any inbound message resets the idle clock.
    try { getIdleWatcher(60 * 60_000).tick(); } catch {}
    const ctx = await this.getOrCreateThread(channel.name, msg);
    if (ctx.busy) {
      ctx.queue.push(msg);
      return;
    }
    ctx.busy = true;
    try {
      await this.processOne(channel, ctx, msg);
      while (ctx.queue.length > 0) {
        const next = ctx.queue.shift()!;
        await this.processOne(channel, ctx, next);
      }
    } finally {
      ctx.busy = false;
    }
  }

  private async processOne(
    channel: ChannelAdapter,
    ctx: ThreadContext,
    msg: IncomingMessage,
  ): Promise<void> {
    if (!this.snapshot) throw new Error("router not started");
    const provider = providerForModel(this.opts.model);
    try {
      const result = await runAgent({
        provider,
        systemPrompt: this.snapshot.text,
        tools: this.opts.tools,
        toolCtx: {
          cwd: this.opts.cwd,
          signal: this.opts.signal,
          log: () => {},
        },
        history: ctx.history,
        userMessage: msg.text,
        model: this.opts.model,
        thinking: this.opts.thinking,
        compaction: this.opts.compaction,
        onMessagePersist: (m) => ctx.session.appendMessage(m),
      });
      ctx.history.length = 0;
      ctx.history.push(...result.history);
      const text = result.finalText.trim();
      if (text) {
        await channel.send({
          channel: channel.name,
          to: msg.from,
          text,
          threadId: msg.threadId,
        });
      }
    } catch (err) {
      const detail = (err as Error).message;
      console.error(`[router:${channel.name}] error: ${detail}`);
      try {
        await channel.send({
          channel: channel.name,
          to: msg.from,
          text: `${this.opts.errorPrefix ?? "[lisa] error: "}${detail}`,
          threadId: msg.threadId,
        });
      } catch {
        /* swallow secondary failure */
      }
    }
  }

  /** Run end-of-thread reflection for every conversation that received a message. */
  async reflectAll(): Promise<void> {
    for (const ctx of this.threads.values()) {
      if (ctx.history.length < 2) continue;
      try {
        const r = await reflectOnSession({
          history: ctx.history,
          sessionId: ctx.session.id,
          model: this.opts.model,
        });
        await ctx.session.appendReflection(r.summary);
        console.error(`[reflection ${ctx.key}] ${r.summary}`);
      } catch (err) {
        console.error(`[reflection ${ctx.key}] failed: ${(err as Error).message}`);
      }
    }
  }
}
