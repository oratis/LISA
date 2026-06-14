import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mcpToolToLisaTool } from "./client.js";

// A minimal fake MCP client — only callTool is exercised by the mapping.
function fakeClient(impl: (args: { name: string; arguments: Record<string, unknown> }) => unknown): Client {
  return { callTool: async (a: { name: string; arguments: Record<string, unknown> }) => impl(a) } as unknown as Client;
}

describe("mcpToolToLisaTool — mapping", () => {
  test("prefixes the tool name and tags the description by server", () => {
    const t = mcpToolToLisaTool("files", fakeClient(() => ({ content: [] })), { name: "read", description: "Read a file" }, () => {});
    assert.equal(t.name, "mcp__files__read");
    assert.match(t.description, /\[mcp:files\]/);
    assert.match(t.description, /Read a file/);
  });

  test("falls back to a default description when none is given", () => {
    const t = mcpToolToLisaTool("git", fakeClient(() => ({ content: [] })), { name: "status" }, () => {});
    assert.match(t.description, /\[mcp:git\] status/);
  });

  test("coerces a non-object inputSchema to an empty object schema", () => {
    const t = mcpToolToLisaTool("x", fakeClient(() => ({ content: [] })), { name: "y", inputSchema: undefined }, () => {});
    assert.deepEqual(t.inputSchema, { type: "object", properties: {} });
    const t2 = mcpToolToLisaTool("x", fakeClient(() => ({ content: [] })), { name: "y", inputSchema: { type: "object", properties: { a: { type: "string" } } } }, () => {});
    assert.equal((t2.inputSchema as { type: string }).type, "object");
  });
});

describe("mcpToolToLisaTool — execute() result flattening", () => {
  test("joins text blocks; passes the input through as arguments", async () => {
    let passed: Record<string, unknown> | undefined;
    const t = mcpToolToLisaTool("s", fakeClient((a) => { passed = a.arguments; return { content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] }; }), { name: "go" }, () => {});
    const out = await t.execute({ q: 1 } as never, {} as never);
    assert.equal(out, "line1\nline2");
    assert.deepEqual(passed, { q: 1 });
  });

  test("non-text content renders as a [type] placeholder", async () => {
    const t = mcpToolToLisaTool("s", fakeClient(() => ({ content: [{ type: "image" }, { type: "text", text: "ok" }] })), { name: "go" }, () => {});
    assert.equal(await t.execute({} as never, {} as never), "[image]\nok");
  });

  test("empty content → \"(empty)\"", async () => {
    const t = mcpToolToLisaTool("s", fakeClient(() => ({ content: [] })), { name: "go" }, () => {});
    assert.equal(await t.execute({} as never, {} as never), "(empty)");
  });

  test("isError is logged but the text is still returned", async () => {
    const logs: string[] = [];
    const t = mcpToolToLisaTool("s", fakeClient(() => ({ content: [{ type: "text", text: "boom" }], isError: true })), { name: "go" }, (m) => logs.push(m));
    const out = await t.execute({} as never, {} as never);
    assert.equal(out, "boom");
    assert.ok(logs.some((l) => /isError/.test(l)));
  });
});
