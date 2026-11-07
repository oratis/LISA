/**
 * Warden HTTP surface: the approval inbox, rules, grants and audit.
 *
 *   GET    /api/approvals                  pending items for this tenant
 *   GET    /api/approvals/{id}             one item with the WHOLE payload (approvers only)
 *   POST   /api/approvals/{id}/approve     body {digest, scope?}
 *   POST   /api/approvals/{id}/deny        body {reason?}
 *   GET    /api/warden/rules               PUT /api/warden/rules
 *   GET    /api/warden/grants              DELETE /api/warden/grants/{id}
 *   GET    /api/warden/audit?limit=
 *
 * The server's auth gate has already run when this is called. Tenancy comes
 * from the caller's authenticated scope (`uid` + `home`), never from the
 * request. Every state-changing route additionally requires a trusted
 * approver — the loopback owner or a signed-in per-user session — and refuses
 * cross-site requests, because these routes are exactly what a hostile page or
 * a prompt-injected model would want to reach.
 */
import type http from "node:http";
import type { ApprovalCallback } from "../agent.js";
import type { AgentEvent, ToolDefinition } from "../types.js";
import type { RuntimePolicy } from "../runtime-policy.js";
import type { SandboxMode } from "../sandbox/mode.js";
import { lisaHome } from "../paths.js";
import { BodyTooLargeError, readCappedText } from "./http-body.js";
import { configuredPublicOrigin } from "./public-origin.js";
import { WardenInbox, type ResolveResult } from "../warden/inbox.js";
import { KnownUrls, createWardenSession } from "../warden/session.js";
import { isConversationTainted, markConversationTainted } from "../warden/taint.js";
import { appendAudit, readAudit } from "../warden/audit.js";
import { loadGrants, revokeGrant } from "../warden/grants.js";
import { LOCKED_CATEGORIES, RulesValidationError, loadRules, saveRules } from "../warden/rules.js";
import {
  ACTION_CATEGORIES,
  GRANT_SCOPES,
  RULE_BEHAVIORS,
  type Origin,
  type WardenEmit,
} from "../warden/types.js";

/** Warden bodies are a scope, a reason or a rules document — never large. */
export const WARDEN_BODY_LIMIT = 64 * 1024;

export interface WardenApiOptions {
  inbox: WardenInbox;
  /** Authenticated tenant (`scopedUid()`), null on the Mac edition. */
  uid: string | null;
  /** The tenant's home (`lisaHome()` inside the request scope). */
  home: string;
  /** True only for loopback or an authenticated per-user session. */
  allowApproval: boolean;
  /** The caller is trusted ONLY because it connected from loopback (no account session). */
  loopbackTrust: boolean;
}

/**
 * Who may answer approvals and change Warden state, from what the server's
 * auth gate established about the caller.
 *
 *  - A signed-in per-user session may (cloud or not).
 *  - The loopback peer may on the Mac edition — the person at the machine.
 *    On the hosted edition loopback is a proxy hop, not an owner.
 *  - Anyone else who passed the gate (shared web token, paired-device token
 *    from the LAN) can read their inbox but not answer it.
 *
 * `loopbackTrust` is true only when loopback is the SOLE reason the caller is
 * trusted; that is when the Host header has to be a loopback name too.
 */
export function wardenTrust(caller: {
  cloud: boolean;
  loopback: boolean;
  accountUid: string | null;
}): Pick<WardenApiOptions, "allowApproval" | "loopbackTrust"> {
  const loopbackOwner = !caller.cloud && caller.loopback;
  return {
    allowApproval: loopbackOwner || caller.accountUid !== null,
    loopbackTrust: loopbackOwner && caller.accountUid === null,
  };
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  let name = host.trim().toLowerCase();
  if (name.startsWith("[")) name = name.slice(0, name.indexOf("]") + 1);
  else if (name.includes(":")) name = name.slice(0, name.lastIndexOf(":"));
  return (
    name === "localhost" ||
    name === "[::1]" ||
    name.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(name)
  );
}

/**
 * Why a state-changing request is refused before it is even parsed, or null.
 *
 *  - A browser on another site must not be able to drive an approval: reject
 *    `Sec-Fetch-Site: cross-site` and any `Origin` that is not this host.
 *  - Loopback trust is only as good as the Host header: a DNS-rebinding page
 *    (or a tunnel that forwards a public hostname to 127.0.0.1) connects from
 *    loopback but names a non-loopback host.
 */
export function crossSiteProblem(
  req: http.IncomingMessage,
  loopbackTrust: boolean,
  publicOrigin: string | null = safePublicOrigin(),
): string | null {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site.toLowerCase() === "cross-site") return "cross_site_request";
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "null") {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return "bad_origin";
    }
    // Same host as the request, or the operator-configured canonical origin
    // (a fronting proxy may rewrite Host).
    const sameHost = parsed.host.toLowerCase() === (req.headers.host ?? "").toLowerCase();
    if (!sameHost && parsed.origin !== publicOrigin) return "cross_origin_request";
  } else if (origin === "null") {
    return "cross_origin_request";
  }
  if (loopbackTrust && !isLoopbackHostHeader(req.headers.host)) return "untrusted_host";
  return null;
}

function safePublicOrigin(): string | null {
  try {
    return configuredPublicOrigin();
  } catch {
    return null;
  }
}

class BadRequest extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

async function bodyObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  // Requiring JSON makes these non-"simple" requests: a cross-origin page
  // cannot send them without a preflight this server never answers.
  const type = (req.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("application/json")) throw new BadRequest(415, "content_type_must_be_json");
  let raw: string;
  try {
    raw = await readCappedText(req, WARDEN_BODY_LIMIT);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new BadRequest(413, "body_too_large");
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new BadRequest(400, "invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRequest(400, "body_must_be_object");
  }
  return parsed as Record<string, unknown>;
}

const RESOLVE_STATUS: Record<string, number> = {
  not_found: 404,
  digest_required: 400,
  expired: 410,
  not_approvable: 409,
  invalid_scope: 400,
  scope_not_applicable: 400,
  digest_mismatch: 409,
  audit_failed: 500,
};

function sendResolve(res: http.ServerResponse, result: ResolveResult): void {
  if (result.ok) {
    json(res, 200, {
      ok: true,
      id: result.id,
      verdict: result.verdict,
      scope: result.scope,
      grantIds: result.grantIds,
      grantError: result.grantError ? "grant_not_persisted" : undefined,
    });
    return;
  }
  const status = Object.hasOwn(RESOLVE_STATUS, result.error) ? RESOLVE_STATUS[result.error]! : 400;
  json(res, status, {
    error: result.error === "not_found" ? "approval_not_found" : result.error,
    message: result.message,
  });
}

/**
 * Handle `/api/approvals*` and `/api/warden/*`. Returns false when the route
 * is outside this domain.
 */
export async function handleWardenApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  opts: WardenApiOptions,
): Promise<boolean> {
  const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
  const pathname = parsedUrl.pathname;
  const isApprovals = pathname === "/api/approvals" || pathname.startsWith("/api/approvals/");
  if (!isApprovals && !pathname.startsWith("/api/warden/")) return false;
  const method = req.method ?? "GET";

  /** Gate for every route that changes state. Sends the refusal itself. */
  const mayChange = (): boolean => {
    if (!opts.allowApproval) {
      json(res, 403, { error: "trusted_local_confirmation_required" });
      return false;
    }
    const problem = crossSiteProblem(req, opts.loopbackTrust);
    if (problem) {
      json(res, 403, { error: problem });
      return false;
    }
    return true;
  };

  try {
    // Reads are tenant-scoped by construction, but a loopback-trusted caller
    // must still name a loopback host (DNS rebinding can read, too).
    if (method === "GET") {
      const problem = crossSiteProblem(req, opts.loopbackTrust);
      if (problem) {
        json(res, 403, { error: problem });
        return true;
      }
    }

    if (pathname === "/api/approvals") {
      if (method !== "GET") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      json(res, 200, {
        approvals: await opts.inbox.list(opts.uid, opts.home),
        canApprove: opts.allowApproval,
      });
      return true;
    }

    const detail = pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (detail) {
      if (method !== "GET") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      // The full payload is shown only to someone who could approve it: the
      // short, redacted preview in the list is what every other caller gets.
      if (!opts.allowApproval) {
        json(res, 403, { error: "trusted_local_confirmation_required" });
        return true;
      }
      const found = opts.inbox.detail(opts.uid, decodeURIComponent(detail[1]!));
      if (!found) {
        json(res, 404, { error: "approval_not_found" });
        return true;
      }
      json(res, 200, found);
      return true;
    }

    const approval = pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|deny)$/);
    if (approval) {
      if (method !== "POST") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      if (!mayChange()) return true;
      const id = decodeURIComponent(approval[1]!);
      const body = await bodyObject(req);
      const result =
        approval[2] === "approve"
          ? await opts.inbox.resolve(opts.uid, id, {
              approve: true,
              scope: body.scope,
              digest: body.digest,
            })
          : await opts.inbox.resolve(opts.uid, id, { approve: false, reason: body.reason });
      sendResolve(res, result);
      return true;
    }
    if (isApprovals) {
      json(res, 404, { error: "approval_route_not_found" });
      return true;
    }

    if (pathname === "/api/warden/rules") {
      if (method === "GET") {
        const { rules, corrupt } = await loadRules(opts.home);
        json(res, 200, {
          rules,
          corrupt,
          categories: ACTION_CATEGORIES,
          behaviors: RULE_BEHAVIORS,
          locked: LOCKED_CATEGORIES,
        });
        return true;
      }
      if (method === "PUT") {
        if (!mayChange()) return true;
        const body = await bodyObject(req);
        const rules = await saveRules(body.rules ?? body, opts.home);
        await appendAudit(
          { at: new Date().toISOString(), kind: "rules_updated", uid: opts.uid },
          opts.home,
        ).catch(() => undefined);
        json(res, 200, { rules });
        return true;
      }
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }

    if (pathname === "/api/warden/grants") {
      if (method !== "GET") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      const { grants, corrupt } = await loadGrants(opts.home);
      json(res, 200, { grants, corrupt, scopes: GRANT_SCOPES });
      return true;
    }

    const grant = pathname.match(/^\/api\/warden\/grants\/([^/]+)$/);
    if (grant) {
      if (method !== "DELETE") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      if (!mayChange()) return true;
      const revoked = await revokeGrant(decodeURIComponent(grant[1]!), opts.home);
      if (!revoked) {
        json(res, 404, { error: "grant_not_found" });
        return true;
      }
      await appendAudit(
        {
          at: new Date().toISOString(),
          kind: "grant_revoked",
          uid: opts.uid,
          grantId: revoked.id,
          tool: revoked.tool,
          category: revoked.category,
          scope: revoked.scope,
        },
        opts.home,
      ).catch(() => undefined);
      json(res, 200, { ok: true, id: revoked.id });
      return true;
    }

    if (pathname === "/api/warden/audit") {
      if (method !== "GET") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      const raw = Number(parsedUrl.searchParams.get("limit") ?? "100");
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.floor(raw), 500)) : 100;
      json(res, 200, { entries: await readAudit({ home: opts.home, limit }) });
      return true;
    }

    json(res, 404, { error: "warden_route_not_found" });
    return true;
  } catch (err) {
    if (err instanceof BadRequest) {
      json(res, err.status, { error: err.code });
      return true;
    }
    if (err instanceof RulesValidationError) {
      json(res, 400, { error: "invalid_rules", message: err.message });
      return true;
    }
    json(res, 500, { error: "warden_request_failed" });
    return true;
  }
}

// ── server wiring ────────────────────────────────────────────────────────

export interface WebWardenTurn {
  approval: ApprovalCallback;
  observe(event: AgentEvent): void;
}

export interface WebWardenTurnOptions {
  uid: string | null;
  sandboxMode: SandboxMode | undefined;
  workspaceRoot: string;
  tools: ToolDefinition[];
  signal?: AbortSignal;
  /** Conversation id: taint and known URLs belong to the conversation. */
  conversationId?: string;
  /**
   * Is the caller someone who could answer an approval — the loopback owner or
   * a signed-in account? Anyone else who passed the auth gate (a LAN device
   * token, a shared web token) is a remote origin and gets the strictest
   * column: no owner defaults for a caller who cannot approve.
   */
  owner: boolean;
  /** What the user wrote this turn: URLs in it are destinations the user chose. */
  userText?: string;
  /** The turn carries attachments — content the user did not type. */
  hasAttachments?: boolean;
  /** The conversation already has turns (decides the corrupt-taint-file case). */
  hasHistory?: boolean;
  origin?: Origin;
}

export interface WebWarden {
  inbox: WardenInbox;
  /** True when the runtime policy selected approval mode "warden". */
  enabled: boolean;
  /**
   * The Warden session for one chat turn, or undefined when the mode is not
   * "warden" (the caller then keeps its legacy approval callback). Call it
   * inside the request's home scope.
   */
  turn(opts: WebWardenTurnOptions): Promise<WebWardenTurn | undefined>;
  /**
   * Record a conversation as tainted because outside text is about to be put
   * into it — a task card quoting what a tainted run wrote, or a watcher hit
   * (#422 review N3). Durable (tainted.json) and seen by the next turn in this
   * process at once. Throws when it cannot be recorded, so the caller does not
   * store the text. Recorded whether or not Warden mode is on: switching it on
   * later must not forget what the conversation already holds.
   */
  markTainted(conversationId: string, uid: string | null): Promise<void>;
}

const MAX_CONVERSATIONS_TRACKED = 500;

/** Build the process's inbox and the per-turn session factory for the web server. */
export function createWebWarden(
  policy: Pick<RuntimePolicy, "approval" | "surface" | "sandboxMode">,
  emit: WardenEmit,
  opts: { approvalTimeoutMs?: number } = {},
): WebWarden {
  const envTimeout = Number(process.env.LISA_WARDEN_APPROVAL_TIMEOUT_MS);
  const timeoutMs =
    opts.approvalTimeoutMs ??
    (Number.isFinite(envTimeout) && envTimeout >= 1000 ? envTimeout : undefined);
  const inbox = new WardenInbox({ emit, defaultTimeoutMs: timeoutMs });
  const enabled = policy.approval === "warden";
  // URLs seen per conversation (in memory; after a restart nothing is "known",
  // which only makes a tainted fetch ask). Insertion-ordered LRU.
  const urlsByConversation = new Map<string, KnownUrls>();
  const urlsFor = (key: string): KnownUrls => {
    let urls = urlsByConversation.get(key);
    if (urls) urlsByConversation.delete(key);
    else urls = new KnownUrls();
    urlsByConversation.set(key, urls);
    if (urlsByConversation.size > MAX_CONVERSATIONS_TRACKED) {
      const oldest = urlsByConversation.keys().next().value;
      if (oldest !== undefined) urlsByConversation.delete(oldest);
    }
    return urls;
  };
  // Conversations tainted in THIS process, so the next turn sees it even if
  // the write to tainted.json has not landed yet. The file is the durable copy.
  const taintedNow = new Set<string>();
  const rememberTaint = (key: string, conversationId: string, home: string): Promise<void> => {
    taintedNow.add(key);
    if (taintedNow.size > MAX_CONVERSATIONS_TRACKED * 10) {
      const oldest = taintedNow.values().next().value;
      if (oldest !== undefined) taintedNow.delete(oldest);
    }
    return markConversationTainted(conversationId, home).catch(() => undefined);
  };
  return {
    inbox,
    enabled,
    async markTainted(conversationId, uid) {
      const key = `${uid ?? ""}\u0000${conversationId}`;
      taintedNow.add(key);
      await markConversationTainted(conversationId, lisaHome());
    },
    async turn(turn) {
      if (!enabled) return undefined;
      const home = lisaHome();
      const conversationId = turn.conversationId;
      const key = `${turn.uid ?? ""}\u0000${conversationId ?? ""}`;
      // Taint belongs to the conversation and survives a restart: the fetched
      // page is still in the history. Attachments are untrusted content too.
      const carried =
        conversationId !== undefined &&
        (taintedNow.has(key) ||
          (await isConversationTainted(conversationId, {
            home,
            hasHistory: turn.hasHistory === true,
          })));
      const session = createWardenSession({
        surface: policy.surface,
        uid: turn.uid,
        origin:
          turn.origin ??
          (turn.owner
            ? { kind: "chat", id: conversationId }
            : { kind: "channel", id: "remote-device" }),
        sandboxMode: turn.sandboxMode ?? policy.sandboxMode,
        workspaceRoot: turn.workspaceRoot,
        inbox,
        tools: turn.tools,
        signal: turn.signal,
        home,
        initialTaint: carried || turn.hasAttachments === true,
        knownUrls: conversationId !== undefined ? urlsFor(key) : undefined,
        userText: turn.userText,
        onTaint: () => {
          if (conversationId !== undefined) void rememberTaint(key, conversationId, home);
        },
      });
      // A turn that starts tainted because of an attachment taints the
      // conversation for its later turns as well.
      if (session.tainted && !carried && conversationId !== undefined) {
        await rememberTaint(key, conversationId, home);
      }
      return { approval: session.approval, observe: (event) => session.observe(event) };
    },
  };
}
