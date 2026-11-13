import type { ToolDefinition } from "../types.js";
import { loadMcpConfig, saveMcpServer, deleteMcpServer, MCP_CONFIG_PATH } from "../mcp/config.js";
import { parseMcpServer, type McpServerSpec } from "../mcp/spec.js";

interface McpInput {
  action: "list" | "add" | "remove";
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  allowedTools?: string[];
  enabled?: boolean;
}

function destination(spec: McpServerSpec): string {
  if (spec.type === "http")
    return (
      `HTTPS ${new URL(spec.url).origin}` +
      (spec.allowedTools ? ` (tools: ${spec.allowedTools.join(", ") || "none"})` : "")
    );
  return [spec.command, ...(spec.args ?? [])].join(" ");
}

export const mcpTool: ToolDefinition<McpInput, string> = {
  name: "mcp",
  description:
    "Manage this host's custom MCP servers. List shows configuration. Add a local command with " +
    "args/env, or a public HTTPS Streamable HTTP URL with optional exact allowedTools. Use only " +
    "for an explicit custom MCP request. For a supported account app, use its built-in connector. " +
    "Configuration changes take effect on restart. Never ask for credentials in chat.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "remove"] },
      name: { type: "string", description: "Server name for add/remove." },
      command: { type: "string", description: "Local stdio executable, e.g. npx." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments for a local command.",
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Explicit environment for a local command.",
      },
      url: {
        type: "string",
        description: "Public HTTPS MCP endpoint without credentials, query, or fragment.",
      },
      allowedTools: {
        type: "array",
        items: { type: "string" },
        description: "Exact HTTP server tool names to register. Omit to register all.",
      },
      enabled: { type: "boolean" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async execute(input) {
    if (input.action === "list") {
      const warnings: string[] = [];
      const servers = await loadMcpConfig((message) => warnings.push(message));
      if (!servers.length && !warnings.length)
        return `(no MCP servers configured — add one with mcp action:'add', or edit ${MCP_CONFIG_PATH})`;
      return [
        `Configured MCP servers in ${MCP_CONFIG_PATH} (loaded at startup):`,
        ...servers.map(
          (s) => `  ${s.name}${s.enabled === false ? " (disabled)" : ""}: ${destination(s)}`,
        ),
        ...warnings,
      ].join("\n");
    }
    if (input.action === "remove") {
      if (!input.name) return "(remove needs a name — from mcp action:'list')";
      return (await deleteMcpServer(input.name))
        ? `Removed MCP server "${input.name}". Restart Lisa to disconnect it.`
        : `(no MCP server named "${input.name}")`;
    }
    const { action, name, ...config } = input;
    if (action !== "add" || !name || (!config.command && !config.url))
      return "(add needs a name and a command or public HTTPS URL)";
    const { name: serverName, ...spec } = parseMcpServer(name, config);
    await saveMcpServer(serverName, spec);
    return `Added MCP server "${serverName}". Restart Lisa to apply the configuration.`;
  },
};
