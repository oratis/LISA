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
import { fenceUntrusted } from "../tools/external-fence.js";
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
        ) {
          log(`[mcp] ${spec.name}: skipped tool ${JSON.stringify(tool.name.slice(0, 80))} (name)`);
          continue;
        }
        // A remote server's output schema is not compiled. It supplies both the
        // schema and the content checked against it, so the check proves
        // nothing about untrusted output, and a hostile pattern such as
        // `^(a+)+$` would block the event loop (and an unresolvable `$ref`
        // would drop the whole server). Only the shape is required.
        const validate = !tool.outputSchema
          ? undefined
          : spec.type === "http"
            ? structuredObject
            : schemas.getValidator(tool.outputSchema);
        tools.push(mcpToolToLisaTool(spec.name, client, tool, log, validate, spec.type === "http"));
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

/** For a remote tool that declares an output schema: structured content must be an object. */
const structuredObject: JsonSchemaValidator<unknown> = (input) =>
  input !== null && typeof input === "object" && !Array.isArray(input)
    ? { valid: true, data: input, errorMessage: undefined }
    : { valid: false, data: undefined, errorMessage: "structured content is not an object" };

/** What a remote server may put in front of the model, per result and per error. */
const REMOTE_RESULT_MAX_CHARS = 64_000;
const REMOTE_ERROR_MAX_CHARS = 2_000;
const REMOTE_DESCRIPTION_MAX_CHARS = 1_000;

function capped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated at ${max} chars]` : text;
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
  /**
   * A public HTTPS server rather than a local command. Its description is
   * capped (it goes into every turn's tool list), and its results and errors
   * reach the model fenced as untrusted content and capped in length.
   */
  remote = false,
): ToolDefinition {
  const name = `mcp__${serverName}__${mcpTool.name}`;
  const summary = remote
    ? capped(mcpTool.description ?? "", REMOTE_DESCRIPTION_MAX_CHARS)
    : mcpTool.description;
  const description = summary
    ? `[mcp:${serverName}] ${summary}`
    : `[mcp:${serverName}] ${mcpTool.name}`;
  const fence = (text: string, max: number) =>
    fenceUntrusted(capped(text, max), [["source", `mcp:${serverName}/${mcpTool.name}`]]);
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
        const failure = text || `MCP tool ${name} failed`;
        throw new Error(remote ? fence(failure, REMOTE_ERROR_MAX_CHARS) : failure);
      }
      const out =
        text || (result.structuredContent ? JSON.stringify(result.structuredContent) : "(empty)");
      return remote ? fence(out, REMOTE_RESULT_MAX_CHARS) : out;
    },
  };
}
