import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mcpHttpTransport } from "./transport.js";
import { ConnectorError } from "../connectors/types.js";
import type { McpFetch } from "./http.js";
export interface ReadonlyMcp {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}
/** No server-provided prompts, tools, resources, sampling, or elicitation reach the agent. */
export async function withReadonlyMcp<T>(
  endpoint: string,
  token: string,
  fetcher: McpFetch,
  signal: AbortSignal,
  reviewed: readonly string[],
  work: (mcp: ReadonlyMcp) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "lisa-readonly", version: "0.1.0" }, { capabilities: {} });
  const transport = mcpHttpTransport(endpoint, fetcher, token);
  const abort = () => {
    void client.close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect(transport, { timeout: 30_000 });
    let cursor: string | undefined;
    const found = new Map<
      string,
      {
        inputSchema: { type?: unknown; properties?: Record<string, unknown>; required?: string[] };
        annotations?: { readOnlyHint?: boolean };
      }
    >();
    for (let page = 0; page < 4; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 30_000 });
      for (const tool of result.tools) {
        if (found.has(tool.name)) throw new ConnectorError("mcp_tools_changed");
        found.set(tool.name, tool);
      }
      if (found.size > 200) throw new ConnectorError("mcp_tools_changed");
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (cursor) throw new ConnectorError("mcp_tools_changed");
    for (const name of reviewed) {
      const tool = found.get(name);
      if (!tool || tool.annotations?.readOnlyHint === false || tool.inputSchema.type !== "object")
        throw new ConnectorError("mcp_tools_changed");
    }
    return await work({
      call: async (name, args) => {
        signal.throwIfAborted();
        if (!reviewed.includes(name)) throw new ConnectorError("read_operation_required");
        const schema = found.get(name)!.inputSchema;
        // Do not let a changed/removed scope parameter turn a selected-team read into
        // a workspace-wide query, even when the server silently ignores unknown args.
        if (
          Object.keys(args).some((key) => !Object.hasOwn(schema.properties ?? {}, key)) ||
          schema.required?.some((key) => !Object.hasOwn(args, key))
        )
          throw new ConnectorError("mcp_tools_changed");
        const result = await client.callTool({ name, arguments: args }, undefined, {
          signal,
          timeout: 30_000,
        });
        if (result.isError) throw new ConnectorError("mcp_tool_failed");
        if (result.structuredContent) return result.structuredContent;
        const parts = result.content as Array<{ type: string; text?: string }>;
        if (parts.length !== 1 || parts[0]?.type !== "text" || typeof parts[0].text !== "string")
          throw new ConnectorError("mcp_invalid_response");
        try {
          return JSON.parse(parts[0].text) as unknown;
        } catch {
          throw new ConnectorError("mcp_invalid_response");
        }
      },
    });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError(signal.aborted ? "request_cancelled" : "mcp_unavailable");
  } finally {
    signal.removeEventListener("abort", abort);
    await client.close().catch(() => {});
  }
}
