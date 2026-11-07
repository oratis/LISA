import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import type { ToolDefinition } from "../types.js";
import type { McpServerSpec } from "./spec.js";
import { remoteFetch } from "./http.js";
import { mcpHttpTransport } from "./transport.js";
import type { SafeFetchDependencies } from "../tools/web_fetch.js";
import { childEnv } from "../child-env.js";

export interface ConnectedMcpServer {
  spec: McpServerSpec;
  client: Client;
  tools: ToolDefinition[];
  close(): Promise<void>;
}

export async function connectMcpServers(
  specs: McpServerSpec[],
  log: (msg: string) => void = () => {},
  network?: Pick<SafeFetchDependencies, "lookup" | "transport">,
): Promise<ConnectedMcpServer[]> {
  const out: ConnectedMcpServer[] = [];
  const names = new Set<string>();
  for (const spec of specs) {
    if (names.has(spec.name)) {
      log(`[mcp] ${spec.name}: duplicate server name; skipped`);
      continue;
    }
    names.add(spec.name);
    if (spec.enabled === false) continue;
    try {
      const connected = await connectOne(spec, log, network);
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
  network?: Pick<SafeFetchDependencies, "lookup" | "transport">,
): Promise<ConnectedMcpServer> {
  const lifetime = new AbortController();
  const transport =
    spec.type === "http"
      ? mcpHttpTransport(
          spec.url,
          remoteFetch(
            (url, method) => url.href === spec.url && (method === "POST" || method === "DELETE"),
            lifetime.signal,
            network,
            "HTTP MCP requires a public endpoint without sign-in",
          ),
        )
      : new StdioClientTransport({
          command: spec.command,
          args: spec.args ?? [],
          env: { ...childEnv(), ...(spec.env ?? {}) } as Record<string, string>,
        });
  const schemas = new AjvJsonSchemaValidator();
  const client = new Client(
    { name: "lisa", version: "0.1.0" },
    { capabilities: {}, jsonSchemaValidator: schemas },
  );
  async function close() {
    try {
      if ("terminateSession" in transport) await transport.terminateSession();
    } finally {
      lifetime.abort();
      await client.close();
    }
  }
  try {
    const options = { signal: AbortSignal.timeout(30_000), timeout: 30_000 };
    await client.connect(transport, options);
    const tools: ToolDefinition[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    const allowed =
      spec.type === "http" && spec.allowedTools ? new Set(spec.allowedTools) : undefined;
    let cursor: string | undefined;
    do {
      // listTools() compiles every advertised output schema and replaces that
      // cache on each page. Compile only the tools this host actually exposes.
      const page = await client.request(
        { method: "tools/list", params: cursor ? { cursor } : {} },
        ListToolsResultSchema,
        options,
      );
      for (const tool of page.tools) {
        if (seen.has(tool.name) || seen.size >= 2048)
          throw new Error("duplicate or oversized MCP tool catalog");
        seen.add(tool.name);
        if (allowed && !allowed.has(tool.name)) continue;
        if (tool.execution?.taskSupport === "required") continue;
        if (
          spec.type === "http" &&
          (!/^[a-zA-Z0-9_-]{1,64}$/.test(`mcp__${spec.name}__${tool.name}`) ||
            tool.name.includes("__"))
        )
          continue;
        const validate = tool.outputSchema ? schemas.getValidator(tool.outputSchema) : undefined;
        tools.push(mcpToolToLisaTool(spec.name, client, tool, log, validate));
      }
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 31))
        throw new Error("invalid MCP tool pagination");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (allowed && tools.length !== allowed.size)
      throw new Error("one or more configured MCP tools are unavailable");
    return { spec, client, tools, close: () => close().catch(() => {}) };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

export function mcpToolToLisaTool(
  serverName: string,
  client: Client,
  mcpTool: {
    name: string;
    description?: string;
    inputSchema?: object;
    annotations?: {
      title?: string;
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  },
  log: (msg: string) => void,
  validateOutput?: JsonSchemaValidator<unknown>,
): ToolDefinition {
  const name = `mcp__${serverName}__${mcpTool.name}`;
  const description = mcpTool.description
    ? `[mcp:${serverName}] ${mcpTool.description}`
    : `[mcp:${serverName}] ${mcpTool.name}`;
  return {
    name,
    description,
    ...(mcpTool.annotations ? { annotations: { ...mcpTool.annotations } } : {}),
    inputSchema:
      (mcpTool.inputSchema as { type?: string; properties?: object } | undefined)?.type === "object"
        ? (mcpTool.inputSchema as { type: "object"; properties?: object })
        : { type: "object" as const, properties: {} },
    async execute(input: unknown, ctx) {
      const result = await client.callTool(
        {
          name: mcpTool.name,
          arguments: (input ?? {}) as Record<string, unknown>,
        },
        undefined,
        { signal: ctx.signal },
      );
      if (
        validateOutput &&
        !result.isError &&
        (!result.structuredContent || !validateOutput(result.structuredContent).valid)
      )
        throw new Error(`MCP tool ${name} returned invalid structured content`);
      const content = (result.content as Array<{ type: string; text?: string }>) ?? [];
      const text = content
        .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
        .join("\n");
      if (result.isError) {
        log(`[mcp] ${name} returned isError`);
        throw new Error(text || `MCP tool ${name} failed`);
      }
      return (
        text || (result.structuredContent ? JSON.stringify(result.structuredContent) : "(empty)")
      );
    },
  };
}
