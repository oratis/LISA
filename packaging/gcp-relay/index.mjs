// Anthropic API reverse proxy for Cloud Run.
//
// Why: a client on a network that can't reliably reach api.anthropic.com (e.g. a
// flaky local HTTP proxy) points ANTHROPIC_BASE_URL at this service instead. GCP
// egress to Anthropic is reliable, so the round trip stops failing.
//
// Security model (key-swap gate): the REAL Anthropic key lives only here (Secret
// Manager → env). The client authenticates to the relay with a separate
// RELAY_TOKEN, presented in the `x-api-key` header (which is what the Anthropic
// SDK already sends). The relay checks it, then swaps in the real key before
// forwarding. So: the real key never leaves GCP; the token is revocable; and the
// service isn't an open Anthropic-funded proxy.
//
// This is a TRANSPARENT relay — it does NOT touch billing (no `anthropic-beta:
// claude-code-*` spoofing, no OAuth-session reuse). Requests bill normally against
// the real key, which is ToS-clean. See README.md.
import http from "node:http";

const UPSTREAM = process.env.UPSTREAM || "https://api.anthropic.com";
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const PORT = Number(process.env.PORT) || 8080;

// Headers we must not copy from client→upstream (hop-by-hop or auth we replace).
const STRIP_REQ = new Set(["host", "content-length", "connection", "x-api-key", "authorization"]);
// Headers we must not copy from upstream→client (let Node re-frame the body).
const STRIP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

const presentedToken = (req) =>
  req.headers["x-api-key"] ||
  (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "") ||
  "";

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/" || req.url === "/health" || req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    // Only proxy the Anthropic API surface.
    if (!req.url.startsWith("/v1/")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    // Gate: constant-time-ish compare of the relay token.
    if (!RELAY_TOKEN || !ANTHROPIC_API_KEY) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("relay not configured");
      return;
    }
    const tok = presentedToken(req);
    if (tok.length !== RELAY_TOKEN.length || !safeEqual(tok, RELAY_TOKEN)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid relay token" } }));
      return;
    }

    // Buffer the request body (chat payloads are small).
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    // Forward headers, swapping auth to the real key.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!STRIP_REQ.has(k.toLowerCase())) headers[k] = v;
    }
    headers["x-api-key"] = ANTHROPIC_API_KEY;
    if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + req.url, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "relay_upstream_error", message: String(e && e.message || e) } }));
      return;
    }

    // Stream the response straight back (SSE for streaming completions).
    const respHeaders = {};
    upstream.headers.forEach((v, k) => { if (!STRIP_RES.has(k.toLowerCase())) respHeaders[k] = v; });
    res.writeHead(upstream.status, respHeaders);
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("relay error");
  }
});

function safeEqual(a, b) {
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

server.headersTimeout = 0; // long streaming turns
server.requestTimeout = 0;
server.listen(PORT, () => console.log(`anthropic relay listening on :${PORT} → ${UPSTREAM}`));
