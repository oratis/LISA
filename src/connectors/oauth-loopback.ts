/** One interactive authorization attempt, bound to a loopback listener, state and issuer. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { ConnectorError } from "./types.js";
export async function loopbackAuthorization<T>(
  signal: AbortSignal,
  issuer: string,
  work: (attempt: {
    redirect: string;
    state: string;
    challenge: string;
    verifier: string;
    code: Promise<string>;
  }) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(48).toString("base64url");
  let resolve!: (code: string) => void,
    reject!: (error: Error) => void,
    consumed = false;
  const code = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void code.catch(() => {});
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400);
      res.end("Invalid callback.");
      return;
    }
    const received = url.searchParams.get("state") ?? "";
    if (
      consumed ||
      req.method !== "GET" ||
      req.headers.host !== `127.0.0.1:${(server.address() as AddressInfo).port}` ||
      url.pathname !== "/oauth/connector" ||
      !/^[A-Za-z0-9_-]{43}$/.test(received) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(received)) ||
      url.searchParams.get("iss") !== issuer
    ) {
      res.writeHead(400);
      res.end("Invalid or expired authorization callback.");
      return;
    }
    consumed = true;
    if (url.searchParams.has("error")) {
      res.end("Authorization cancelled. Return to LISA.");
      reject(new ConnectorError("authorization_cancelled"));
      return;
    }
    const receivedCode = url.searchParams.get("code");
    if (!receivedCode || receivedCode.length > 4096) {
      res.writeHead(400);
      res.end("Invalid authorization response.");
      reject(new ConnectorError("mcp_authorization_failed"));
      return;
    }
    res.end("Sign-in received. Return to LISA to confirm the read-only scope.");
    resolve(receivedCode);
  });
  const cancel = () => reject(new ConnectorError("authorization_cancelled"));
  const timeout = setTimeout(
    () => reject(new ConnectorError("authorization_expired")),
    10 * 60_000,
  );
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    signal.throwIfAborted();
    return await work({
      redirect: `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/connector`,
      state,
      verifier,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      code,
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
