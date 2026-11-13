import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("plugin MCP entries use the same remote format and preserve legacy commands", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-plugin-mcp-"));
  process.env.LISA_HOME = home;
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const plugin = path.join(home, "plugins", "fixture");
  await fs.mkdir(plugin, { recursive: true });
  await fs.writeFile(
    path.join(plugin, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: { url: "https://example.org/mcp", allowedTools: ["search"] },
        local: { command: "test-stdio", args: ["demo"] },
      },
    }),
  );
  const { loadAllPlugins } = await import("./loader.js");
  const [loaded] = await loadAllPlugins();
  const [docs, local] = loaded!.mcpServers;
  assert.ok(docs && docs.type === "http");
  assert.equal(docs.url, "https://example.org/mcp");
  assert.deepEqual(docs.allowedTools, ["search"]);
  assert.ok(local && local.type !== "http");
  assert.equal(local.command, "test-stdio");
});
