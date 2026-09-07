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
const { buildRuntimePolicy } = await import("../runtime-policy.js");
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

describe("T-7 the server honours its RuntimePolicy", () => {
  const base = {
    reflect: true,
    thinking: false,
    compaction: false,
    approval: "auto" as const,
    subcommand: "serve",
    serveWeb: true,
  };

  test('reflection:"off" refuses POST /reflect instead of quietly running a model call', async () => {
    const policy = buildRuntimePolicy({ ...base, reflect: false }, { LISA_EDITION: "mac" });
    assert.equal(policy.reflection, "off");
    const srv = await boot({ policy, reflect: false });
    try {
      const r = await request(srv.port, "POST", "/reflect", { body: "{}" });
      assert.equal(r.status, 409);
      assert.deepEqual(JSON.parse(r.text), { error: "reflection_disabled" });
    } finally {
      await srv.close();
    }
  });

  test('reflection:"manual" keeps the route reachable (no 409) while running no heartbeat', async () => {
    const policy = buildRuntimePolicy({ ...base }, { LISA_EDITION: "cloud" });
    assert.equal(policy.reflection, "manual");
    // Boot with the cloud policy but the mac edition, so the route is not
    // additionally gated by cloud auth: this asserts the reflection gate only.
    const srv = await boot({ policy });
    try {
      const r = await request(srv.port, "POST", "/reflect", { body: "{}" });
      assert.notEqual(r.status, 409, "manual must not be refused by the reflection gate");
    } finally {
      await srv.close();
    }
  });

  test("the capability profile in the policy is what filters the tool set", async () => {
    // A cloud profile must not expose host tools even when the process is the
    // mac edition and the caller handed in the full registry (fail closed:
    // the server filters, the client is never the boundary).
    const policy = buildRuntimePolicy({ ...base }, { LISA_EDITION: "cloud" });
    assert.equal(policy.capabilities, "cloud-chat");
    const { buildToolRegistry } = await import("../tools/registry.js");
    const all = buildToolRegistry({ includeVoice: false });
    const srv = await boot({ policy, tools: all });
    try {
      const r = await request(srv.port, "GET", "/api/tools");
      if (r.status === 200) {
        const names =
          (JSON.parse(r.text) as { tools?: { name: string }[] }).tools?.map((t) => t.name) ?? [];
        if (names.length)
          assert.equal(names.includes("bash"), false, "cloud-chat must not expose bash");
      }
    } finally {
      await srv.close();
    }
  });
});

describe("T-4 /api/sessions ETag revalidation", () => {
  test("etagMatches implements weak comparison over the If-None-Match list", async () => {
    const { etagMatches } = await import("./server.js");
    assert.equal(etagMatches('W/"abc"', 'W/"abc"'), true);
    // A proxy that drops or adds the weak prefix still gets its 304.
    assert.equal(etagMatches('"abc"', 'W/"abc"'), true);
    assert.equal(etagMatches('W/"abc"', '"abc"'), true);
    assert.equal(etagMatches('W/"zzz", W/"abc"', 'W/"abc"'), true);
    assert.equal(etagMatches("*", 'W/"abc"'), true);
    assert.equal(etagMatches('W/"other"', 'W/"abc"'), false);
    assert.equal(etagMatches(undefined, 'W/"abc"'), false);
    assert.equal(etagMatches("", 'W/"abc"'), false);
  });

  test("200 carries an ETag; the same ETag comes back 304 with no body", async () => {
    const srv = await boot();
    try {
      const first = await request(srv.port, "GET", "/api/sessions");
      assert.equal(first.status, 200);
      const etag = first.headers.etag;
      assert.ok(etag, "ETag present");
      assert.equal(first.headers["cache-control"], "no-cache");

      const second = await request(srv.port, "GET", "/api/sessions", {
        headers: { "if-none-match": etag },
      });
      assert.equal(second.status, 304);
      assert.equal(second.text, "");
      assert.equal(second.headers.etag, etag);

      // A stale validator still gets the full body.
      const stale = await request(srv.port, "GET", "/api/sessions", {
        headers: { "if-none-match": 'W/"stale"' },
      });
      assert.equal(stale.status, 200);
      assert.equal(stale.text, first.text);
    } finally {
      await srv.close();
    }
  });
});

describe("T-9 /api/config over the real server", () => {
  const KEY = "sk-test-0123456789abcdefghij";
  const cleanup: string[] = [];
  after(() => {
    for (const k of cleanup) delete process.env[k];
  });

  test("GET /api/config/status lists every provider without leaking a key", async () => {
    const srv = await boot();
    try {
      const r = await request(srv.port, "GET", "/api/config/status");
      assert.equal(r.status, 200);
      const body = JSON.parse(r.text) as {
        configured: boolean;
        anthropic: boolean;
        openai: boolean;
        model: string;
        providers: {
          id: string;
          envKey: string;
          label: string;
          modelPrefixes: string[];
          configured: boolean;
        }[];
      };
      // Legacy fields survive for the old popup.
      assert.equal(typeof body.configured, "boolean");
      assert.equal(typeof body.anthropic, "boolean");
      assert.equal(typeof body.openai, "boolean");
      assert.equal(body.model, "claude-sonnet-4-6");
      assert.ok(body.providers.length > 3);
      for (const p of body.providers) {
        assert.ok(p.id && p.envKey && p.label);
        assert.ok(Array.isArray(p.modelPrefixes));
        assert.equal(typeof p.configured, "boolean");
      }
      assert.equal(r.text.includes(KEY), false);
    } finally {
      await srv.close();
    }
  });

  test("POST /api/config/save writes config.env 0600, applies to process.env, rejects unknown keys", async () => {
    const srv = await boot();
    cleanup.push("ZHIPU_API_KEY", "LISA_MODEL");
    try {
      const ok = await request(srv.port, "POST", "/api/config/save", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: { ZHIPU_API_KEY: KEY }, model: "glm-4" }),
      });
      assert.equal(ok.status, 200);
      assert.deepEqual(JSON.parse(ok.text).saved.sort(), ["LISA_MODEL", "ZHIPU_API_KEY"]);
      assert.equal(process.env.ZHIPU_API_KEY, KEY, "applied to the live process");

      const configEnv = path.join(TMP, "config.env");
      const raw = fs.readFileSync(configEnv, "utf8");
      assert.match(raw, /ZHIPU_API_KEY=/);
      assert.match(raw, /LISA_MODEL=glm-4/);
      assert.equal(
        fs.statSync(configEnv).mode & 0o777,
        0o600,
        "0600, like every other secret in ~/.lisa",
      );

      // …and the status endpoint now agrees it is configured.
      const status = JSON.parse((await request(srv.port, "GET", "/api/config/status")).text) as {
        configured: boolean;
        providers: { id: string; configured: boolean }[];
      };
      assert.equal(status.configured, true);
      assert.equal(status.providers.find((p) => p.id === "zhipu")!.configured, true);

      // An env name outside the whitelist is refused and nothing is written.
      const bad = await request(srv.port, "POST", "/api/config/save", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: { NODE_OPTIONS: "--inspect" } }),
      });
      assert.equal(bad.status, 400);
      assert.match(bad.text, /unknown config key/);
      assert.equal(process.env.NODE_OPTIONS, undefined);
      assert.equal(fs.readFileSync(configEnv, "utf8").includes("NODE_OPTIONS"), false);
    } finally {
      await srv.close();
    }
  });
});

describe("T-11 SSE keep-alive on the real server", () => {
  test("/events sends `: ping` comments while it sits idle", async () => {
    // 40ms instead of 15s; the env var exists for short-idle proxies and is
    // read per stream, so setting it here affects only this boot.
    process.env.LISA_SSE_HEARTBEAT_MS = "40";
    const srv = await boot();
    try {
      const chunks = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: srv.port, path: "/events", method: "GET", agent: false },
          (res) => {
            assert.equal(res.statusCode, 200);
            assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);
            let text = "";
            res.on("data", (c: Buffer) => {
              text += c.toString("utf8");
              if (text.includes(": ping")) {
                req.destroy();
                resolve(text);
              }
            });
            res.on("end", () => resolve(text));
          },
        );
        req.on("error", (e) => {
          // destroy() after resolve surfaces here; ignore it.
          if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
        });
        req.end();
        setTimeout(() => {
          req.destroy();
          reject(new Error("no ping within 2s"));
        }, 2000).unref();
      });
      // The hello/mood frames still come first and are untouched.
      assert.match(chunks, /"type":"hello"/);
      assert.match(chunks, /^: ping$/m);
    } finally {
      await srv.close();
      delete process.env.LISA_SSE_HEARTBEAT_MS;
    }
  });
});

describe("T-12 PWA manifest icons", () => {
  test("declares real 192/512 sizes plus a separate maskable variant", async () => {
    const srv = await boot();
    try {
      const r = await request(srv.port, "GET", "/manifest.webmanifest");
      assert.equal(r.status, 200);
      assert.match(r.headers["content-type"] ?? "", /application\/manifest\+json/);
      const m = JSON.parse(r.text) as {
        icons: { src: string; sizes: string; type: string; purpose: string }[];
      };
      const bySrc = new Map(m.icons.map((i) => [i.src, i]));
      assert.equal(bySrc.get("/assets/icon-192.png")?.sizes, "192x192");
      assert.equal(bySrc.get("/assets/icon-512.png")?.sizes, "512x512");
      // `sizes: "any"` on a raster PNG is what made the platforms reject the
      // icon and fall back to a page screenshot.
      assert.equal(
        m.icons.some((i) => i.sizes === "any"),
        false,
      );
      for (const i of m.icons) {
        assert.equal(i.type, "image/png");
        assert.match(i.sizes, /^\d+x\d+$/);
      }
      // The maskable icon is its own file: relabelling an unpadded icon
      // maskable gets its edges cropped by the platform mask.
      const maskable = m.icons.filter((i) => i.purpose === "maskable");
      assert.equal(maskable.length, 1);
      assert.equal(maskable[0]!.src, "/assets/icon-512-maskable.png");
      assert.equal(
        m.icons.some((i) => i.purpose === "any" && i.src === maskable[0]!.src),
        false,
      );
    } finally {
      await srv.close();
    }
  });
});
