import {
  PortableLisaMcpServer,
  parseScopes,
  servePortableMcpStdio,
  startPortableMcpHttpServer,
} from "../mcp/server.js";

export async function runMcpCommand(
  args: readonly string[],
  opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    console.error(
      "usage: lisa mcp serve [--http --port <N> --token <secret>] [--scope persona:read,memory:read,kb:read,tasks:read[,tasks:write]]",
    );
    return 0;
  }
  if (sub !== "serve") {
    console.error(`unknown mcp subcommand: ${sub}`);
    return 2;
  }

  let useHttp = false;
  let host = "127.0.0.1";
  let port = 3741;
  let token = process.env.LISA_MCP_HTTP_TOKEN ?? "";
  let scopeArg: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--http") {
      useHttp = true;
    } else if (a === "--host") {
      host = rest[++i] ?? "";
    } else if (a.startsWith("--host=")) {
      host = a.slice("--host=".length);
    } else if (a === "--port") {
      port = Number(rest[++i]);
    } else if (a.startsWith("--port=")) {
      port = Number(a.slice("--port=".length));
    } else if (a === "--token") {
      token = rest[++i] ?? "";
    } else if (a.startsWith("--token=")) {
      token = a.slice("--token=".length);
    } else if (a === "--scope") {
      scopeArg = rest[++i];
    } else if (a.startsWith("--scope=")) {
      scopeArg = a.slice("--scope=".length);
    } else if (a === "--help" || a === "-h") {
      console.error(
        "usage: lisa mcp serve [--http --port <N> --token <secret>] [--scope persona:read,memory:read,kb:read,tasks:read[,tasks:write]]",
      );
      return 0;
    } else {
      console.error(`unknown option for lisa mcp serve: ${a}`);
      return 2;
    }
  }

  const scopes = parseScopes(scopeArg);
  const server = new PortableLisaMcpServer({
    scopes,
    cwd: opts.cwd,
    clientLabel: useHttp ? "portable-mcp-http" : "portable-mcp-stdio",
  });

  if (!useHttp) {
    await servePortableMcpStdio(server, { signal: opts.signal });
    return 0;
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("invalid --port value");
    return 2;
  }

  const handle = await startPortableMcpHttpServer(server, { host, port, token });
  console.error(`[lisa-mcp] listening on ${handle.url} (scopes: ${scopes.join(", ")})`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      void handle.close().then(() => resolve());
    };
    if (opts.signal?.aborted) {
      stop();
      return;
    }
    opts.signal?.addEventListener("abort", stop, { once: true });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
