/** One interactive authorization attempt, bound to a loopback listener, state and issuer. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { ConnectorError } from "./types.js";
export async function loopbackAuthorization<T>(
  signal: AbortSignal,
  issuer: string | null,
  work: (attempt: {
    redirect: string;
    state: string;
    challenge: string;
    verifier: string;
    code: Promise<string>;
  }) => Promise<T>,
  options: {
    port?: number;
    hostname?: "127.0.0.1" | "localhost";
    pathname?:
      | "/oauth/connector"
      | "/oauth/notion"
      | "/oauth/slack"
      | "/oauth/microsoft"
      | "/oauth/atlassian"
      | "/oauth/dropbox"
      | "/oauth/todoist"
      | "/oauth/figma";
    /** Error code when a fixed callback port is already taken on either loopback. */
    portInUseCode?: string;
  } = {},
): Promise<T> {
  signal.throwIfAborted();
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(48).toString("base64url");
  let resolve!: (code: string) => void,
    reject!: (error: Error) => void,
    consumed = false,
    port = 0;
  const code = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void code.catch(() => {});
  const handler: http.RequestListener = (req, res) => {
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
      req.headers.host !== `${options.hostname ?? "127.0.0.1"}:${port}` ||
      url.pathname !== (options.pathname ?? "/oauth/connector") ||
      !/^[A-Za-z0-9_-]{43}$/.test(received) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(received)) ||
      (issuer !== null && url.searchParams.get("iss") !== issuer)
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
  };
  const cancel = () => reject(new ConnectorError("authorization_cancelled"));
  const timeout = setTimeout(
    () => reject(new ConnectorError("authorization_expired")),
    10 * 60_000,
  );
  signal.addEventListener("abort", cancel, { once: true });
  const servers: http.Server[] = [];
  const listen = (host: string, wanted: number) => {
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(wanted, host, () => resolve((server.address() as AddressInfo).port));
    });
  };
  try {
    try {
      port = await listen("127.0.0.1", options.port ?? 0);
      // Browsers try `localhost` on ::1 first. Hold that loopback too, so no other local
      // process can listen there and receive the authorization code and state.
      if (options.hostname === "localhost")
        await listen("::1", port).catch((error: NodeJS.ErrnoException) => {
          // A host without an IPv6 loopback has no ::1 for anyone else to take either.
          if (error.code !== "EADDRNOTAVAIL" && error.code !== "EAFNOSUPPORT") throw error;
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
        throw new ConnectorError(options.portInUseCode ?? "oauth_callback_port_in_use");
      throw error;
    }
    signal.throwIfAborted();
    return await work({
      redirect: `http://${options.hostname ?? "127.0.0.1"}:${port}${options.pathname ?? "/oauth/connector"}`,
      state,
      verifier,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      code,
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    await Promise.all(
      servers.map(async (server) => {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }
}
