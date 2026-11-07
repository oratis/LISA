import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConnectorError } from "../connectors/types.js";
import type { McpFetch } from "./http.js";

/** Task reads and custom tool calls only need the POST response stream. */
export function mcpHttpTransport(endpoint: string, fetcher: McpFetch, token?: string) {
  return new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: "manual" },
    fetch: async (url, init) => {
      const raw = url instanceof Request ? url.url : String(url);
      if (raw !== endpoint) throw new ConnectorError("mcp_invalid_endpoint");
      // Background notifications are unnecessary for bounded task reads.
      if (init?.method === "GET") return new Response(null, { status: 405 });
      return fetcher(raw, init);
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
}
