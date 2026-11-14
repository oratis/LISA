import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalCodexWorkspace } from "./codex-workspace.js";
import type { Approval } from "./claude.js";

test(
  "native Codex workspace tools require fresh approvals, reject escape, and support another turn",
  {
    skip: process.platform !== "darwin" || !process.env.LISA_FLEET_TEST_CODEX,
    timeout: 45_000,
  },
  async (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-workspace-")));
    const root = path.join(dir, "project"),
      home = path.join(dir, "lisa");
    fs.mkdirSync(root);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(root, "a.txt"), "before");
    fs.writeFileSync(path.join(dir, "private.txt"), "not-for-model");
    const requests: Record<string, unknown>[] = [],
      approvals: Approval[] = [],
      results: string[] = [],
      failures: string[] = [];
    const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (!req.url?.endsWith("/responses")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const n = requests.length;
      const tools: Record<number, [string, object]> = {
        1: ["fleet_read", { file_path: "a.txt" }],
        2: ["fleet_edit", { file_path: "a.txt", old_string: "before", new_string: "after" }],
        3: ["fleet_write", { file_path: "denied.txt", content: "must not exist" }],
        4: ["fleet_read", { file_path: "../private.txt" }],
        6: ["fleet_list", { file_path: "." }],
      };
      const tool = tools[n];
      const item =
        n === 7
          ? {
              type: "custom_tool_call",
              id: "fc_patch",
              call_id: "call_patch",
              name: "apply_patch",
              input: `*** Begin Patch\n*** Update File: ${path.join(root, "a.txt")}\n@@\n-after\n+unapproved\n*** End Patch`,
              status: "completed",
            }
          : n === 6
            ? {
                type: "custom_tool_call",
                id: "fc_list",
                call_id: "call_list",
                name: "exec",
                namespace: "functions",
                input: 'text(await tools.fleet_list({file_path: "."}));',
                status: "completed",
              }
            : tool
              ? {
                  type: "function_call",
                  id: "fc_" + n,
                  call_id: "call_" + n,
                  name: tool[0],
                  arguments: JSON.stringify(tool[1]),
                  status: "completed",
                }
              : {
                  id: "msg_" + n,
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "turn-done-" + n, annotations: [] }],
                };
      const response = {
        id: "resp_" + n,
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
          item: { ...item, status: "in_progress" },
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
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const session = new LocalCodexWorkspace(home, port + 1).start(root, {
      approval(request) {
        if (!request) return;
        approvals.push(request);
        // Assert before approval, and yield so the native caller really waits for a decision.
        setImmediate(() => {
          try {
            if (request.tool === "Edit")
              assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "before");
            session.decide(request.id, request.tool !== "Write");
            assert.throws(() => session.decide(request.id, true), /stale_approval/);
          } catch (err) {
            failures.push(String(err));
            session.cancel();
            settle();
          }
        });
      },
      result(text, error) {
        if (error) {
          failures.push(text);
          settle();
          return;
        }
        results.push(text);
        if (results.length === 1) session.send("Now list the project directory.");
        else settle();
      },
      exit(error) {
        if (error) failures.push(error);
        settle();
      },
    });
    t.after(() => {
      session.cancel();
      server.closeAllConnections();
      server.close();
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    session.send(
      "Read a.txt and edit before to after, then try a denied write and an invalid path.",
    );
    await done;
    assert.deepEqual(
      failures,
      [],
      JSON.stringify({
        failures,
        results,
        requests: requests.length,
        approvals: approvals.map((a) => a.tool),
      }),
    );
    assert.deepEqual(results, ["turn-done-5", "turn-done-8"]);
    assert.deepEqual(
      approvals.map((a) => a.tool),
      ["Read", "Edit", "Write", "List"],
    );
    assert.equal(new Set(approvals.map((a) => a.id)).size, 4);
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "after");
    assert.equal(fs.existsSync(path.join(root, "denied.txt")), false);
    assert.doesNotMatch(JSON.stringify(requests), /not-for-model/);
    // New Codex models carry tools in additional_tools input messages. Inspect both
    // encodings and code-mode declarations instead of silently checking an empty array.
    const advertised = JSON.stringify(requests[0]!.tools ?? requests[0]!.input);
    assert.match(advertised, /fleet_read/);
    const declared = [...advertised.matchAll(/declare const tools: \{ ([a-zA-Z0-9_]+)/g)].map(
      (m) => m[1],
    );
    assert.ok(declared.includes("fleet_read"));
    assert.ok(
      !declared.some((name) =>
        /exec_command|shell|web_search|view_image|image_generation/.test(name!),
      ),
    );
    assert.match(JSON.stringify(requests[1]!.input), /before/);
  },
);
