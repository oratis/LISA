import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { applySecurityHeaders, SECURITY_HEADERS } from "./security-headers.js";

/** One real request against a throwaway server, no keep-alive. */
function get(port: number, path: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("security headers helper", () => {
  let server: http.Server;
  let port = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      applySecurityHeaders(res);
      if (req.url === "/override") {
        // A route may deliberately override one header; the helper must not
        // clobber it (writeHead wins over setHeader by Node's merge rule).
        res.writeHead(200, { "content-type": "text/plain", "x-frame-options": "DENY" });
        res.end("ok");
        return;
      }
      if (req.url === "/bare") {
        // A route that writes no headers at all still carries the baseline.
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("every response carries the four baseline headers", async () => {
    const res = await get(port, "/");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["permissions-policy"], "camera=(), geolocation=(), payment=()");
    // The route's own headers survive the merge.
    assert.equal(res.headers["content-type"], "application/json");
  });

  test("a header-less 404 still gets them", async () => {
    const res = await get(port, "/bare");
    assert.equal(res.statusCode, 404);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(res.headers[name], value, name);
    }
  });

  test("a route can still override one on purpose", async () => {
    const res = await get(port, "/override");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  });

  test("the microphone is deliberately not blocked (composer dictation)", () => {
    assert.doesNotMatch(SECURITY_HEADERS["permissions-policy"]!, /microphone/);
  });

  test("is a no-op once headers are on the wire", () => {
    // Guard against a late call (e.g. from an error path after streaming
    // began) throwing ERR_HTTP_HEADERS_SENT and masking the real error.
    const fake = {
      headersSent: true,
      hasHeader: () => false,
      setHeader: () => {
        throw new Error("must not be called");
      },
    } as unknown as http.ServerResponse;
    assert.doesNotThrow(() => applySecurityHeaders(fake));
  });
});
