import fs from "node:fs/promises";
import path from "node:path";
import { LISA_HOME } from "../paths.js";
import { pathExists } from "../fs-utils.js";

export interface HeartbeatTask {
  name: string;
  prompt: string;
  enabled?: boolean;
  /** Cron-like spec OR `every:30m` shorthand handled by runner. Currently informational. */
  schedule?: string;
}

export interface HeartbeatConfig {
  tasks: HeartbeatTask[];
}

const FILE = path.join(LISA_HOME, "heartbeat.json");

export async function loadHeartbeatConfig(): Promise<HeartbeatConfig> {
  if (!(await pathExists(FILE))) return { tasks: [] };
  const raw = await fs.readFile(FILE, "utf8");
  const parsed = JSON.parse(raw) as HeartbeatConfig;
  return { tasks: parsed.tasks ?? [] };
}

export const HEARTBEAT_CONFIG_PATH = FILE;
