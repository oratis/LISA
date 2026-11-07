import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mcpToolToLisaTool } from "./client.js";

// A minimal fake MCP client — only callTool is exercised by the mapping.
function fakeClient(
  impl: (args: { name: string; arguments: Record<string, unknown> }) => unknown,
): Client {
  return {
    callTool: async (a: { name: string; arguments: Record<string, unknown> }) => impl(a),
  } as unknown as Client;
}

describe("mcpToolToLisaTool — mapping", () => {
  test("prefixes the tool name and tags the description by server", () => {
    const t = mcpToolToLisaTool(
      "files",
      fakeClient(() => ({ content: [] })),
      { name: "read", description: "Read a file" },
      () => {},
    );
    assert.equal(t.name, "mcp__files__read");
    assert.match(t.description, /\[mcp:files\]/);
    assert.match(t.description, /Read a file/);
  });

  test("falls back to a default description when none is given", () => {
    const t = mcpToolToLisaTool(
      "git",
      fakeClient(() => ({ content: [] })),
      { name: "status" },
      () => {},
    );
    assert.match(t.description, /\[mcp:git\] status/);
  });

  test("coerces a non-object inputSchema to an empty object schema", () => {
    const t = mcpToolToLisaTool(
      "x",
      fakeClient(() => ({ content: [] })),
      { name: "y", inputSchema: undefined },
      () => {},
    );
    assert.deepEqual(t.inputSchema, { type: "object", properties: {} });
    const t2 = mcpToolToLisaTool(
      "x",
      fakeClient(() => ({ content: [] })),
      { name: "y", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
      () => {},
    );
    assert.equal((t2.inputSchema as { type: string }).type, "object");
  });

  test("preserves MCP annotations as untrusted policy metadata", () => {
    const t = mcpToolToLisaTool(
      "social",
      fakeClient(() => ({ content: [] })),
      {
        name: "publish",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      () => {},
    );
    assert.deepEqual(t.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});

describe("mcpToolToLisaTool — execute() result flattening", () => {
  test("joins text blocks; passes the input through as arguments", async () => {
    let passed: Record<string, unknown> | undefined;
    const t = mcpToolToLisaTool(
      "s",
      fakeClient((a) => {
        passed = a.arguments;
        return {
          content: [
            { type: "text", text: "line1" },
            { type: "text", text: "line2" },
          ],
        };
      }),
      { name: "go" },
      () => {},
    );
    const out = await t.execute({ q: 1 }, {} as never);
    assert.equal(out, "line1\nline2");
    assert.deepEqual(passed, { q: 1 });
  });

  test("non-text content renders as a [type] placeholder", async () => {
    const t = mcpToolToLisaTool(
      "s",
      fakeClient(() => ({ content: [{ type: "image" }, { type: "text", text: "ok" }] })),
      { name: "go" },
      () => {},
    );
    assert.equal(await t.execute({}, {} as never), "[image]\nok");
  });

  test('empty content → "(empty)"', async () => {
    const t = mcpToolToLisaTool(
      "s",
      fakeClient(() => ({ content: [] })),
      { name: "go" },
      () => {},
    );
    assert.equal(await t.execute({}, {} as never), "(empty)");
  });

  test("isError reaches the agent as a failed tool call with its diagnostic", async () => {
    const logs: string[] = [];
    const t = mcpToolToLisaTool(
      "s",
      fakeClient(() => ({ content: [{ type: "text", text: "boom" }], isError: true })),
      { name: "go" },
      (m) => logs.push(m),
    );
    await assert.rejects(t.execute({}, {} as never), /boom/);
    assert.ok(logs.some((l) => /isError/.test(l)));
  });
});

test("a command-only stdio config can discover and call a tool through the shared client", async () => {
  const { connectMcpServers } = await import("./client.js");
  const serverScript = `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    readline.on("line", line => {
      const msg = JSON.parse(line);
      if (msg.id === undefined) return;
      const results = {
        initialize: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } },
        "tools/list": { tools: [{ name: "read", inputSchema: { type: "object" } }] },
        "tools/call": { content: [{ type: "text", text: "legacy read" }] }
      };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: results[msg.method] }) + "\\n");
    });
  `;
  const [server] = await connectMcpServers([
    { name: "legacy", command: process.execPath, args: ["-e", serverScript] },
  ]);
  assert.ok(server);
  try {
    assert.equal(server.tools[0]?.name, "mcp__legacy__read");
    assert.equal(
      await server.tools[0].execute({}, { cwd: ".", signal: AbortSignal.timeout(3000), log() {} }),
      "legacy read",
    );
  } finally {
    await server.close();
  }
});
