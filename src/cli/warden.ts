/**
 * `lisa approvals` and `lisa warden` — the approval inbox and Warden rules
 * from a terminal (headless hosts, SSH).
 *
 *   lisa approvals [list] [--port N]
 *   lisa approvals show <id> [--port N]            the WHOLE payload, and its digest
 *   lisa approvals approve <id> --digest <digest> [--scope once|task|target|24h|always] [--port N]
 *   lisa approvals deny <id> [--reason "..."] [--port N]
 *   lisa warden rules [show]
 *   lisa warden rules set <category> <auto|preapproved|ask|handoff>
 *   lisa warden grants [list] | lisa warden grants revoke <id>
 *   lisa warden audit [--limit N]
 *
 * Pending approvals live in the running server (the waiter is a Promise in
 * that process), so `approvals` talks to it over loopback — which is also what
 * makes this caller a trusted approver. Rules, grants and the audit log are
 * files under <lisaHome>/warden and are read directly.
 */
import { Agent, setGlobalDispatcher } from "undici";
import { readAudit } from "../warden/audit.js";
import { loadGrants, revokeGrant } from "../warden/grants.js";
import { LOCKED_CATEGORIES, loadRules, ownBehavior, setCategoryRule } from "../warden/rules.js";
import type { PayloadField } from "../warden/types.js";
import {
  ACTION_CATEGORIES,
  GRANT_SCOPES,
  RULE_BEHAVIORS,
  isActionCategory,
  isGrantScope,
  isRuleBehavior,
} from "../warden/types.js";

const APPROVALS_USAGE =
  "usage: lisa approvals [list] [--port N]\n" +
  "       lisa approvals show <id> [--port N]\n" +
  `       lisa approvals approve <id> --digest <digest> [--scope ${GRANT_SCOPES.join("|")}] [--port N]\n` +
  '       lisa approvals deny <id> [--reason "..."] [--port N]';

const WARDEN_USAGE =
  "usage: lisa warden rules [show]\n" +
  `       lisa warden rules set <category> <${RULE_BEHAVIORS.join("|")}>\n` +
  "       lisa warden grants [list]\n" +
  "       lisa warden grants revoke <id>\n" +
  "       lisa warden audit [--limit N]\n" +
  `categories: ${ACTION_CATEGORIES.join(", ")}`;

export function parseFlags(args: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 2) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else {
      flags[a.slice(2)] = "true";
    }
  }
  return { flags, rest };
}

interface Out {
  log: (line: string) => void;
  error: (line: string) => void;
}
const consoleOut: Out = { log: (l) => console.log(l), error: (l) => console.error(l) };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function describeItem(item: Record<string, unknown>): string {
  const targets =
    Array.isArray(item.targets) && item.targets.length ? ` → ${item.targets.join(", ")}` : "";
  const kind = item.kind === "handoff" ? "HANDOFF " : "";
  return (
    `${String(item.id)}  ${kind}[${String(item.category)}] ${String(item.preview)}${targets}\n` +
    `    why: ${String(item.reason)}\n` +
    `    expires: ${String(item.expiresAt)}`
  );
}

export async function runApprovalsCommand(
  args: string[],
  deps: { fetch?: Fetch; out?: Out } = {},
): Promise<number> {
  const out = deps.out ?? consoleOut;
  const { flags, rest } = parseFlags(args);
  const action = rest[0] ?? "list";
  const port = Number(flags.port ?? process.env.LISA_PORT ?? 5757);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    out.error("--port must be a port number");
    return 2;
  }
  let doFetch = deps.fetch;
  if (!doFetch) {
    // Loopback only; bypass any global proxy dispatcher (see cli/pair.ts).
    setGlobalDispatcher(new Agent());
    doFetch = (url, init) => fetch(url, init);
  }
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, route: string, body?: unknown): Promise<Response | null> => {
    try {
      return await doFetch(`${base}${route}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      out.error(`Could not reach LISA at ${base} (${(err as Error).message}).`);
      out.error("Approvals live in the running server: start it with `lisa serve --web`.");
      return null;
    }
  };

  if (action === "list") {
    const res = await call("GET", "/api/approvals");
    if (!res) return 1;
    if (!res.ok) {
      out.error(`list failed (${res.status})`);
      return 1;
    }
    const body = (await res.json()) as { approvals?: Array<Record<string, unknown>> };
    const items = body.approvals ?? [];
    if (items.length === 0) {
      out.log("No pending approvals.");
      return 0;
    }
    for (const item of items) out.log(describeItem(item));
    return 0;
  }

  /** Fetch one item with its whole payload; null (after reporting) when it cannot be shown. */
  const fetchDetail = async (
    id: string,
  ): Promise<{ digest: string; scopes: string[]; fields: PayloadField[] } | null> => {
    const res = await call("GET", `/api/approvals/${encodeURIComponent(id)}`);
    if (!res) return null;
    const body = (await res.json().catch(() => ({}))) as {
      approval?: { digest?: unknown; scopes?: unknown };
      fields?: unknown;
      error?: unknown;
    };
    if (!res.ok || typeof body.approval?.digest !== "string" || !Array.isArray(body.fields)) {
      out.error(`show failed (${res.status}): ${String(body.error ?? "unknown")}`);
      return null;
    }
    return {
      digest: body.approval.digest,
      scopes: Array.isArray(body.approval.scopes) ? body.approval.scopes.map(String) : [],
      fields: body.fields as PayloadField[],
    };
  };

  if (action === "show") {
    const id = rest[1];
    if (!id) {
      out.error(APPROVALS_USAGE);
      return 2;
    }
    const detail = await fetchDetail(id);
    if (!detail) return 1;
    for (const field of detail.fields) {
      out.log(`── ${field.key}${field.primary ? "" : " (other)"}`);
      out.log(String(field.value));
    }
    out.log(`── digest ${detail.digest}`);
    out.log(`── scopes ${detail.scopes.join(", ") || "(none)"}`);
    out.log(`To approve exactly this: lisa approvals approve ${id} --digest ${detail.digest}`);
    return 0;
  }

  if (action === "approve" || action === "deny") {
    const id = rest[1];
    if (!id) {
      out.error(APPROVALS_USAGE);
      return 2;
    }
    let body: Record<string, unknown> = {};
    if (action === "approve") {
      const scope = flags.scope ?? "once";
      if (!isGrantScope(scope)) {
        out.error(`bad --scope "${scope}" — expected one of ${GRANT_SCOPES.join(" | ")}`);
        return 2;
      }
      // An approval names the payload that was read. The digest comes from
      // `lisa approvals show <id>`; it is never looked up on the user's behalf.
      const digest = flags.digest;
      if (!digest || digest === "true" || digest.length < 12) {
        out.error(
          `approve needs --digest. Run \`lisa approvals show ${id}\` to read the request and get its digest.`,
        );
        return 2;
      }
      body = { scope, digest };
    } else if (flags.reason && flags.reason !== "true") {
      body = { reason: flags.reason };
    }
    const res = await call("POST", `/api/approvals/${encodeURIComponent(id)}/${action}`, body);
    if (!res) return 1;
    const reply = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      out.error(
        `${action} failed (${res.status}): ${String(reply.error ?? "unknown")}` +
          (reply.message ? ` — ${String(reply.message)}` : ""),
      );
      return 1;
    }
    out.log(
      `${String(reply.verdict)}${reply.scope ? ` (scope: ${String(reply.scope)})` : ""}: ${id}`,
    );
    return 0;
  }

  out.error(APPROVALS_USAGE);
  return 2;
}

export async function runWardenCommand(
  args: string[],
  deps: { out?: Out; home?: string } = {},
): Promise<number> {
  const out = deps.out ?? consoleOut;
  const { flags, rest } = parseFlags(args);
  const [noun, verb, ...tail] = rest;

  if (noun === "rules") {
    if (verb === undefined || verb === "show") {
      const { rules, corrupt } = await loadRules(deps.home);
      if (corrupt) {
        out.error(
          "rules.json is corrupt. Until it is fixed or deleted, every side-effecting action asks.",
        );
      }
      for (const category of ACTION_CATEGORIES) {
        const locked = ownBehavior(LOCKED_CATEGORIES, category);
        const set = ownBehavior(rules.categories, category);
        out.log(`${category.padEnd(11)} ${locked ? `${locked} (fixed)` : (set ?? "default")}`);
      }
      for (const [tool, behavior] of Object.entries(rules.tools)) {
        out.log(`tool   ${tool}: ${behavior}`);
      }
      for (const [target, behavior] of Object.entries(rules.targets)) {
        out.log(`target ${target}: ${behavior}`);
      }
      return corrupt ? 1 : 0;
    }
    if (verb === "set") {
      const [category, behavior] = tail;
      if (!isActionCategory(category) || !isRuleBehavior(behavior)) {
        out.error(WARDEN_USAGE);
        return 2;
      }
      try {
        await setCategoryRule(category, behavior, deps.home);
      } catch (err) {
        out.error((err as Error).message);
        return 1;
      }
      out.log(`${category}: ${behavior}`);
      return 0;
    }
    out.error(WARDEN_USAGE);
    return 2;
  }

  if (noun === "grants") {
    if (verb === undefined || verb === "list") {
      const { grants, corrupt } = await loadGrants(deps.home);
      if (corrupt) out.error("grants.json is corrupt and is being treated as empty.");
      if (grants.length === 0) out.log("No grants.");
      for (const g of grants) {
        const binding =
          g.target ?? g.taskId ?? (g.digest ? `payload ${g.digest.slice(0, 12)}` : "");
        out.log(
          `${g.id}  ${g.scope.padEnd(6)} ${g.tool}${g.method ? `.${g.method}` : ""} [${g.category}]` +
            `${binding ? ` ${binding}` : ""}${g.expiresAt ? ` until ${g.expiresAt}` : ""} uses=${g.uses}`,
        );
      }
      return corrupt ? 1 : 0;
    }
    if (verb === "revoke") {
      const id = tail[0];
      if (!id) {
        out.error(WARDEN_USAGE);
        return 2;
      }
      const revoked = await revokeGrant(id, deps.home);
      if (!revoked) {
        out.error(`no such grant: ${id}`);
        return 1;
      }
      out.log(`revoked ${id}`);
      return 0;
    }
    out.error(WARDEN_USAGE);
    return 2;
  }

  if (noun === "audit") {
    const limit = Number(flags.limit ?? 20);
    const entries = await readAudit({
      home: deps.home,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
    });
    if (entries.length === 0) out.log("No audit entries.");
    for (const e of entries.reverse()) {
      const what =
        e.kind === "resolution"
          ? `→ ${e.resolution}${e.scope ? `/${e.scope}` : ""}`
          : (e.verdict ?? e.kind);
      out.log(`${e.at}  ${String(what).padEnd(18)} ${e.preview ?? e.tool ?? ""}`);
    }
    return 0;
  }

  out.error(WARDEN_USAGE);
  return 2;
}
