/**
 * Integration tests that boot the REAL web server (startWebServer) on port 0
 * under a throwaway LISA_HOME / CLAUDE_HOME, and talk to it over plain
 * node:http. No model is ever called: every path exercised here is either
 * model-free or fed a fake provider.
 *
 * Environment is pinned BEFORE the dynamic import below because several
 * modules freeze paths at load time (CONFIG_ENV_PATH, CLAUDE_HOME).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-server-"));
process.env.LISA_HOME = TMP;
// The claude-code observer watches $CLAUDE_HOME/projects — never the user's
// real ~/.claude from a test.
process.env.CLAUDE_HOME = path.join(TMP, "claude");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
process.env.LISA_LOG_FORMAT = "text";
for (const k of [
  "LISA_EDITION",
  "LISA_WEB_TOKEN",
  "LISA_LOG_FILE",
  "K_SERVICE",
  "LISA_MODEL_FALLBACK",
  "LISA_MANAGED_SESSION",
  "LISA_BASE_URL",
  "LISA_PROVIDER",
]) {
  delete process.env[k];
}

const { startWebServer } = await import("./server.js");
type WebServerOptions = Parameters<typeof startWebServer>[0];

interface Booted {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

async function boot(overrides: Partial<WebServerOptions> = {}): Promise<Booted> {
  const server = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    tools: [],
    model: "claude-sonnet-4-6",
    thinking: false,
    reflect: true,
    idleMinutes: 0,
    hooks: [],
    ...overrides,
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: async () => {
      // SSE subscribers hold their sockets open; drop them or close() hangs.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function request(
  port: number,
  method: string,
  urlPath: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("T-10 security headers on the real server", () => {
  let srv: Booted;
  test("boots on port 0", async () => {
    srv = await boot();
    assert.ok(srv.port > 0);
  });

  const expectHardened = (r: Reply, label: string) => {
    assert.equal(r.headers["x-content-type-options"], "nosniff", `${label}: nosniff`);
    assert.equal(r.headers["x-frame-options"], "SAMEORIGIN", `${label}: frame`);
    assert.equal(r.headers["referrer-policy"], "no-referrer", `${label}: referrer`);
    assert.equal(
      r.headers["permissions-policy"],
      "camera=(), geolocation=(), payment=()",
      `${label}: permissions`,
    );
  };

  test("the HTML shell, a pre-gate probe, a JSON API and a 404 all carry them", async () => {
    const shell = await request(srv.port, "GET", "/");
    assert.equal(shell.status, 200);
    assert.match(shell.headers["content-type"] ?? "", /text\/html/);
    expectHardened(shell, "GET /");

    const probe = await request(srv.port, "GET", "/healthz");
    assert.equal(probe.status, 200);
    expectHardened(probe, "GET /healthz");

    const api = await request(srv.port, "GET", "/api/edition");
    assert.equal(api.status, 200);
    expectHardened(api, "GET /api/edition");
    // The pre-existing protocol header is untouched by the new ones.
    assert.ok(api.headers["x-lisa-api-version"], "api version header still present");

    const missing = await request(srv.port, "GET", "/definitely-not-a-route");
    assert.equal(missing.status, 404);
    expectHardened(missing, "404");
  });

  test("closes cleanly (timers and observers are torn down)", async () => {
    await srv.close();
  });
});

describe("T-3 /health and /healthz", () => {
  let srv: Booted;
  test("boots", async () => {
    srv = await boot();
  });

  test("/healthz stays the cheap liveness probe", async () => {
    const r = await request(srv.port, "GET", "/healthz");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true });
  });

  test("/health reports version, uptime, lag percentiles, memory and live counters", async () => {
    const r = await request(srv.port, "GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    const body = JSON.parse(r.text) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.match(String(body.version), /^\d+\.\d+\.\d+/);
    assert.equal(typeof body.uptime_s, "number");
    const lag = body.event_loop_lag_ms as Record<string, number>;
    for (const k of ["p50", "p99", "max"]) assert.equal(typeof lag[k], "number", k);
    assert.equal(typeof (body.event_loop_lag_1m_ms as Record<string, number>).p99, "number");
    assert.ok((body.heap_used_mb as number) > 0);
    assert.ok((body.rss_mb as number) > 0);
    // Fresh server: the process-start session context, no cloud tenants, nothing in flight.
    assert.equal(body.tenants, 0);
    assert.equal(body.pending_turns, 0);
    assert.equal(body.sessions, 1);
    assert.equal(body.edition, "mac");
    assert.equal(body.watchdog_lag_ms, 5000);
  });

  test("closes", async () => {
    await srv.close();
  });
});
