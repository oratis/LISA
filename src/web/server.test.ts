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

test("Soft Ink assets have browser MIME types and the gallery keeps nonce-based CSP", async () => {
  const srv = await boot();
  try {
    const base = "/assets/visuals/soft-ink-v1/";
    for (const [file, type] of [
      ["portraits-small.webp", "image/webp"],
      ["manifest.js", "application/javascript"],
      ["manifest.json", "application/json"],
      ["stickers/lisa-hello.png", "image/png"],
    ]) {
      const result = await request(srv.port, "GET", base + file);
      assert.equal(result.status, 200);
      assert.ok(result.headers["content-type"]?.startsWith(type!));
      assert.equal(result.headers["x-content-type-options"], "nosniff");
    }
    const first = await request(srv.port, "GET", base + "gallery.html");
    const second = await request(srv.port, "GET", base + "gallery.html");
    assert.equal(first.status, 200);
    assert.equal(first.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(first.headers["cache-control"], "no-store");
    const nonce = first.text.match(/<script nonce="([^"]+)">/)?.[1];
    assert.ok(nonce);
    assert.ok(first.headers["content-security-policy"]?.includes("'nonce-" + nonce + "'"));
    assert.notEqual(
      first.headers["content-security-policy"],
      second.headers["content-security-policy"],
    );
    assert.ok(!first.text.includes("<script>"));
  } finally {
    await srv.close();
  }
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
      const stale = await request(srv.port, "POST", "/reflect", {
        headers: { "x-lisa-session-id": "no-longer-selected" },
        body: "{}",
      });
      assert.equal(stale.status, 409);
      assert.deepEqual(JSON.parse(stale.text), { error: "session_changed" });
    } finally {
      await srv.close();
    }
  });

  test("the idle dream never starts on the cloud surface, whatever --idle says", async () => {
    // deploy/entrypoint.sh passes no --no-idle, so the hosted server is handed
    // the flag's default of 60 minutes. The dream runs on the process-level
    // chat, which there belongs to no account: nobody is admitted or billed
    // for it, and it stalls the event loop every signed-in user shares.
    const { getIdleWatcher } = await import("../idle/watcher.js");
    const dreamHandlers = () => getIdleWatcher(60 * 60_000).listenerCount("idle");
    const before = dreamHandlers();

    const cloud = buildRuntimePolicy({ ...base, idleMinutes: 60 }, { LISA_EDITION: "cloud" });
    assert.equal(cloud.idleDream, false);
    const hosted = await boot({ policy: cloud, idleMinutes: 60 });
    try {
      assert.equal(dreamHandlers(), before, "cloud policy must not arm the idle dream");
    } finally {
      await hosted.close();
    }

    // The same options on the Mac edition do arm it — the gate is the policy.
    const mac = buildRuntimePolicy({ ...base, idleMinutes: 60 }, { LISA_EDITION: "mac" });
    assert.equal(mac.idleDream, true);
    const local = await boot({ policy: mac, idleMinutes: 60 });
    try {
      assert.equal(dreamHandlers(), before + 1);
    } finally {
      await local.close();
    }
  });

  test("a competing reflection gets a stable conflict without leaking its lock path", async () => {
    const { withFileLock } = await import("../soul/lock.js");
    const { reflectionsDir } = await import("../paths.js");
    const srv = await boot();
    try {
      const session = await request(srv.port, "GET", "/session");
      const { id } = JSON.parse(session.text) as { id: string };
      const response = await withFileLock(path.join(reflectionsDir(), `${id}.lock`), () =>
        request(srv.port, "POST", "/reflect", {
          body: "{}",
          headers: { "x-lisa-session-id": id },
        }),
      );
      assert.equal(response.status, 409);
      assert.deepEqual(JSON.parse(response.text), { error: "reflection_busy" });
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

describe("managed agents (Lisa Pocket delegation)", () => {
  test("the started agent gets no tool that could hand the task to an unlisted AI", async () => {
    const { buildToolRegistry } = await import("../tools/registry.js");
    const { managedRegistry } = await import("../agents/managed.js");
    // `task` is composed outside the registry (src/cli.ts) with the full toolset
    // in its closure; stand it in so the route has to drop it too.
    const task = {
      name: "task",
      description: "task",
      inputSchema: { type: "object" as const },
      execute: async () => "",
    };
    const all = [...buildToolRegistry({ includeVoice: false }), task];
    let started: string[] | null = null;
    const original = managedRegistry.start.bind(managedRegistry);
    managedRegistry.start = (opts) => {
      started = opts.tools.map((t) => t.name);
      return { id: "m-test" } as ReturnType<typeof managedRegistry.start>;
    };
    const srv = await boot({ tools: all });
    try {
      const r = await request(srv.port, "POST", "/api/agents/managed/start", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "compare codex and claude on this repo" }),
      });
      assert.equal(r.status, 200, r.text);
      assert.ok(started, "the route must start the agent");
      const names = new Set<string>(started);
      for (const blocked of [
        "dispatch_agent",
        "signal_agent",
        "run_on_plan",
        "compare_agents",
        "scheduled_dispatch",
        "takoapi",
        "task",
      ]) {
        assert.equal(names.has(blocked), false, `${blocked} reached the managed agent`);
      }
      assert.equal(names.has("read"), true);
    } finally {
      managedRegistry.start = original;
      await srv.close();
    }
  });
});

describe("managed approve keeps a migration window for shipped Pocket builds", () => {
  test("old deny without an id, new allow with an id, and allow without an id is refused", async () => {
    const { managedRegistry } = await import("../agents/managed.js");
    const ran: string[] = [];
    // A real managed agent that pauses on one mutating tool, then finishes.
    const startPaused = (label: string) =>
      managedRegistry.start({
        task: label,
        cwd: TMP,
        systemPrompt: "sys",
        tools: [
          {
            name: "edit",
            description: "edit a file",
            inputSchema: { type: "object" as const },
            execute: async () => {
              ran.push(label);
              return "edited";
            },
          },
        ],
        provider: (() => {
          let i = 0;
          const turns = [
            {
              content: [{ type: "tool_use", id: "t-" + label, name: "edit", input: {} }],
              stopReason: "tool_use",
            },
            { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
          ];
          return {
            name: "fake",
            async runTurn() {
              const t = turns[i++];
              if (!t) throw new Error("scripted provider drained");
              return {
                ...t,
                usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              } as never;
            },
          };
        })(),
      });
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(check(), "condition timed out");
    };
    const pendingOf = (id: string) => managedRegistry.get(id)?.view().pending;
    const srv = await boot();
    const approve = (id: string, body: unknown) =>
      request(srv.port, "POST", "/api/agents/managed/" + id + "/approve", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const allowed = startPaused("allowed"),
      denied = startPaused("denied");
    try {
      await until(() => !!pendingOf(allowed.id) && !!pendingOf(denied.id));

      // Allow without an id: refused, and the request stays open.
      for (const body of [{ allow: true }, { allow: true, approvalId: "" }, { allow: "yes" }]) {
        const r = await approve(allowed.id, body);
        assert.equal(r.status, 400, JSON.stringify(body) + " → " + r.text);
        assert.match(r.text, /approval_id_and_boolean_decision_required/);
      }
      assert.ok(pendingOf(allowed.id));
      const stale = await approve(allowed.id, { allow: true, approvalId: "previous-request" });
      assert.equal(stale.status, 409, stale.text);

      // New clients: allow names the request that was shown.
      const ok = await approve(allowed.id, { allow: true, approvalId: pendingOf(allowed.id)!.id });
      assert.equal(ok.status, 200, ok.text);
      await until(() => !pendingOf(allowed.id) && ran.includes("allowed"));

      // Shipped Pocket: {"allow": false} with no id still denies the current request.
      const legacy = await approve(denied.id, { allow: false });
      assert.equal(legacy.status, 200, legacy.text);
      await until(() => managedRegistry.get(denied.id)?.view().state === "waiting");
      assert.equal(pendingOf(denied.id), undefined);
      assert.deepEqual(ran, ["allowed"], "the denied tool must not run");
      const nothing = await approve(denied.id, { allow: false });
      assert.equal(nothing.status, 409, "no request is left to deny");
    } finally {
      managedRegistry.cancel(allowed.id);
      managedRegistry.cancel(denied.id);
      await srv.close();
    }
  });
});

describe("PTY start errors carry a distinct JSON code (#489)", () => {
  test("pty_disabled / cli_missing → 503, spawn_failed → 500, and /status says which", async () => {
    const { ptyRegistry } = await import("../agents/pty.js");
    const saved = {
      LISA_PTY_AGENTS: process.env.LISA_PTY_AGENTS,
      LISA_PTY_CODEX_CMD: process.env.LISA_PTY_CODEX_CMD,
    };
    const originalStart = ptyRegistry.start.bind(ptyRegistry);
    const srv = await boot();
    const start = (body: unknown) =>
      request(srv.port, "POST", "/api/agents/pty/start", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const errorOf = (r: Reply) => {
      assert.match(r.headers["content-type"] ?? "", /application\/json/, r.text);
      const body = JSON.parse(r.text) as { error: string; message: string };
      assert.equal(typeof body.message, "string");
      assert.ok(body.message.length > 0);
      return body;
    };
    const status = async () =>
      JSON.parse((await request(srv.port, "GET", "/api/agents/pty/status")).text) as {
        enabled: boolean;
        spawnHelperExecutable: boolean;
        reason: string | null;
        agents: { id: string; available: boolean }[];
      };
    try {
      delete process.env.LISA_PTY_AGENTS;
      const off = await start({ agent: "claude", task: "x" });
      assert.equal(off.status, 503);
      assert.equal(errorOf(off).error, "pty_disabled");
      assert.equal((await status()).reason, "disabled");

      process.env.LISA_PTY_AGENTS = "1";
      // A relative override never resolves, so no codex is found here even on
      // a machine that has one installed.
      process.env.LISA_PTY_CODEX_CMD = "not/a/real/codex";
      const missing = await start({ agent: "codex", task: "x" });
      assert.equal(missing.status, 503);
      assert.equal(errorOf(missing).error, "cli_missing");
      const st = await status();
      assert.equal(st.enabled, true);
      assert.equal(st.agents.find((a) => a.id === "codex")?.available, false);
      assert.equal(typeof st.spawnHelperExecutable, "boolean");

      ptyRegistry.start = async () => {
        throw new Error("posix_spawnp failed.");
      };
      const failed = await start({ agent: "claude", task: "x" });
      assert.equal(failed.status, 500, "a failed spawn is not 'disabled'");
      const body = errorOf(failed);
      assert.equal(body.error, "spawn_failed");
      assert.match(body.message, /posix_spawnp failed/);

      const noTask = await start({ agent: "claude" });
      assert.equal(noTask.status, 400);
      assert.equal(errorOf(noTask).error, "task_required");
    } finally {
      ptyRegistry.start = originalStart;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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

test("session names validate input and survive a server restart", async () => {
  let srv = await boot();
  let closed = false;
  try {
    const sessions = JSON.parse((await request(srv.port, "GET", "/api/sessions")).text).sessions;
    const entry = { kind: "lisa", id: sessions[0].id, name: "Renamed session" };
    const post = (body: unknown) =>
      request(srv.port, "POST", "/api/session-names", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ ...entry, name: " " })).status, 400);
    assert.equal((await post({ ...entry, id: "../outside" })).status, 400);
    assert.equal((await post({ ...entry, id: "missing" })).status, 404);
    assert.equal(
      (await request(srv.port, "POST", "/api/session-names", { body: JSON.stringify(entry) }))
        .status,
      415,
    );
    const saved = await post(entry);
    assert.equal(saved.status, 200);
    const savedAt = JSON.parse(saved.text).updatedAt;
    assert.ok(Number.isSafeInteger(savedAt) && savedAt > 0);
    for (const origin of ["https://untrusted.example", "null"]) {
      const foreign = await request(srv.port, "POST", "/api/session-names", {
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(entry),
      });
      assert.equal(foreign.status, 403);
    }
    await srv.close();
    closed = true;
    srv = await boot();
    closed = false;
    const result = await request(srv.port, "GET", "/api/session-names");
    assert.equal(result.status, 200);
    assert.deepEqual(
      JSON.parse(result.text).names.find((n: { id: string }) => n.id === entry.id),
      { ...entry, updatedAt: savedAt },
    );
  } finally {
    if (!closed) await srv.close();
  }
});

test("expression preferences take JSON only and answer with typed v1 errors", async () => {
  const srv = await boot();
  try {
    const put = (body: string, headers: Record<string, string> = {}) =>
      request(srv.port, "PUT", "/api/expressions/preferences", {
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    const valid = JSON.stringify({ display: "emoji", frequency: "lively" });
    const plain = await request(srv.port, "PUT", "/api/expressions/preferences", {
      headers: { "content-type": "text/plain" },
      body: valid,
    });
    assert.equal(plain.status, 415);
    const invalid = await put(JSON.stringify({ display: "html", frequency: "lively" }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(invalid.text), { error: "invalid_expression_preferences" });
    assert.equal((await put("{")).status, 400);
    assert.equal(
      (await put(JSON.stringify({ display: "auto", pad: "x".repeat(8192) }))).status,
      413,
    );
    const foreign = await put(valid, { origin: "https://untrusted.example" });
    assert.equal(foreign.status, 403);
    assert.deepEqual(JSON.parse(foreign.text), { error: "cross_origin_request" });
    const rebound = await put(valid, { host: "attacker.example" });
    assert.equal(rebound.status, 403);
    assert.deepEqual(JSON.parse(rebound.text), { error: "untrusted_host" });
    const saved = await put(valid);
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(saved.text), { display: "emoji", frequency: "lively" });
    const read = await request(srv.port, "GET", "/api/expressions/preferences");
    assert.deepEqual(JSON.parse(read.text), { display: "emoji", frequency: "lively" });
  } finally {
    fs.rmSync(path.join(TMP, "expression-preferences.json"), { force: true });
    await srv.close();
  }
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

  test("saving a key for another provider re-points the model this process uses", async () => {
    // The whole non-Anthropic onboarding path depends on this. A first run has
    // no key, so the server boots on DEFAULT_MODEL; the gate then offers every
    // provider. If the model stayed a boot-time constant, someone who pasted a
    // DeepSeek key got it written to config.env and then watched every turn go
    // to Claude — which fails, because there is no Anthropic key. The key was
    // saved, the UI said "configured", and nothing worked.
    const srv = await boot({ model: "claude-sonnet-4-6" });
    cleanup.push("DEEPSEEK_API_KEY", "LISA_MODEL");
    try {
      const before = JSON.parse((await request(srv.port, "GET", "/session")).text) as {
        model: string;
      };
      assert.equal(before.model, "claude-sonnet-4-6");

      const saved = await request(srv.port, "POST", "/api/config/save", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: { DEEPSEEK_API_KEY: KEY }, model: "deepseek-chat" }),
      });
      assert.equal(saved.status, 200);

      const after = JSON.parse((await request(srv.port, "GET", "/session")).text) as {
        model: string;
      };
      assert.equal(
        after.model,
        "deepseek-chat",
        "the running server still routes to the old model",
      );
      const config = JSON.parse((await request(srv.port, "GET", "/api/auth/config")).text) as {
        dataProcessing: { recipients: string[] };
      };
      assert.ok(config.dataProcessing.recipients.includes("DeepSeek"));
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
  test("declares real 192/512 maskable sizes, and every icon is actually served", async () => {
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
      // At least one icon must be maskable, or Android crops the art with its
      // own mask.
      assert.ok(
        m.icons.some((i) => (i.purpose ?? "").split(/\s+/).includes("maskable")),
        "no maskable icon declared",
      );

      // Every declared icon must actually be SERVED. Asserting the manifest's
      // content is not enough, and this is not hypothetical: an earlier version
      // of this test checked only the declaration, and passed for days while the
      // maskable entry named a file no build step produced — so the only
      // maskable icon 404'd on every install and Android fell back to a default.
      // The same dangling name also sat in the service worker's precache list,
      // where addAll() rejects wholesale on one missing URL, silently disabling
      // the entire offline cache. Fetching each icon is what closes both.
      for (const i of m.icons) {
        const icon = await request(srv.port, "GET", i.src);
        assert.equal(icon.status, 200, `${i.src} is declared but not served`);
        assert.equal(icon.headers["content-type"], "image/png");
      }
    } finally {
      await srv.close();
    }
  });

  test("every asset the service worker precaches exists", async () => {
    // cache.addAll() is all-or-nothing: one 404 rejects the whole promise, and
    // the install handler swallows it with .catch(() => {}). So a single stale
    // filename in this list does not break one icon — it silently disables the
    // entire offline cache, with no error anywhere. The list is a string inside
    // a served script, so nothing else type-checks or links it.
    const srv = await boot();
    try {
      const sw = await request(srv.port, "GET", "/sw.js");
      assert.equal(sw.status, 200);
      const paths = [...sw.text.matchAll(/'(\/assets\/[^']+)'/g)].map((m) => m[1]!);
      assert.ok(paths.length > 0, "no precached asset paths found — did the list move?");
      for (const path of paths) {
        const res = await request(srv.port, "GET", path);
        assert.equal(res.status, 200, `${path} is precached but not served`);
      }
    } finally {
      await srv.close();
    }
  });
});

test("public auth config discloses AI recipients without calling a model", async () => {
  const s = await boot();
  try {
    const r = await request(s.port, "GET", "/api/auth/config");
    assert.equal(r.status, 200);
    const config = JSON.parse(r.text);
    assert.equal(config.dataProcessing.version, 1);
    assert.ok(config.dataProcessing.recipients.includes("Anthropic"));
  } finally {
    await s.close();
  }
});

test("every gateway face is behind the account-session gate, including /gw/gemini", async () => {
  const s = await boot();
  try {
    for (const route of [
      "/gw/anthropic/v1/messages",
      "/gw/openai/v1/chat/completions",
      "/gw/gemini/v1beta/models/gemini-2.5-flash:generateContent",
      "/gw/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    ]) {
      const r = await request(s.port, "POST", route, {
        headers: { "content-type": "application/json", "x-goog-api-key": "not-a-session" },
        body: JSON.stringify({ model: "x", contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      });
      // No account session ⇒ the gateway handler is never reached.
      assert.equal(r.status, 403, route);
      assert.deepEqual(JSON.parse(r.text), { error: "account_session_required" }, route);
    }
  } finally {
    await s.close();
  }
});
