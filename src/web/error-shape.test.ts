/**
 * The shared error shape (#485, #487): the code table and its generated
 * outputs, the response normalizer on its own, and error responses from the
 * real Mac-edition server.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Provider } from "../providers/types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-error-shape-"));
process.env.LISA_HOME = TMP;
process.env.CLAUDE_HOME = path.join(TMP, "claude");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
process.env.LISA_LOG_FORMAT = "text";
process.env.LISA_WEB_TOKEN = "error-shape-test-token";
for (const k of [
  "LISA_EDITION",
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
const { enforceErrorShape, errorBody, normalizeErrorPayload, LISA_ERROR_MESSAGES } =
  await import("./error-shape.js");
const { LISA_ERROR_HTTP_STATUS, LISA_ERROR_FALLBACK_BY_STATUS } =
  await import("./error-codes.generated.js");

const repo = fileURLToPath(new URL("../../", import.meta.url));
const table = JSON.parse(
  fs.readFileSync(path.join(repo, "contracts", "lisa-error-codes.json"), "utf8"),
) as {
  codes: Array<{ code: string; http: number[]; sse?: boolean; message: string }>;
  fallbackByStatus: Record<string, string>;
};
const swift = fs.readFileSync(
  path.join(repo, "packaging", "ios-companion", "Sources", "APIContract.generated.swift"),
  "utf8",
);

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

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

function json(r: Reply): Record<string, unknown> {
  assert.match(String(r.headers["content-type"]), /application\/json/, r.text);
  return JSON.parse(r.text) as Record<string, unknown>;
}

describe("error code contract", () => {
  test("the codes Pocket handles are in the table with their HTTP statuses", () => {
    const expected: Record<string, number[]> = {
      unauthorized: [401],
      quota_exhausted: [402],
      premium_requires_balance: [402],
      service_paused: [402, 503],
      account_suspended: [403],
      model_disabled: [403],
      remote_control_disabled: [403],
      turn_in_progress: [409, 429],
      rate_limited: [429],
      otp_cooldown: [429],
      feature_temporarily_disabled: [503],
      malformed_jws: [400],
      unbound_transaction: [400],
      wrong_account: [400],
      bad_chain: [400],
      unknown_product: [400],
      sandbox_rejected: [400],
    };
    for (const [code, statuses] of Object.entries(expected)) {
      assert.deepEqual(LISA_ERROR_HTTP_STATUS[code], statuses, code);
      assert.ok(LISA_ERROR_MESSAGES[code], code);
    }
    assert.deepEqual(LISA_ERROR_HTTP_STATUS.provider_error, []);
    assert.equal(table.codes.find((c) => c.code === "provider_error")?.sse, true);
  });

  test("a paused service never sends people to buy credits", () => {
    assert.doesNotMatch(LISA_ERROR_MESSAGES.service_paused!, /credit|buy|purchase|pay/i);
  });

  test("every message is one sentence-ish line a person can read", () => {
    for (const { code, message } of table.codes) {
      assert.match(message, /^[A-Z].*[.!?]$/, code);
      assert.ok(message.length <= 140, `${code} message is short`);
    }
  });

  test("the generated TypeScript and Swift carry every code", () => {
    assert.deepEqual(
      Object.keys(LISA_ERROR_MESSAGES),
      table.codes.map((c) => c.code),
    );
    assert.deepEqual(LISA_ERROR_FALLBACK_BY_STATUS, table.fallbackByStatus);
    assert.match(swift, /^enum LisaErrorCode: String \{$/m);
    assert.match(swift, /^ {4}case unknown$/m);
    for (const { code } of table.codes) {
      const name = code.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      const line = name === code ? `case ${name}` : `case ${name} = "${code}"`;
      assert.ok(swift.includes(`    ${line}\n`), `${code} → ${line}`);
    }
  });
});

describe("normalizeErrorPayload", () => {
  const norm = (status: number, type: string, body: string) => {
    const out = normalizeErrorPayload(status, type, body);
    return out === null ? null : (JSON.parse(out) as Record<string, unknown>);
  };

  test("adds the message to a coded JSON error and keeps its other fields", () => {
    assert.deepEqual(
      norm(
        402,
        "application/json",
        JSON.stringify({ error: "quota_exhausted", resetAt: 5, tier: "free" }),
      ),
      {
        error: "quota_exhausted",
        message: LISA_ERROR_MESSAGES.quota_exhausted,
        resetAt: 5,
        tier: "free",
      },
    );
    assert.deepEqual(
      norm(400, "application/json", JSON.stringify({ ok: false, error: "sandbox_rejected" })),
      { ok: false, error: "sandbox_rejected", message: LISA_ERROR_MESSAGES.sandbox_rejected },
    );
    assert.deepEqual(
      norm(401, "application/json", JSON.stringify({ error: "unauthorized", reason: "x" })),
      { error: "unauthorized", reason: "x", message: LISA_ERROR_MESSAGES.unauthorized },
    );
  });

  test("leaves a body that already has the shape untouched", () => {
    const body = JSON.stringify({ error: "rate_limited", message: "Slow down.", retryAfterSec: 3 });
    assert.equal(normalizeErrorPayload(429, "application/json; charset=utf-8", body), null);
  });

  test("an unknown code keeps its name and gets its status's generic message", () => {
    assert.deepEqual(norm(409, "application/json", JSON.stringify({ error: "host_busy" })), {
      error: "host_busy",
      message: LISA_ERROR_MESSAGES.conflict,
    });
  });

  test("a sentence in `error` becomes the message under the status's code", () => {
    assert.deepEqual(
      norm(403, "application/json", JSON.stringify({ error: "Skill management is Mac-only" })),
      { error: "forbidden", message: "Skill management is Mac-only" },
    );
  });

  test("plain text becomes JSON; a bare code body is that code", () => {
    assert.deepEqual(norm(400, "text/plain", "bad json"), {
      error: "bad_request",
      message: "bad json",
    });
    assert.deepEqual(norm(403, "", "local_owner_required"), {
      error: "local_owner_required",
      message: LISA_ERROR_MESSAGES.local_owner_required,
    });
    assert.deepEqual(norm(404, "", ""), {
      error: "not_found",
      message: LISA_ERROR_MESSAGES.not_found,
    });
    assert.deepEqual(norm(418, "text/plain", ""), {
      error: "request_failed",
      message: LISA_ERROR_MESSAGES.request_failed,
    });
  });

  test("HTML for a browser is left alone", () => {
    assert.equal(normalizeErrorPayload(401, "text/html; charset=utf-8", "<html></html>"), null);
  });

  test("errorBody builds the same shape", () => {
    assert.deepEqual(errorBody("rate_limited", { retryAfterSec: 9 }), {
      retryAfterSec: 9,
      error: "rate_limited",
      message: LISA_ERROR_MESSAGES.rate_limited,
    });
  });
});

describe("enforceErrorShape on a bare HTTP server", () => {
  let server: http.Server;
  let port: number;
  before(async () => {
    server = http.createServer((req, res) => {
      enforceErrorShape(req, res);
      const url = req.url ?? "/";
      if (url === "/text") {
        res.writeHead(403, { "content-type": "text/plain", "content-length": "5" });
        res.end("nope!");
      } else if (url === "/json") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(Buffer.from(JSON.stringify({ error: "otp_cooldown", retryAfterSec: 60 })));
      } else if (url === "/empty") {
        res.writeHead(404);
        res.end();
      } else if (url === "/status-only") {
        res.statusCode = 500;
        res.end("boom", () => {});
      } else if (url === "/stream") {
        res.writeHead(502, { "content-type": "text/plain" });
        res.write("partial ");
        res.end("stream");
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("fine");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("text/plain errors become JSON with the right length", async () => {
    const r = await request(port, "GET", "/text");
    assert.equal(r.status, 403);
    assert.deepEqual(json(r), { error: "forbidden", message: "nope!" });
  });

  test("a coded JSON error gains its message", async () => {
    const r = await request(port, "GET", "/json");
    assert.equal(r.status, 429);
    assert.deepEqual(json(r), {
      error: "otp_cooldown",
      retryAfterSec: 60,
      message: LISA_ERROR_MESSAGES.otp_cooldown,
    });
  });

  test("an empty error and a statusCode-only error are filled in", async () => {
    assert.deepEqual(json(await request(port, "GET", "/empty")), {
      error: "not_found",
      message: LISA_ERROR_MESSAGES.not_found,
    });
    const r = await request(port, "GET", "/status-only");
    assert.equal(r.status, 500);
    assert.deepEqual(json(r), { error: "internal_error", message: "boom" });
  });

  test("streamed bodies, successes and HEAD pass through untouched", async () => {
    const streamed = await request(port, "GET", "/stream");
    assert.equal(streamed.status, 502);
    assert.equal(streamed.text, "partial stream");
    const ok = await request(port, "GET", "/ok");
    assert.equal(ok.text, "fine");
    const head = await request(port, "HEAD", "/text");
    assert.equal(head.status, 403);
    assert.equal(head.headers["content-type"], "text/plain");
  });
});

describe("error responses from the Mac-edition server", () => {
  let server: http.Server;
  let port: number;
  const providerFailure = Object.assign(
    new Error(
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    ),
    { status: 401 },
  );
  const provider: Provider = {
    name: "fixture",
    async runTurn() {
      throw providerFailure;
    },
  };

  before(async () => {
    server = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      tools: [],
      model: "claude-sonnet-4-6",
      thinking: false,
      reflect: false,
      idleMinutes: 0,
      hooks: [],
      provider,
    });
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("remote-control refusals are coded JSON, not text/plain", async () => {
    fs.writeFileSync(
      path.join(TMP, "control-policy.json"),
      JSON.stringify({ remoteControl: false, remoteAdoptExternal: false }),
    );
    // A loopback socket naming another host is a remote caller; with the
    // token it gets in, and the Mac's policy then refuses the action.
    const r = await request(port, "GET", "/api/dispatch/status?id=x", {
      headers: { host: "lisa.example:5757", authorization: "Bearer error-shape-test-token" },
    });
    assert.equal(r.status, 403);
    assert.deepEqual(json(r), {
      error: "remote_control_disabled",
      message: LISA_ERROR_MESSAGES.remote_control_disabled,
    });
  });

  test("a foreign Host without a valid token is a coded untrusted_host", async () => {
    const r = await request(port, "GET", "/api/sessions", {
      headers: { host: "lisa.example:5757", authorization: "Bearer wrong" },
    });
    assert.equal(r.status, 403);
    assert.deepEqual(json(r), {
      error: "untrusted_host",
      message: LISA_ERROR_MESSAGES.untrusted_host,
    });
  });

  test("text/plain routes answer JSON with the same status", async () => {
    const r = await request(port, "POST", "/api/auth/register", {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 404);
    assert.deepEqual(json(r), {
      error: "accounts_unavailable",
      message: LISA_ERROR_MESSAGES.accounts_unavailable,
    });
    const missing = await request(port, "GET", "/api/definitely-not-a-route");
    assert.equal(missing.status, 404);
    assert.equal(json(missing).error, "not_found");
    assert.equal(typeof json(missing).message, "string");
  });

  test("a malformed chat request is a coded 400", async () => {
    const r = await request(port, "POST", "/chat", {
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(r.status, 400);
    const body = json(r);
    assert.equal(body.error, "bad_request");
    assert.equal(body.message, LISA_ERROR_MESSAGES.bad_request);
    assert.equal(typeof body.reason, "string");
  });

  test("a provider failure in chat keeps the owner's own detail on the Mac", async () => {
    const r = await request(port, "POST", "/chat", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(r.status, 200);
    const errors = r.text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>)
      .filter((event) => event.type === "error");
    assert.deepEqual(errors, [
      { type: "error", code: "provider_error", message: providerFailure.message },
    ]);
  });
});
