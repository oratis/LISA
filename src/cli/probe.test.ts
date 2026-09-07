import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  collectWarnings,
  DEFAULT_PROBE_URL,
  formatProbe,
  formatUptime,
  normalizeProbeUrl,
  probeHealth,
  runProbe,
  type HealthPayload,
} from "./probe.js";

/**
 * A throwaway server on port 0. `routes` maps a path to the response; anything
 * else 404s, which is how the /health → /healthz fallback gets exercised.
 */
async function withServer(
  routes: Record<string, { status?: number; body: string }>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    const hit = routes[req.url ?? ""];
    if (!hit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
      return;
    }
    res.writeHead(hit.status ?? 200, { "content-type": "application/json" });
    res.end(hit.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    // Close every socket too, or node:test sees a live handle after the test.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const RICH: HealthPayload = {
  ok: true,
  version: "0.25.0",
  uptime_s: 511_200,
  event_loop_lag_ms: { p50: 1.2, p99: 38, max: 240 },
  heap_used_mb: 184,
  rss_mb: 402,
  tenants: 3,
  pending_turns: 0,
  sessions: 12,
  edition: "local",
};

describe("normalizeProbeUrl", () => {
  test("defaults to the local daemon", () => {
    assert.equal(normalizeProbeUrl(), DEFAULT_PROBE_URL);
    assert.equal(normalizeProbeUrl(""), DEFAULT_PROBE_URL);
    assert.equal(normalizeProbeUrl("   "), DEFAULT_PROBE_URL);
  });

  test("accepts a bare port, a bare host, and a full origin", () => {
    assert.equal(normalizeProbeUrl("8080"), "http://127.0.0.1:8080");
    assert.equal(normalizeProbeUrl("localhost:5757"), "http://localhost:5757");
    assert.equal(normalizeProbeUrl("https://lisa.example.com/"), "https://lisa.example.com");
  });

  test("a pasted health URL means the instance, not a sub-path", () => {
    assert.equal(normalizeProbeUrl("http://127.0.0.1:5757/health"), "http://127.0.0.1:5757");
    assert.equal(normalizeProbeUrl("http://127.0.0.1:5757/healthz"), "http://127.0.0.1:5757");
  });
});

describe("probeHealth", () => {
  test("reads the extended payload from /health", async () => {
    await withServer({ "/health": { body: JSON.stringify(RICH) } }, async (base) => {
      const r = await probeHealth(base);
      assert.equal(r.reachable, true);
      assert.equal(r.endpoint, "/health");
      assert.equal(r.status, 200);
      assert.equal(r.payload?.version, "0.25.0");
      assert.ok(r.latencyMs >= 0);
      assert.deepEqual(r.warnings, []);
    });
  });

  test("an old server answering {ok:true} is healthy, just quiet", async () => {
    await withServer({ "/health": { body: '{"ok":true}' } }, async (base) => {
      const r = await probeHealth(base);
      assert.equal(r.reachable, true);
      assert.equal(r.payload?.version, undefined);
      const text = formatProbe(r).join("\n");
      assert.match(text, /no telemetry/);
    });
  });

  test("falls back to /healthz when /health is not routed", async () => {
    await withServer({ "/healthz": { body: '{"ok":true}' } }, async (base) => {
      const r = await probeHealth(base);
      assert.equal(r.reachable, true);
      assert.equal(r.endpoint, "/healthz");
    });
  });

  test("a 503 is reachable-but-unhealthy, and fails", async () => {
    await withServer(
      { "/health": { status: 503, body: '{"ok":false}' }, "/healthz": { status: 503, body: '{"ok":false}' } },
      async (base) => {
        const r = await probeHealth(base);
        assert.equal(r.reachable, false);
        assert.equal(r.error, "HTTP 503");
      },
    );
  });

  test("a 200 with a non-JSON body still counts as alive", async () => {
    await withServer({ "/health": { body: "OK" } }, async (base) => {
      const r = await probeHealth(base);
      assert.equal(r.reachable, true);
      assert.equal(r.payload, undefined);
    });
  });

  test("a server that never answers times out instead of hanging", async () => {
    // Accept the connection and say nothing — the "wedged event loop" case the
    // probe exists for.
    const server = http.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await probeHealth(`http://127.0.0.1:${port}`, { timeoutMs: 150 });
      assert.equal(r.reachable, false);
      assert.match(r.error ?? "", /timed out after 150ms/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("nothing listening is unreachable, with the reason", async () => {
    // Bind then immediately release the port so the connection is refused.
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const r = await probeHealth(`http://127.0.0.1:${port}`, { timeoutMs: 1000 });
    assert.equal(r.reachable, false);
    assert.ok((r.error ?? "").length > 0);
    assert.match(formatProbe(r).join("\n"), /unreachable/);
  });
});

describe("warnings", () => {
  test("p99 lag over a second is flagged", () => {
    const w = collectWarnings({ event_loop_lag_ms: { p50: 2, p99: 1400 } }, 5);
    assert.equal(w.length, 1);
    assert.match(w[0]!, /p99 1400ms > 1000ms/);
  });

  test("a p99 under the threshold, or absent telemetry, is silent", () => {
    assert.deepEqual(collectWarnings({ event_loop_lag_ms: { p99: 999 } }, 5), []);
    assert.deepEqual(collectWarnings({ ok: true }, 5), []);
    assert.deepEqual(collectWarnings(null, 5), []);
  });

  test("a slow /health is itself a warning", () => {
    const w = collectWarnings({ ok: true }, 4200);
    assert.equal(w.length, 1);
    assert.match(w[0]!, /took 4200ms/);
  });

  test("a lagging server prints the warning glyph and still exits 0", async () => {
    const laggy = { ...RICH, event_loop_lag_ms: { p50: 4, p99: 2300, max: 9000 } };
    await withServer({ "/health": { body: JSON.stringify(laggy) } }, async (base) => {
      const lines: string[] = [];
      const code = await runProbe(base, { log: (l) => lines.push(l) });
      assert.equal(code, 0);
      const text = lines.join("\n");
      assert.match(text, /⚠/);
      assert.match(text, /p99 2300ms/);
    });
  });
});

describe("formatProbe", () => {
  test("prints every field the server reported", () => {
    const text = formatProbe({
      url: "http://127.0.0.1:5757",
      endpoint: "/health",
      reachable: true,
      status: 200,
      latencyMs: 3,
      payload: RICH,
      warnings: [],
    }).join("\n");
    assert.match(text, /version:\s+0\.25\.0/);
    assert.match(text, /uptime:\s+5d 22h/);
    assert.match(text, /p50 1\.2ms {2}p99 38ms {2}max 240ms/);
    assert.match(text, /heap used:\s+184 MB {2}\(rss 402 MB\)/);
    assert.match(text, /tenants:\s+3/);
    assert.match(text, /sessions:\s+12/);
    assert.match(text, /pending turns:\s+0/);
    assert.match(text, /edition:\s+local/);
  });
});

describe("runProbe exit codes", () => {
  test("healthy is 0", async () => {
    await withServer({ "/health": { body: JSON.stringify(RICH) } }, async (base) => {
      const lines: string[] = [];
      assert.equal(await runProbe(base, { log: (l) => lines.push(l) }), 0);
      assert.match(lines.join("\n"), /backend healthy/);
    });
  });

  test("unreachable is 1 — so `lisa doctor --probe || …` can restart it", async () => {
    const lines: string[] = [];
    const code = await runProbe("http://127.0.0.1:1", {
      timeoutMs: 1000,
      log: (l) => lines.push(l),
    });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /not answering/);
  });
});

describe("formatUptime", () => {
  test("picks the two units that matter", () => {
    assert.equal(formatUptime(45), "45s");
    assert.equal(formatUptime(605), "10m 05s");
    assert.equal(formatUptime(11_220), "3h 07m");
    assert.equal(formatUptime(511_200), "5d 22h");
    assert.equal(formatUptime(-1), "0s");
  });
});
