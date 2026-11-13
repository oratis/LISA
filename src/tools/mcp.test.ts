import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point lisaHome() at a temp dir BEFORE importing modules that resolve paths.
process.env.LISA_HOME = mkdtempSync(path.join(tmpdir(), "lisa-mcp-"));
const { mcpTool } = await import("./mcp.js");

const ctx = { cwd: "/tmp", signal: new AbortController().signal, log() {} };

describe("mcp tool", () => {
  test("list is empty initially", async () => {
    assert.match(await mcpTool.execute({ action: "list" }, ctx), /no MCP servers configured/);
  });

  test("add → list → remove round-trips", async () => {
    const add = await mcpTool.execute(
      {
        action: "add",
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      },
      ctx,
    );
    assert.match(add, /Added MCP server "filesystem"/);

    const list = await mcpTool.execute({ action: "list" }, ctx);
    assert.match(list, /filesystem: npx -y @modelcontextprotocol\/server-filesystem \/data/);

    const rm = await mcpTool.execute({ action: "remove", name: "filesystem" }, ctx);
    assert.match(rm, /Removed MCP server "filesystem"/);
    assert.match(await mcpTool.execute({ action: "list" }, ctx), /no MCP servers configured/);
  });

  test("remote add, list and remove keep the endpoint path out of chat", async () => {
    const added = await mcpTool.execute(
      {
        action: "add",
        name: "docs",
        url: "https://docs.example.org/private-path",
        allowedTools: ["search"],
      },
      ctx,
    );
    assert.match(added, /Added MCP server "docs"/);
    const listed = await mcpTool.execute({ action: "list" }, ctx);
    assert.match(listed, /docs: HTTPS https:\/\/docs.example.org \(tools: search\)/);
    assert.doesNotMatch(added + listed, /private-path/);
    await assert.rejects(
      mcpTool.execute(
        { action: "add", name: "docs", command: "sh", url: "https://a.example/mcp" },
        ctx,
      ),
    );
    assert.match(await mcpTool.execute({ action: "remove", name: "docs" }, ctx), /Removed/);
  });

  test("add validates required fields; remove validates name", async () => {
    assert.match(
      await mcpTool.execute({ action: "add", name: "x" }, ctx),
      /needs a name and a command/,
    );
    assert.match(await mcpTool.execute({ action: "remove" }, ctx), /needs a name/);
    assert.match(
      await mcpTool.execute({ action: "remove", name: "nope" }, ctx),
      /no MCP server named/,
    );
  });
});
