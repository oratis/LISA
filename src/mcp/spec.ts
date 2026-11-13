import { assertAllowedUrl } from "../tools/web_fetch.js";

interface ServerOptions {
  enabled?: boolean;
  alwaysLoad?: boolean;
}

interface StdioServer extends ServerOptions {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HttpServer extends ServerOptions {
  type: "http";
  url: string;
  allowedTools?: string[];
}

export type McpServerConfig = StdioServer | HttpServer;
export type McpServerSpec = McpServerConfig & { name: string };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Parse both home and plugin configs. Never silently downgrade a remote entry to stdio. */
export function parseMcpServer(name: string, value: unknown): McpServerSpec {
  if (!record(value)) throw new Error("expected an MCP server object");
  const { enabled = true, alwaysLoad = false } = value;
  if (typeof enabled !== "boolean" || typeof alwaysLoad !== "boolean")
    throw new Error("enabled and alwaysLoad must be booleans");
  if ("url" in value || value.type === "http") {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.includes("__") || name.endsWith("_"))
      throw new Error("invalid HTTP MCP server name");
    if (value.type !== undefined && value.type !== "http")
      throw new Error("expected Streamable HTTP transport");
    if (
      Object.keys(value).some(
        (key) => !["type", "url", "enabled", "alwaysLoad", "allowedTools"].includes(key),
      )
    )
      throw new Error(
        "HTTP MCP supports url and optional allowedTools, without credentials or commands",
      );
    if (typeof value.url !== "string" || !URL.canParse(value.url))
      throw new Error("invalid MCP URL");
    const url = new URL(value.url);
    if (url.href.includes("?") || url.href.includes("#"))
      throw new Error("MCP URLs cannot include a query or fragment");
    assertAllowedUrl(url, {
      allowedProtocols: ["https:"],
      allowedPorts: [443],
      refuseInternalNames: true,
    });
    const allowedTools = value.allowedTools;
    if (
      allowedTools !== undefined &&
      (!Array.isArray(allowedTools) ||
        !allowedTools.every((key) => typeof key === "string" && key.length > 0))
    )
      throw new Error("allowedTools must be a list of exact tool names");
    return {
      name,
      type: "http",
      url: url.href,
      enabled,
      alwaysLoad,
      ...(allowedTools ? { allowedTools } : {}),
    };
  }
  if (value.type !== undefined && value.type !== "stdio")
    throw new Error("unsupported MCP transport");
  if (typeof value.command !== "string" || !value.command.trim())
    throw new Error("stdio needs a command");
  if (value.allowedTools !== undefined)
    throw new Error("allowedTools is only supported for HTTP MCP");
  const { args = [], env } = value;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
    throw new Error("invalid MCP command args");
  if (
    env !== undefined &&
    (!record(env) || !Object.values(env).every((v) => typeof v === "string"))
  )
    throw new Error("invalid MCP command environment");
  return {
    name,
    command: value.command,
    args,
    env: env as Record<string, string> | undefined,
    enabled,
    alwaysLoad,
  };
}

export function parseMcpServers(
  servers: unknown,
  warn: (message: string) => void,
): McpServerSpec[] {
  if (servers === undefined) return [];
  if (!record(servers)) throw new Error("mcpServers must be an object");
  const result: McpServerSpec[] = [];
  for (const [name, value] of Object.entries(servers)) {
    try {
      result.push(parseMcpServer(name, value));
    } catch (error) {
      warn(`[mcp] ${name}: ${(error as Error).message}`);
    }
  }
  return result;
}
