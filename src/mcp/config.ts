import fs from "node:fs/promises";
import path from "node:path";
import { lisaGlobalHome } from "../paths.js";
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

const CONFIG_PATH = path.join(lisaGlobalHome(), "mcp.json");

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

/** Add or replace a server in mcp.json (upsert by name). Returns the spec. */
export async function saveMcpServer(
  name: string,
  spec: Omit<McpServerSpec, "name">,
): Promise<void> {
  let config: McpConfig = { mcpServers: {} };
  if (await pathExists(CONFIG_PATH)) {
    try {
      config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as McpConfig;
    } catch {
      // start fresh on a corrupt file rather than lose the add
    }
  }
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers[name] = spec;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Remove a server from mcp.json. Returns false if it wasn't there. */
export async function deleteMcpServer(name: string): Promise<boolean> {
  if (!(await pathExists(CONFIG_PATH))) return false;
  let config: McpConfig;
  try {
    config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as McpConfig;
  } catch {
    return false;
  }
  if (!config.mcpServers || !(name in config.mcpServers)) return false;
  delete config.mcpServers[name];
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  return true;
}
