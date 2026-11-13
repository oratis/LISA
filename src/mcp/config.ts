import fs from "node:fs/promises";
import path from "node:path";
import { logWarn } from "../log.js";
import { lisaGlobalHome } from "../paths.js";
import { withFileLock } from "../soul/lock.js";
import { writeJsonAtomic } from "../warden/store.js";
import { pathExists } from "../fs-utils.js";
import {
  parseMcpServers,
  parseMcpServer,
  type McpServerConfig,
  type McpServerSpec,
} from "./spec.js";
export type { McpServerSpec } from "./spec.js";

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

const CONFIG_PATH = path.join(lisaGlobalHome(), "mcp.json");

export async function loadMcpConfig(
  warn: (message: string) => void = logWarn,
): Promise<McpServerSpec[]> {
  if (!(await pathExists(CONFIG_PATH))) return [];
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  let config: McpConfig;
  try {
    config = JSON.parse(raw) as McpConfig;
  } catch (err) {
    throw new Error(`failed to parse ${CONFIG_PATH}: ${(err as Error).message}`, { cause: err });
  }
  return parseMcpServers(config.mcpServers, warn);
}

export const MCP_CONFIG_PATH = CONFIG_PATH;

/** Add or replace a server in mcp.json (upsert by name). Returns the spec. */
export async function saveMcpServer(name: string, spec: McpServerConfig): Promise<void> {
  parseMcpServer(name, spec);
  await withFileLock(CONFIG_PATH + ".lock", async () => {
    let config: McpConfig;
    try {
      config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as McpConfig;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
      // Preserve the existing add-on-corrupt behavior.
      config = { mcpServers: {} };
    }
    config.mcpServers = { ...config.mcpServers, [name]: spec };
    await writeJsonAtomic(CONFIG_PATH, config);
  });
}

/** Remove a server from mcp.json. Returns false if it wasn't there. */
export async function deleteMcpServer(name: string): Promise<boolean> {
  return withFileLock(CONFIG_PATH + ".lock", async () => {
    let config: McpConfig;
    try {
      config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as McpConfig;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
        return false;
      throw error;
    }
    if (!config.mcpServers || !Object.hasOwn(config.mcpServers, name)) return false;
    delete config.mcpServers[name];
    await writeJsonAtomic(CONFIG_PATH, config);
    return true;
  });
}
