import fs from "node:fs/promises";
import path from "node:path";
import { LISA_HOME } from "../paths.js";
import { pathExists } from "../fs-utils.js";

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  alwaysLoad?: boolean;
}

export interface McpConfig {
  mcpServers: Record<string, Omit<McpServerSpec, "name">>;
}

const CONFIG_PATH = path.join(LISA_HOME, "mcp.json");

export async function loadMcpConfig(): Promise<McpServerSpec[]> {
  if (!(await pathExists(CONFIG_PATH))) return [];
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  let config: McpConfig;
  try {
    config = JSON.parse(raw) as McpConfig;
  } catch (err) {
    throw new Error(`failed to parse ${CONFIG_PATH}: ${(err as Error).message}`);
  }
  const servers = config.mcpServers ?? {};
  return Object.entries(servers).map(([name, spec]) => ({
    name,
    command: spec.command,
    args: spec.args ?? [],
    env: spec.env,
    enabled: spec.enabled ?? true,
    alwaysLoad: spec.alwaysLoad ?? false,
  }));
}

export const MCP_CONFIG_PATH = CONFIG_PATH;
