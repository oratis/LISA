/**
 * mcp (integration) — manage LISA's MCP server connections, so she can connect
 * any integration that ships an MCP server (GitHub, Linear, Sentry, Postgres,
 * filesystem, …) on request, rather than each needing a bespoke tool. MCP is
 * the standard way to "add all the integrations an agent might use".
 *
 *   list   — configured MCP servers (from ~/.lisa/mcp.json)
 *   add    — add a server (name + command [+ args/env]); connects on next start
 *   remove — remove a server
 *
 * Servers connect at startup, so add/remove take effect after a restart
 * (`lisa serve --web`). Their tools then appear in LISA's toolset automatically.
 */
import type { ToolDefinition } from "../types.js";
import { loadMcpConfig, saveMcpServer, deleteMcpServer, MCP_CONFIG_PATH } from "../mcp/config.js";

interface McpInput {
  action: "list" | "add" | "remove";
  name?: string;
  /** For add: the server command, e.g. "npx". */
  command?: string;
  /** For add: command args, e.g. ["-y","@modelcontextprotocol/server-filesystem","/path"]. */
  args?: string[];
  /** For add: env vars the server needs (e.g. API tokens). */
  env?: Record<string, string>;
  enabled?: boolean;
}

export const mcpTool: ToolDefinition<McpInput, string> = {
  name: "mcp",
  description:
    "Manage MCP server connections — the standard way to add external integrations (GitHub, Linear, " +
    "Sentry, Postgres, filesystem, …) whose tools then appear in LISA's toolset. action:'list' shows " +
    "configured servers; 'add' (name + command [+ args/env]) adds one; 'remove' (name) deletes one. " +
    "Servers connect at startup, so add/remove take effect after restarting `lisa serve --web`. Use " +
    "when the user wants to connect a new integration via its MCP server.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "remove"] },
      name: { type: "string", description: "Server name (for add/remove)." },
      command: { type: "string", description: "Executable for add, e.g. 'npx'." },
      args: { type: "array", items: { type: "string" }, description: "Args for add, e.g. ['-y','@scope/server-x']." },
      env: { type: "object", additionalProperties: { type: "string" }, description: "Env vars the server needs (e.g. API tokens)." },
      enabled: { type: "boolean", description: "Whether the server is enabled (default true)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async execute(input) {
    if (input.action === "list") {
      const servers = await loadMcpConfig();
      if (servers.length === 0) {
        return `(no MCP servers configured — add one with mcp action:'add', or edit ${MCP_CONFIG_PATH})`;
      }
      return (
        `${servers.length} MCP server(s) in ${MCP_CONFIG_PATH}:\n` +
        servers
          .map((s) => `  ${s.name}${s.enabled === false ? " (disabled)" : ""}: ${s.command} ${(s.args ?? []).join(" ")}`.trimEnd())
          .join("\n")
      );
    }

    if (input.action === "remove") {
      if (!input.name) return "(remove needs a name — from mcp action:'list')";
      const ok = await deleteMcpServer(input.name);
      return ok
        ? `Removed MCP server "${input.name}". Restart \`lisa serve --web\` for it to disconnect.`
        : `(no MCP server named "${input.name}")`;
    }

    // add
    if (!input.name || !input.command) {
      return "(add needs a name and a command, e.g. name:'filesystem' command:'npx' args:['-y','@modelcontextprotocol/server-filesystem','/path'])";
    }
    await saveMcpServer(input.name, {
      command: input.command,
      args: input.args ?? [],
      env: input.env,
      enabled: input.enabled ?? true,
    });
    return (
      `Added MCP server "${input.name}": ${input.command} ${(input.args ?? []).join(" ")}`.trimEnd() +
      `\nRestart \`lisa serve --web\` to connect it — its tools then appear in my toolset automatically.`
    );
  },
};
