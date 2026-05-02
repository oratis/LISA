import type { ChannelAdapter } from "./types.js";
import type { ChannelConfigEntry } from "./config.js";

export type ChannelFactory = (
  cfg: ChannelConfigEntry,
) => ChannelAdapter | Promise<ChannelAdapter>;

const FACTORIES = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  FACTORIES.set(name, factory);
}

export async function makeChannel(
  name: string,
  cfg: ChannelConfigEntry,
): Promise<ChannelAdapter> {
  const factory = FACTORIES.get(name);
  if (!factory) {
    throw new Error(
      `unknown channel "${name}". Known: ${Array.from(FACTORIES.keys()).join(", ") || "(none registered)"}`,
    );
  }
  return await factory(cfg);
}

export function listAvailableChannels(): string[] {
  return Array.from(FACTORIES.keys()).sort();
}

// Lazy registration of built-in adapters happens via registerBuiltins().
let builtinsRegistered = false;
export async function registerBuiltins(): Promise<void> {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  // Each adapter file calls registerChannel() at module-load time.
  await import("./imessage.js");
  await import("./telegram.js");
  await import("./webhook.js");
  await import("./slack.js");
  await import("./discord.js");
  await import("./feishu.js");
}
