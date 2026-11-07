import { test } from "node:test";
import assert from "node:assert/strict";
import { withReadonlyMcp } from "./readonly-http.js";
import type { McpFetch } from "./http.js";
const endpoint = "https://mcp.linear.app/mcp/readonly";
test("Streamable HTTP supports JSON and SSE without exposing unreviewed tools or prompts", async () => {
  for (const sse of [false, true]) {
    let calls = 0;
    const fetcher: McpFetch = async (url, init) => {
      assert.equal(String(url), endpoint);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token");
      const msg = JSON.parse(String(init?.body));
      if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      if (msg.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
      else if (msg.method === "tools/list")
        result = {
          tools: [
            {
              name: "reviewed_read",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
            {
              name: "delete_everything",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        };
      else {
        assert.equal(msg.method, "tools/call");
        assert.equal(msg.params.name, "reviewed_read");
        calls++;
        result = {
          content: [{ type: "text", text: JSON.stringify({ value: "untrusted result" }) }],
        };
      }
      const body = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      return new Response(sse ? "event: message\ndata: " + body + "\n\n" : body, {
        headers: { "Content-Type": sse ? "text/event-stream" : "application/json" },
      });
    };
    await withReadonlyMcp(
      endpoint,
      "fixture-token",
      fetcher,
      AbortSignal.timeout(5000),
      ["reviewed_read"],
      async (mcp) => {
        await assert.rejects(mcp.call("delete_everything", {}), /read_operation_required/);
        await assert.rejects(
          mcp.call("reviewed_read", { team: "removed-schema-parameter" }),
          /mcp_tools_changed/,
        );
        assert.deepEqual(await mcp.call("reviewed_read", {}), { value: "untrusted result" });
      },
    );
    assert.equal(calls, 1);
  }
});
