import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDefinition } from "../types.js";
import type { McpServerSpec } from "./config.js";

export interface ConnectedMcpServer {
  spec: McpServerSpec;
  client: Client;
  tools: ToolDefinition[];
  close(): Promise<void>;
}

export async function connectMcpServers(
  specs: McpServerSpec[],
  log: (msg: string) => void = () => {},
): Promise<ConnectedMcpServer[]> {
  const out: ConnectedMcpServer[] = [];
  for (const spec of specs) {
    if (spec.enabled === false) continue;
    try {
      const connected = await connectOne(spec, log);
      out.push(connected);
      log(`[mcp] ${spec.name}: ${connected.tools.length} tools`);
    } catch (err) {
      log(`[mcp] ${spec.name}: failed to connect — ${(err as Error).message}`);
    }
  }
  return out;
}

async function connectOne(
  spec: McpServerSpec,
  log: (msg: string) => void,
): Promise<ConnectedMcpServer> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
  });
  const client = new Client(
    { name: "lisa", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const list = await client.listTools();
  const tools: ToolDefinition[] = list.tools.map((t) => mcpToolToLisaTool(spec.name, client, t, log));
  return {
    spec,
    client,
    tools,
    async close() {
      try {
        await client.close();
      } catch {}
    },
  };
}

export function mcpToolToLisaTool(
  serverName: string,
  client: Client,
  mcpTool: { name: string; description?: string; inputSchema?: object },
  log: (msg: string) => void,
): ToolDefinition {
  const name = `mcp__${serverName}__${mcpTool.name}`;
  const description = mcpTool.description
    ? `[mcp:${serverName}] ${mcpTool.description}`
    : `[mcp:${serverName}] ${mcpTool.name}`;
  return {
    name,
    description,
    inputSchema: ((mcpTool.inputSchema as { type?: string; properties?: object } | undefined)?.type === "object"
      ? (mcpTool.inputSchema as { type: "object"; properties?: object })
      : { type: "object" as const, properties: {} }) as { type: "object"; properties?: Record<string, unknown> },
    async execute(input: unknown) {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: (input ?? {}) as Record<string, unknown>,
      });
      const content = (result.content as Array<{ type: string; text?: string }>) ?? [];
      const text = content
        .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
        .join("\n");
      if (result.isError) {
        log(`[mcp] ${name} returned isError`);
      }
      return text || "(empty)";
    },
  };
}
