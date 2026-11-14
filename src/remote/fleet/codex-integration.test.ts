import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalCodex } from "./codex.js";

test(
  "the installed native Codex reviews a packet through a local Responses fixture",
  {
    skip: process.platform !== "darwin" || !process.env.LISA_FLEET_TEST_CODEX,
    timeout: 45000,
  },
  async (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-real-")));
    const source = path.join(dir, "source"),
      home = path.join(dir, "lisa");
    fs.mkdirSync(source);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(source, "private.txt"), "not-in-the-preview");
    const requests: Record<string, unknown>[] = [];
    const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (!req.url?.endsWith("/responses")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const item = {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "packet-reviewed", annotations: [] }],
      };
      const response = {
        id: "resp_fixture",
        object: "response",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: "packet-reviewed",
        },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    };
    const server = http.createServer((req, res) => {
      void handle(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const previous = {
      LISA_PTY_CODEX_CMD: process.env.LISA_PTY_CODEX_CMD,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    };
    Object.assign(process.env, {
      LISA_PTY_CODEX_CMD: process.env.LISA_FLEET_TEST_CODEX,
      OPENAI_API_KEY: "fixture-not-a-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    });
    const results: string[] = [];
    const failures: string[] = [];
    let done!: (err: string) => void;
    const exited = new Promise<string>((resolve) => {
      done = resolve;
    });
    const session = new LocalCodex(home, port + 1).start(source, {
      approval() {
        assert.fail("packet review cannot request approval");
      },
      result: (text, error) => {
        if (error) failures.push(text);
        else results.push(text);
      },
      exit: done,
    });
    t.after(() => {
      if (!results.length) t.diagnostic(JSON.stringify({ requests: requests.length, failures }));
      session.cancel();
      server.closeAllConnections();
      server.close();
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    session.send("Review the confirmed packet: -before +after. Validation was not run.");
    assert.equal(await exited, "", JSON.stringify({ failures, requests: requests.length }));
    assert.deepEqual(results, ["packet-reviewed"]);
    assert.equal(requests.length, 1);
    assert.match(JSON.stringify(requests[0]!.input), /confirmed packet/);
    assert.doesNotMatch(JSON.stringify(requests), /not-in-the-preview/);
    assert.ok(
      !((requests[0]!.tools ?? []) as { name?: string; type: string }[]).some((tool) =>
        /exec_command|shell|apply_patch|mcp|web_search|view_image/.test(tool.name ?? tool.type),
      ),
    );
  },
);
