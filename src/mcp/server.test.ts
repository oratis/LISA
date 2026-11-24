import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, test } from "node:test";
import { homeScope } from "../paths.js";
import { readAudit } from "../warden/audit.js";
import {
  PortableLisaMcpServer,
  parseScopes,
  servePortableMcpStdio,
  startPortableMcpHttpServer,
} from "./server.js";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lisa-portable-mcp-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("PortableLisaMcpServer (stdio + Streamable HTTP)", () => {
  test("stdio transport handles initialize, tools/list, scope gating, disabled-draft task creation, and Warden audit", async () => {
    const home = path.join(TMP, "home-stdio");
    fs.mkdirSync(path.join(home, "soul"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "soul", "identity.md"),
      "I am Lisa. sk-ant-secret12345678901234567890",
    );

    await homeScope.run(home, async () => {
      const server = new PortableLisaMcpServer({
        home,
        scopes: parseScopes("persona:read,tasks:read"),
        clientLabel: "test-stdio",
      });

      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: string[] = [];
      output.on("data", (d) => chunks.push(d.toString("utf8")));

      const done = servePortableMcpStdio(server, { input, output });
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      input.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "lisa_persona", arguments: {} },
        }) + "\n",
      );
      // tasks:write was not granted -> denied!
      input.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "lisa_task_create",
            arguments: { title: "Draft", instruction: "Do work" },
          },
        }) + "\n",
      );
      input.end();
      await done;

      const replies = chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(replies.length, 4);
      assert.equal(replies[0].result.serverInfo.name, "lisa");
      assert.deepEqual(
        replies[1].result.tools.map((t: { name: string }) => t.name),
        ["lisa_persona", "lisa_task_list"],
      );
      const personaText: string = replies[2].result.content[0].text;
      assert.ok(personaText.includes("I am Lisa."));
      assert.ok(!personaText.includes("sk-ant-secret12345678901234567890"));
      assert.equal(replies[3].error.code, -32001);

      const audit = await readAudit({ home, limit: 10 });
      assert.ok(audit.some((e) => e.tool === "lisa_persona" && e.verdict === "allow"));
      assert.ok(audit.some((e) => e.tool === "lisa_task_create" && e.verdict === "deny"));

      // With tasks:write, task creation succeeds ONLY as a disabled draft.
      const writer = new PortableLisaMcpServer({
        home,
        scopes: parseScopes("tasks:read,tasks:write"),
        clientLabel: "test-writer",
      });
      const created = await writer.handleMessage({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "lisa_task_create",
          arguments: { title: "Check releases", instruction: "Read release notes", enabled: true },
        },
      });
      const createdPayload = JSON.parse(
        (created!.result as { content: Array<{ text: string }> }).content[0]!.text,
      );
      assert.equal(createdPayload.enabled, false);
      assert.equal(createdPayload.state, "draft");
    });
  });

  test("Streamable HTTP enforces 127.0.0.1 binding, mandatory Bearer token, and cross-site refusal", async () => {
    const home = path.join(TMP, "home-http");
    fs.mkdirSync(home, { recursive: true });
    const mcp = new PortableLisaMcpServer({ home, clientLabel: "test-http" });

    // Refuses non-loopback host or short token.
    await assert.rejects(
      () => startPortableMcpHttpServer(mcp, { host: "0.0.0.0", token: "a".repeat(32) }),
      /non-loopback/,
    );
    await assert.rejects(
      () => startPortableMcpHttpServer(mcp, { host: "127.0.0.1", token: "short" }),
      /at least 16/,
    );

    const token = "lisa-mcp-secret-token-0123456789abcdef";
    const handle = await startPortableMcpHttpServer(mcp, { host: "127.0.0.1", port: 0, token });
    try {
      // Missing token -> 401
      const noAuth = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      assert.equal(noAuth.status, 401);

      // Cross-site request -> 403
      const crossSite = await fetch(handle.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          origin: "https://evil.example",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      });
      assert.equal(crossSite.status, 403);

      // Valid Bearer token -> 200
      const ok = await fetch(handle.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      });
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as { result: { tools: Array<{ name: string }> } };
      assert.ok(body.result.tools.some((t) => t.name === "lisa_persona"));
    } finally {
      await handle.close();
    }
  });
});
