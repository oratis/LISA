import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { exitOnSignals, trackShutdown } from "./shutdown.js";

/** A stand-in for `process`: signals are emitted by hand, exit codes recorded. */
function target() {
  const t = new EventEmitter() as EventEmitter & { exit(code: number): void; codes: number[] };
  t.codes = [];
  t.exit = (code) => {
    t.codes.push(code);
    t.emit("exited", code);
  };
  return t;
}

/** A server holding one open streaming response, like an SSE subscriber. */
async function streaming() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": open\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const client = http.get("http://127.0.0.1:" + port + "/events");
  client.on("error", () => {});
  await once(client, "response");
  return server;
}

test("SIGTERM closes the server, runs its close hook, waits for its work, then exits 0", async () => {
  const server = await streaming();
  const t = target();
  const order: string[] = [];
  let finish!: () => void;
  server.on("close", () => {
    order.push("close hook");
    trackShutdown(
      server,
      new Promise<void>((resolve) => {
        finish = () => {
          order.push("agents stopped");
          resolve();
        };
      }),
    );
  });
  exitOnSignals(server, { target: t, graceMs: 10_000 });
  t.emit("SIGTERM");
  await once(server, "close");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(t.codes, [], "the process must wait for the hook's work");
  finish();
  await once(t, "exited");
  assert.deepEqual(order, ["close hook", "agents stopped"]);
  assert.deepEqual(t.codes, [0]);
});

test("SIGINT does the same; a second signal exits at once, and the grace bounds stuck work", async () => {
  // The grace timer is unref'd, so keep this test's event loop alive while it waits.
  const keep = setInterval(() => {}, 1000);
  try {
    const server = await streaming();
    const t = target();
    server.on("close", () => trackShutdown(server, new Promise(() => {})));
    exitOnSignals(server, { target: t, graceMs: 100 });
    t.emit("SIGINT");
    await once(server, "close");
    t.emit("SIGINT");
    assert.deepEqual(t.codes, [1]);
    await once(t, "exited");
    assert.deepEqual(t.codes, [1, 0]);
  } finally {
    clearInterval(keep);
  }
});
