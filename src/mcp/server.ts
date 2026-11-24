/**
 * Portable LISA MCP server (W11 of docs/PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md).
 *
 * Exposes a scoped, auditable subset of the user's own LISA (persona card,
 * memory search, personal KB search/read, task list, and optional draft-only
 * task creation) to external MCP clients such as Claude Desktop, Claude Code,
 * or Cursor.
 *
 * Transports:
 *  - stdio (default): newline-delimited JSON-RPC 2.0 over stdin/stdout.
 *  - Streamable HTTP (opt-in): strictly bound to 127.0.0.1 with a mandatory
 *    non-empty Bearer token verified in constant time, a 256 KiB request body
 *    cap, and browser cross-site / host-header checks.
 *
 * Security invariants:
 *  - Never exposes raw secrets, API keys, config.env, or Warden state.
 *  - Redacts secret-like patterns in all tool outputs.
 *  - `lisa_task_create` requires explicit `tasks:write` scope and ALWAYS
 *    creates a DISABLED draft task (`enabled: false, createdDisabled: true`).
 *  - Every tool invocation is logged to Warden's audit trail.
 */
import crypto from "node:crypto";
import http from "node:http";
import readline from "node:readline";
import { kbListTool, kbReadTool, kbSearchTool } from "../kb/tool.js";
import { memorySearchTool } from "../memory/search_tool.js";
import { lisaHome } from "../paths.js";
import { readSoulState } from "../soul/store.js";
import { createTask, listTasks } from "../tasks/store.js";
import { parseNewTask } from "../tasks/validate.js";
import { appendAudit } from "../warden/audit.js";
import { redactSecrets } from "../warden/preview.js";
import { BodyTooLargeError, readCappedText } from "../web/http-body.js";
import { crossSiteProblem, isLoopbackHostHeader } from "../web/warden-api.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_HTTP_BODY_LIMIT = 256 * 1024;

export type PortableMcpScope =
  | "persona:read"
  | "memory:read"
  | "kb:read"
  | "tasks:read"
  | "tasks:write";

export const DEFAULT_PORTABLE_SCOPES: readonly PortableMcpScope[] = [
  "persona:read",
  "memory:read",
  "kb:read",
  "tasks:read",
];

export const ALL_PORTABLE_SCOPES: ReadonlySet<PortableMcpScope> = new Set([
  "persona:read",
  "memory:read",
  "kb:read",
  "tasks:read",
  "tasks:write",
]);

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface PortableMcpToolDescriptor {
  name: string;
  description: string;
  scope: PortableMcpScope;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface PortableMcpServerOptions {
  home?: string;
  scopes?: Iterable<PortableMcpScope>;
  clientLabel?: string;
  version?: string;
  cwd?: string;
}

const TOOL_CATALOG: readonly PortableMcpToolDescriptor[] = [
  {
    name: "lisa_persona",
    description:
      "Read a concise, redacted summary of Lisa's identity, traits, values, and current mood.",
    scope: "persona:read",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lisa_memory_search",
    description: "Search Lisa's personal memory and past conversation notes.",
    scope: "memory:read",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords or topic." },
        limit: { type: "number", description: "Max results (1-20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "lisa_kb_search",
    description: "Search Lisa's personal knowledge base (wiki pages and captured sources).",
    scope: "kb:read",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Max hits (1-20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "lisa_kb_read",
    description: "Read one page from Lisa's personal knowledge base by slug, or list pages if omitted.",
    scope: "kb:read",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Knowledge base slug (e.g. wiki/topic)." },
      },
    },
  },
  {
    name: "lisa_task_list",
    description: "List Lisa's durable tasks (routines, watchers, goals, one-off tasks).",
    scope: "tasks:read",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lisa_task_create",
    description:
      "Draft a new task in Lisa's Task Engine. Always created DISABLED until the user reviews and enables it.",
    scope: "tasks:write",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        instruction: { type: "string" },
        kind: { type: "string", enum: ["oneoff", "routine", "watcher", "goal"] },
        schedule: {
          type: "object",
          properties: { expr: { type: "string" }, tz: { type: "string" } },
        },
      },
      required: ["title", "instruction"],
    },
  },
];

export function parseScopes(raw: string | undefined): PortableMcpScope[] {
  if (!raw || !raw.trim()) return [...DEFAULT_PORTABLE_SCOPES];
  const out: PortableMcpScope[] = [];
  for (const token of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!ALL_PORTABLE_SCOPES.has(token as PortableMcpScope)) {
      throw new Error(
        `Unknown MCP scope "${token}". Valid scopes: ${[...ALL_PORTABLE_SCOPES].join(", ")}`,
      );
    }
    if (!out.includes(token as PortableMcpScope)) out.push(token as PortableMcpScope);
  }
  return out;
}

export class PortableLisaMcpServer {
  private readonly home: string;
  private readonly scopes: Set<PortableMcpScope>;
  private readonly clientLabel: string;
  private readonly version: string;
  private readonly cwd: string;

  constructor(opts: PortableMcpServerOptions = {}) {
    this.home = opts.home ?? lisaHome();
    this.scopes = new Set(opts.scopes ?? DEFAULT_PORTABLE_SCOPES);
    this.clientLabel = opts.clientLabel ?? "portable-mcp";
    this.version = opts.version ?? "0.34.0";
    this.cwd = opts.cwd ?? process.cwd();
  }

  /** Tools visible to this server's granted scopes. */
  listTools(): Array<Omit<PortableMcpToolDescriptor, "scope">> {
    return TOOL_CATALOG.filter((t) => this.scopes.has(t.scope)).map(({ scope: _s, ...rest }) => rest);
  }

  /** Handle one JSON-RPC 2.0 request. Returns null for notifications (no id). */
  async handleMessage(raw: unknown): Promise<JsonRpcResponse | null> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid JSON-RPC request" },
      };
    }
    const req = raw as Partial<JsonRpcRequest>;
    const hasId = req.id !== undefined;
    const id = hasId ? (req.id ?? null) : null;
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return hasId
        ? { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid JSON-RPC 2.0 envelope" } }
        : null;
    }

    // Notifications require no response.
    if (req.method === "notifications/initialized" || !hasId) {
      return null;
    }

    if (req.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "lisa", version: this.version },
        },
      };
    }

    if (req.method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (req.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: this.listTools() } };
    }

    if (req.method === "tools/call") {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      return await this.callTool(id, name, args);
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    };
  }

  private async audit(tool: string, verdict: "allow" | "deny", reason: string): Promise<void> {
    await appendAudit(
      {
        at: new Date().toISOString(),
        kind: "decision",
        surface: "local-web",
        origin: "mcp",
        originId: this.clientLabel,
        tool,
        category: tool === "lisa_task_create" ? "draft" : "read",
        verdict,
        reason,
      },
      this.home,
    ).catch(() => undefined);
  }

  private async callTool(
    id: string | number | null,
    name: string,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const descriptor = TOOL_CATALOG.find((t) => t.name === name);
    if (!descriptor) {
      await this.audit(name || "unknown", "deny", "unknown portable MCP tool");
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      };
    }
    if (!this.scopes.has(descriptor.scope)) {
      await this.audit(name, "deny", `missing scope ${descriptor.scope}`);
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32001,
          message: `Scope "${descriptor.scope}" is not enabled on this MCP server.`,
        },
      };
    }

    const toolCtx = {
      cwd: this.cwd,
      signal: new AbortController().signal,
      log: () => {},
    };

    try {
      let text: string;
      switch (name) {
        case "lisa_persona": {
          const soul = await readSoulState();
          const card = {
            name: "Lisa",
            bornAt: soul.seed?.bornAt ?? null,
            seed: soul.seed?.note ?? null,
            mood: soul.mood?.current ?? "neutral",
            identityExcerpt: soul.identity.slice(0, 1200),
            userExcerpt: soul.user.slice(0, 800),
          };
          text = JSON.stringify(card, null, 2);
          break;
        }
        case "lisa_memory_search": {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          if (!query) {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "query is required" },
            };
          }
          const limit =
            typeof args.limit === "number" && Number.isFinite(args.limit)
              ? Math.max(1, Math.min(Math.floor(args.limit), 20))
              : 10;
          text = await memorySearchTool.execute({ query, limit }, toolCtx);
          break;
        }
        case "lisa_kb_search": {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          if (!query) {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "query is required" },
            };
          }
          text = await kbSearchTool.execute(
            { query, limit: typeof args.limit === "number" ? args.limit : 10 },
            toolCtx,
          );
          break;
        }
        case "lisa_kb_read": {
          const slug = typeof args.slug === "string" ? args.slug.trim() : "";
          text = slug
            ? await kbReadTool.execute({ slug }, toolCtx)
            : await kbListTool.execute({}, toolCtx);
          break;
        }
        case "lisa_task_list": {
          const tasks = await listTasks();
          text = JSON.stringify(
            tasks.map((t) => ({
              id: t.id,
              kind: t.kind,
              title: t.title,
              state: t.state,
              enabled: t.enabled,
              schedule: t.schedule,
              nextRunAt: t.nextRunAt,
              lastSummary: t.lastSummary,
            })),
            null,
            2,
          );
          break;
        }
        case "lisa_task_create": {
          const parsed = parseNewTask(args, {
            cloud: false,
            origin: { kind: "api" },
            owner: null,
          });
          if (!parsed.ok) {
            await this.audit(name, "deny", `invalid draft: ${parsed.error}`);
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: parsed.error },
            };
          }
          // Always created disabled; external MCP clients never enable unattended runs.
          const task = await createTask({
            ...parsed.value,
            enabled: false,
            createdDisabled: true,
          });
          text = JSON.stringify(
            {
              id: task.id,
              title: task.title,
              kind: task.kind,
              state: task.state,
              enabled: false,
              note: "Created as a disabled draft; review and enable in Lisa.",
            },
            null,
            2,
          );
          break;
        }
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Unsupported tool: ${name}` },
          };
      }

      const safeText = redactSecrets(text);
      await this.audit(name, "allow", "portable MCP call succeeded");
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: safeText }],
          isError: false,
        },
      };
    } catch (err) {
      await this.audit(name, "deny", `error: ${(err as Error).message}`);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: redactSecrets(`Error: ${(err as Error).message}`) }],
          isError: true,
        },
      };
    }
  }
}

/** Run the Portable LISA MCP server over stdio (newline-delimited JSON-RPC 2.0). */
export async function servePortableMcpStdio(
  server: PortableLisaMcpServer,
  opts: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const onAbort = () => rl.close();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const errResp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        };
        output.write(JSON.stringify(errResp) + "\n");
        continue;
      }
      const resp = await server.handleMessage(parsed);
      if (resp) {
        output.write(JSON.stringify(resp) + "\n");
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    rl.close();
  }
}

function bearerMatches(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const provided = authHeader.slice("Bearer ".length).trim();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expectedToken, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface PortableMcpHttpHandle {
  server: http.Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Start a 127.0.0.1-only, Bearer-token-gated Streamable HTTP MCP endpoint.
 * Refuses to start without a non-empty token or on any non-loopback host.
 */
export async function startPortableMcpHttpServer(
  mcp: PortableLisaMcpServer,
  opts: { host?: string; port?: number; token: string },
): Promise<PortableMcpHttpHandle> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error(
      `Refusing to bind Portable MCP HTTP server to non-loopback host "${host}". Use 127.0.0.1.`,
    );
  }
  const token = String(opts.token ?? "").trim();
  if (token.length < 16) {
    throw new Error(
      "Portable MCP HTTP server requires a Bearer token of at least 16 characters (--token or LISA_MCP_HTTP_TOKEN).",
    );
  }

  const server = http.createServer(async (req, res) => {
    const baseHeaders = {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    const send = (status: number, body: unknown) => {
      res.writeHead(status, baseHeaders);
      res.end(JSON.stringify(body));
    };

    if (!isLoopbackHostHeader(req.headers.host)) {
      send(403, { error: "untrusted_host" });
      return;
    }
    const crossSite = crossSiteProblem(req, true, null);
    if (crossSite) {
      send(403, { error: crossSite });
      return;
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      res.writeHead(401, { ...baseHeaders, "www-authenticate": 'Bearer realm="lisa-mcp"' });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/mcp") {
      send(404, { error: "not_found" });
      return;
    }
    if (req.method !== "POST") {
      send(405, { error: "method_not_allowed" });
      return;
    }
    const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!ctype.startsWith("application/json")) {
      send(415, { error: "content_type_must_be_json" });
      return;
    }

    let raw: string;
    try {
      raw = await readCappedText(req, MCP_HTTP_BODY_LIMIT);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        send(413, { error: "body_too_large" });
        return;
      }
      send(400, { error: "invalid_body" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const reply = await mcp.handleMessage(parsed);
    if (!reply) {
      res.writeHead(202, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end();
      return;
    }
    send(200, reply);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  return {
    server,
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
