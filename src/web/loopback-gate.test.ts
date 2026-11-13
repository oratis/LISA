/**
 * The Mac edition asks a loopback caller for no credential, so a page in the
 * owner's own browser is a "loopback caller" too. These tests boot the REAL
 * server and send what such a page can send — a cross-site form post, a
 * rebound Host, a cross-site subresource read — and what the legitimate
 * callers send, to pin that the gate is in front of EVERY route rather than
 * the handful that remembered to check.
 *
 * No model is ever called: a refused request never reaches a handler, and the
 * allowed ones are either model-free reads or bodies the handler rejects.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-loopback-gate-"));
process.env.LISA_HOME = TMP;
process.env.CLAUDE_HOME = path.join(TMP, "claude");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
process.env.LISA_LOG_FORMAT = "text";
// A token is configured, as it is for anyone who reaches Lisa through a
// tunnel or from another device: those callers must still get in with it.
const TOKEN = "loopback-gate-test-token";
process.env.LISA_WEB_TOKEN = TOKEN;
for (const k of [
  "LISA_EDITION",
  "LISA_PUBLIC_ORIGIN",
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
const { loopbackTrustProblem } = await import("./warden-api.js");

let server: http.Server;
let port = 0;

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
  });
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(TMP, { recursive: true, force: true });
});

interface Reply {
  status: number;
  error?: string;
}

/** Plain node:http so the Host header can be anything, as a rebound page's is. */
function send(
  method: string,
  route: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: route, method, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let error: string | undefined;
          try {
            error = JSON.parse(Buffer.concat(chunks).toString("utf8")).error;
          } catch {
            /* not JSON (an HTML page, an empty 404) */
          }
          resolve({ status: res.statusCode ?? 0, error });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Routes that change state or spend money, none of which had a guard of its own. */
const MUTATING: Array<[string, string]> = [
  ["POST", "/chat"],
  ["POST", "/api/config/save"],
  ["POST", "/api/control/policy"],
  ["POST", "/api/kb/add"],
  ["POST", "/api/agents/pty/start"],
  ["POST", "/api/mail/connect"],
  // Not a route at all: the gate is in front of routing, not inside it.
  ["POST", "/api/no-such-route"],
  ["DELETE", "/api/no-such-route"],
];

describe("loopback trust gate (real server, Mac edition)", () => {
  test("a cross-site form post never reaches a handler", async () => {
    // What <form method=post enctype=text/plain> on another site sends: a
    // "simple" request, so no preflight stands in front of it.
    const page = {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "no-cors",
      "content-type": "text/plain",
    };
    for (const [method, route] of MUTATING) {
      const r = await send(method, route, page, '{"message":"run a shell command"}');
      assert.equal(r.status, 403, `${method} ${route}`);
      assert.equal(r.error, "cross_site_request", `${method} ${route}`);
    }
  });

  test("a foreign or opaque Origin is refused even without Sec-Fetch-Site", async () => {
    for (const origin of ["https://evil.example", "null", `http://localhost:${port + 1}`]) {
      const r = await send("POST", "/chat", { origin, "content-type": "application/json" }, "{}");
      assert.equal(r.status, 403, origin);
      assert.equal(r.error, "cross_origin_request", origin);
    }
  });

  test("a DNS-rebinding request is refused on reads as well as writes", async () => {
    // To its own browser a rebound page is same-origin; only Host gives it away.
    // It connects from loopback but names another host, so it is treated as a
    // remote caller — and it cannot present the token (its cookies belong to
    // evil.example, not to this machine).
    const rebound = {
      host: `evil.example:${port}`,
      origin: `http://evil.example:${port}`,
      "sec-fetch-site": "same-origin",
    };
    for (const [method, route] of [
      ["GET", "/"],
      ["GET", "/api/soul"],
      ["GET", "/api/memory"],
      ["GET", "/api/sessions"],
      ["GET", "/events"],
      ["HEAD", "/api/soul"],
      ...MUTATING,
    ]) {
      const r = await send(method!, route!, rebound, method === "GET" ? undefined : "{}");
      assert.equal(r.status, 403, `${method} ${route}`);
      if (method !== "HEAD") assert.equal(r.error, "untrusted_host", `${method} ${route}`);
    }
  });

  test("a tunnel or reverse proxy needs the token, and gets in with it", async () => {
    // tailscale serve / cloudflared pointed at the port: loopback socket,
    // public hostname. Without a token it is refused; with one it is a remote
    // caller like any other device, not the owner at the machine.
    const tunnel = { host: "lisa.example.com" };
    const bare = await send("GET", "/api/soul", tunnel);
    assert.equal(bare.status, 403);
    assert.equal(bare.error, "untrusted_host");
    const authed = { ...tunnel, authorization: `Bearer ${TOKEN}` };
    assert.equal((await send("GET", "/api/soul", authed)).status, 200);
    const chat = await send(
      "POST",
      "/chat",
      { ...authed, "content-type": "application/json" },
      "{}",
    );
    assert.equal(chat.status, 400, "reaches /chat's own validation");
    // Owner-only routes still tell the two apart: a forwarded caller is remote.
    assert.equal((await send("GET", "/api/remote/status", authed)).status, 403);
    assert.equal(
      (await send("GET", "/api/soul", { ...tunnel, authorization: "Bearer wrong" })).status,
      403,
    );
  });

  test("another site may navigate here but not fetch an API route", async () => {
    const crossSite = { "sec-fetch-site": "cross-site" };
    for (const mode of ["no-cors", "cors"]) {
      const r = await send("GET", "/api/soul", { ...crossSite, "sec-fetch-mode": mode });
      assert.equal(r.status, 403, mode);
      assert.equal(r.error, "cross_site_request", mode);
    }
    // A CORS preflight is refused too, so the real request is never sent.
    assert.equal(
      (await send("OPTIONS", "/chat", { ...crossSite, "sec-fetch-mode": "cors" })).status,
      403,
    );
    // Clicking a link into Lisa, or an OAuth provider redirecting back.
    const nav = await send("GET", "/", {
      ...crossSite,
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    });
    assert.equal(nav.status, 200);
    // A hidden iframe is a navigation too, but not a top-level one.
    const framed = await send("GET", "/api/soul", {
      ...crossSite,
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
    });
    assert.equal(framed.status, 403);
    assert.equal(framed.error, "cross_site_request");
  });

  test("the CLI, the native apps and curl send no browser metadata and are unaffected", async () => {
    assert.equal((await send("GET", "/api/soul")).status, 200);
    assert.equal((await send("GET", "/")).status, 200);
    // Reaches /chat's own validation instead of the gate.
    const chat = await send("POST", "/chat", { "content-type": "application/json" }, "{}");
    assert.equal(chat.status, 400);
    assert.notEqual(chat.error, "cross_site_request");
  });

  test("the web UI itself (same origin, any loopback name) is unaffected", async () => {
    for (const name of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const sameOrigin = {
        host: name,
        origin: `http://${name}`,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      };
      assert.equal((await send("GET", "/api/soul", sameOrigin)).status, 200, name);
      const chat = await send(
        "POST",
        "/chat",
        { ...sameOrigin, "content-type": "application/json" },
        "{}",
      );
      assert.equal(chat.status, 400, name);
    }
    // `--host 0.0.0.0` prints http://0.0.0.0:<port>; opened on this machine it
    // still arrives over loopback and must not be mistaken for a rebound Host.
    assert.equal((await send("GET", "/", { host: `0.0.0.0:${port}` })).status, 200);
  });
});

describe("loopbackTrustProblem", () => {
  const fake = (method: string, headers: http.IncomingHttpHeaders) =>
    ({ method, headers }) as http.IncomingMessage;
  const local = { host: "localhost:5757" };

  test("safe methods: loopback Host, and no cross-site fetch that is not a navigation", () => {
    assert.equal(loopbackTrustProblem(fake("GET", local), null), null);
    assert.equal(loopbackTrustProblem(fake("GET", {}), null), "untrusted_host");
    assert.equal(
      loopbackTrustProblem(fake("GET", { host: "10.0.0.5:5757" }), null),
      "untrusted_host",
    );
    assert.equal(
      loopbackTrustProblem(fake("GET", { ...local, "sec-fetch-site": "cross-site" }), null),
      "cross_site_request",
    );
    assert.equal(
      loopbackTrustProblem(
        fake("GET", { ...local, "sec-fetch-site": "Cross-Site", "sec-fetch-mode": "Navigate" }),
        null,
      ),
      null,
    );
    assert.equal(
      loopbackTrustProblem(
        fake("GET", {
          ...local,
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "iframe",
        }),
        null,
      ),
      "cross_site_request",
    );
    // Another port on this machine is same-site; a read from it is not refused
    // (it cannot see the answer), only a write is.
    assert.equal(
      loopbackTrustProblem(fake("GET", { ...local, "sec-fetch-site": "same-site" }), null),
      null,
    );
  });

  test("unsafe methods get the full cross-site check, navigation or not", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(loopbackTrustProblem(fake(method, local), null), null, method);
      assert.equal(
        loopbackTrustProblem(
          fake(method, { ...local, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }),
          null,
        ),
        "cross_site_request",
        method,
      );
      assert.equal(
        loopbackTrustProblem(fake(method, { ...local, origin: "http://localhost:3000" }), null),
        "cross_origin_request",
        method,
      );
      assert.equal(
        loopbackTrustProblem(fake(method, { host: "evil.example" }), null),
        "untrusted_host",
        method,
      );
    }
  });

  test("the operator's canonical origin is accepted, but only with a loopback Host", () => {
    const proxied = { origin: "https://lisa.example" };
    assert.equal(
      loopbackTrustProblem(fake("POST", { ...local, ...proxied }), "https://lisa.example"),
      null,
    );
    assert.equal(
      loopbackTrustProblem(
        fake("POST", { host: "lisa.example", ...proxied }),
        "https://lisa.example",
      ),
      "untrusted_host",
    );
  });
});
