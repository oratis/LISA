import fs from "node:fs/promises";
import path from "node:path";
import { LISA_HOME } from "../paths.js";
import { pathExists } from "../fs-utils.js";

export interface ChannelConfigEntry {
  enabled?: boolean;
  /** Per-channel free-form options (token, port, allow-list, etc.). */
  [key: string]: unknown;
}

export interface ChannelsConfig {
  channels: Record<string, ChannelConfigEntry>;
}

export const CHANNELS_CONFIG_PATH = path.join(LISA_HOME, "channels.json");

export async function loadChannelsConfig(): Promise<ChannelsConfig> {
  if (!(await pathExists(CHANNELS_CONFIG_PATH))) return { channels: {} };
  const raw = await fs.readFile(CHANNELS_CONFIG_PATH, "utf8");
  try {
    const parsed = JSON.parse(expandEnv(raw)) as ChannelsConfig;
    return { channels: parsed.channels ?? {} };
  } catch (err) {
    throw new Error(
      `failed to parse ${CHANNELS_CONFIG_PATH}: ${(err as Error).message}`,
    );
  }
}

/** Replace ${VAR_NAME} placeholders with process.env values. */
function expandEnv(raw: string): string {
  return raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) return "";
    return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  });
}
