import assert from "node:assert/strict";
import { test } from "node:test";
import { connectMcpServers } from "./client.js";
import type { SafeFetchDependencies } from "../tools/web_fetch.js";
import type { McpServerSpec } from "./spec.js";

const url = "https://docs.example.org/mcp";
const spec: McpServerSpec = { name: "docs", type: "http", url, allowedTools: ["search"] };
const lookup: SafeFetchDependencies["lookup"] = async () => [{ address: "1.1.1.1", family: 4 }];
const initialize = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: {} },
  serverInfo: { name: "docs", version: "1" },
};
const ctx = { cwd: ".", signal: AbortSignal.timeout(5000), log() {} };

test("public MCP registers the scoped tool, delivers a live SSE result and closes the session", async () => {
  const methods: string[] = [];
  let cancelled = false;
  const found = await connectMcpServers([spec], () => {}, {
    lookup,
    transport: async (endpoint, init, address) => {
      assert.equal(endpoint, url);
      assert.equal(address.address, "1.1.1.1");
      assert.equal(init.redirect, "manual");
      const headers = new Headers(init.headers);
      assert.ok(!headers.has("authorization") && !headers.has("cookie"));
      if (init.method === "DELETE") {
        assert.equal(headers.get("mcp-session-id"), "session");
        methods.push("DELETE");
        return new Response(null, { status: 204 });
      }
      const message = JSON.parse(String(init.body));
      methods.push(message.method);
      let result: unknown = initialize;
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (message.method === "tools/list") {
        const first = !message.params?.cursor;
        result = {
          tools: [{ name: first ? "delete" : "search", inputSchema: { type: "object" } }],
          ...(first ? { nextCursor: "page2" } : {}),
        };
      }
      if (message.method === "tools/call") {
        assert.deepEqual(message.params, { name: "search", arguments: { q: "docs" } });
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [], structuredContent: { hits: 3 } },
        });
        // The POST stream remains open after delivering the result.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode("event: message\ndata: " + body + "\n\n"),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json(
        { jsonrpc: "2.0", id: message.id, result },
        { headers: { "mcp-session-id": "session" } },
      );
    },
  });
  assert.equal(found.length, 1);
  const server = found[0]!;
  try {
    assert.deepEqual(
      server.tools.map((t) => t.name),
      ["mcp__docs__search"],
    );
    assert.equal(await server.tools[0]!.execute({ q: "docs" }, ctx), '{"hits":3}');
  } finally {
    await server.close();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(cancelled);
  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/list",
    "tools/call",
    "DELETE",
  ]);
});

test("public MCP refuses DNS rebinding, redirects, missing grants and repeated cursors", async () => {
  for (const failure of ["dns", "rebind", "redirect", "401", "missing", "cursor"]) {
    const logs: string[] = [];
    let contacts = 0;
    const servers = await connectMcpServers([spec], (s) => logs.push(s), {
      lookup: async () =>
        failure === "dns" || (failure === "rebind" && contacts > 0)
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "1.1.1.1", family: 4 }],
      transport: async (endpoint, init) => {
        contacts++;
        assert.equal(endpoint, url);
        if (failure === "redirect") return Response.redirect("https://evil.example/other");
        if (failure === "401") return new Response("sensitive response", { status: 401 });
        const msg = JSON.parse(String(init.body));
        if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          msg.method === "initialize"
            ? initialize
            : {
                tools: [],
                ...(failure === "cursor" ? { nextCursor: "repeat" } : {}),
              };
        return Response.json({ jsonrpc: "2.0", id: msg.id, result });
      },
    });
    assert.deepEqual(servers, [], failure);
    assert.match(logs.join(" "), /failed to connect/);
    assert.doesNotMatch(logs.join(" "), /sensitive response/);
    if (failure === "dns") assert.equal(contacts, 0);
    if (failure === "redirect" || failure === "401" || failure === "rebind")
      assert.equal(contacts, 1);
  }
});

test("a paginated allowlist validates structured output and skips unrelated output schemas", async () => {
  const servers = await connectMcpServers([spec], () => {}, {
    lookup,
    transport: async (_endpoint, init) => {
      const msg = JSON.parse(String(init.body));
      if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown = initialize;
      if (msg.method === "tools/list") {
        result = !msg.params.cursor
          ? {
              tools: [
                {
                  name: "search",
                  inputSchema: { type: "object" },
                  outputSchema: { type: "object", required: ["hits"] },
                },
              ],
              nextCursor: "next",
            }
          : {
              tools: [
                {
                  name: "unselected",
                  inputSchema: { type: "object" },
                  outputSchema: {
                    type: "object",
                    properties: { data: { $ref: "https://example.org/unknown" } },
                  },
                },
              ],
            };
      } else if (msg.method === "tools/call")
        result = { content: [], structuredContent: { wrong: 3 } };
      return Response.json({ jsonrpc: "2.0", id: msg.id, result });
    },
  });
  assert.equal(servers.length, 1);
  try {
    await assert.rejects(servers[0]!.tools[0]!.execute({}, ctx), /invalid structured content/);
  } finally {
    await servers[0]!.close();
  }
});

test("a disabled home entry reserves its name without dialing a plugin duplicate", async () => {
  let connected = false;
  const logs: string[] = [];
  const servers = await connectMcpServers(
    [{ ...spec, enabled: false }, spec],
    (s) => logs.push(s),
    {
      lookup: async () => {
        connected = true;
        return [];
      },
    },
  );
  assert.deepEqual(servers, []);
  assert.equal(connected, false);
  assert.match(logs.join(" "), /duplicate server name/);
});
