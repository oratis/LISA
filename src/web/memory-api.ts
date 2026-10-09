/**
 * Memory-sovereignty HTTP routes (W8): view / edit / delete memory entries,
 * cross-layer forget, and export of the caller's Lisa.
 *
 *   GET    /api/memory/entries          structured MEMORY.md + USER.md
 *   POST   /api/memory/entries          { store, text } → append
 *   PUT    /api/memory/entries/{id}     { text }        → replace
 *   DELETE /api/memory/entries/{id}
 *   POST   /api/memory/forget           { query, dryRun? }
 *   GET    /api/export[?sessions=1]     application/gzip download
 *
 * Trust (server-side, never client-flagged):
 *  - cloud: an ACCOUNT session is required for every route, and everything
 *    runs inside that account's own home (homeForUid(uid)) — a shared web
 *    token or device token never reaches another tenant's data, nor the
 *    operator's global home;
 *  - Mac: reads follow the server's normal auth; writes, forget and export
 *    need the loopback owner (with a loopback Host header — DNS rebinding)
 *    or an account session. A paired device token is read-only here.
 *  - State-changing routes and export refuse cross-site requests.
 *
 * Import is CLI-only for now (`lisa import`): an archive can be far larger
 * than any sane request-body limit, and replacing a soul over HTTP needs a
 * staged upload design of its own.
 */
import type http from "node:http";
import { homeForUid, homeScope, lisaHome } from "../paths.js";
import {
  appendMemoryEntry,
  deleteMemoryEntry,
  isMemoryStore,
  listMemoryEntries,
  MemoryEditError,
  replaceMemoryEntry,
  type MemoryEditErrorCode,
} from "../memory/entries.js";
import { forget, ForgetError } from "../sovereignty/forget.js";
import { exportFileName, writeExport } from "../sovereignty/export.js";
import { BodyTooLargeError, readCappedText } from "./http-body.js";
import { crossSiteProblem } from "./warden-api.js";
import { logError } from "../log.js";

export interface MemoryApiOptions {
  cloud: boolean;
  /** uid of the signed-in account (session-authenticated), else null. */
  accountUid: string | null;
  /** The TCP peer is loopback. */
  loopback: boolean;
}

const BODY_LIMIT = 64 * 1024;

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function route(url: string): { path: string; query: URLSearchParams } {
  const u = new URL(url, "http://localhost");
  return { path: u.pathname, query: u.searchParams };
}

/** True for the URLs this module owns (so the caller can skip it cheaply). */
export function isMemoryApiRoute(url: string): boolean {
  const { path } = route(url);
  return (
    path === "/api/memory/entries" ||
    path.startsWith("/api/memory/entries/") ||
    path === "/api/memory/forget" ||
    path === "/api/export"
  );
}

async function readJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
  const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!ctype.includes("application/json")) {
    json(res, 415, { error: "unsupported_media_type" });
    return null;
  }
  let text: string;
  try {
    text = await readCappedText(req, BODY_LIMIT);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      res.writeHead(413, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "payload_too_large", limitBytes: BODY_LIMIT }));
      return null;
    }
    json(res, 400, { error: "invalid_body" });
    return null;
  }
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    json(res, 400, { error: "invalid_json" });
    return null;
  }
}

const EDIT_STATUS: Record<MemoryEditErrorCode, number> = {
  invalid_entry: 400,
  invalid_store: 400,
  not_found: 404,
  memory_full: 413,
  memory_corrupt: 409,
};

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof MemoryEditError) {
    json(res, EDIT_STATUS[e.code], { error: e.code, message: e.message });
    return;
  }
  if (e instanceof ForgetError) {
    json(res, 400, { error: e.code, message: e.message });
    return;
  }
  if (e instanceof Error && /timed out acquiring lock/.test(e.message)) {
    json(res, 503, { error: "memory_busy" });
    return;
  }
  logError(`[memory-api] ${(e as Error)?.name ?? "error"}`);
  json(res, 500, { error: "internal_error" });
}

/**
 * Handle a memory-sovereignty route. Returns false when the URL isn't one of
 * ours (the caller continues routing).
 */
export async function handleMemoryApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  opts: MemoryApiOptions,
): Promise<boolean> {
  if (!isMemoryApiRoute(url)) return false;
  const method = req.method ?? "GET";
  const { path, query } = route(url);

  // Cloud: only a signed-in account, and only inside its own home.
  if (opts.cloud && !opts.accountUid) {
    json(res, 403, { error: "account_session_required" });
    return true;
  }
  const home = opts.cloud ? homeForUid(opts.accountUid!) : lisaHome();
  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    opts.cloud ? homeScope.run(home, fn) : fn();

  const isRead = method === "GET" && path === "/api/memory/entries";
  if (!isRead) {
    const loopbackOwner = !opts.cloud && opts.loopback;
    if (!loopbackOwner && !opts.accountUid) {
      json(res, 403, { error: "owner_required" });
      return true;
    }
    const problem = crossSiteProblem(req, loopbackOwner && !opts.accountUid);
    if (problem) {
      json(res, 403, { error: problem });
      return true;
    }
  }

  try {
    if (path === "/api/memory/entries") {
      if (method === "GET") {
        const stores = await run(() => listMemoryEntries());
        json(res, 200, { stores });
        return true;
      }
      if (method === "POST") {
        const body = await readJson(req, res);
        if (!body) return true;
        if (!isMemoryStore(body.store)) {
          json(res, 400, { error: "invalid_store" });
          return true;
        }
        const store = body.store;
        const entry = await run(() => appendMemoryEntry(store, body.text));
        json(res, 201, { entry });
        return true;
      }
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }

    if (path.startsWith("/api/memory/entries/")) {
      // Ids are [mu]_<hex>: nothing to percent-decode, and a malformed escape
      // must be a 404 rather than a URIError.
      const id = path.slice("/api/memory/entries/".length);
      if (!/^[mu]_[0-9a-f]{16}$/.test(id)) {
        json(res, 404, { error: "not_found" });
        return true;
      }
      if (method === "PUT") {
        const body = await readJson(req, res);
        if (!body) return true;
        const entry = await run(() => replaceMemoryEntry(id, body.text));
        json(res, 200, { entry });
        return true;
      }
      if (method === "DELETE") {
        await run(() => deleteMemoryEntry(id));
        json(res, 200, { ok: true, id });
        return true;
      }
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }

    if (path === "/api/memory/forget") {
      if (method !== "POST") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      const body = await readJson(req, res);
      if (!body) return true;
      const report = await run(() =>
        forget(body.query as string, { dryRun: body.dryRun === true }),
      );
      json(res, 200, { report });
      return true;
    }

    if (path === "/api/export") {
      if (method !== "GET") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      const includeSessions = query.get("sessions") === "1" || query.get("sessions") === "true";
      res.statusCode = 200;
      res.setHeader("content-type", "application/gzip");
      res.setHeader("content-disposition", `attachment; filename="${exportFileName()}"`);
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      try {
        await run(() => writeExport({ home, includeSessions }, res));
      } catch (e) {
        if (!res.headersSent) {
          res.removeHeader("content-disposition");
          sendError(res, e);
        } else {
          // Mid-stream failure: cut the connection so the client sees a
          // truncated download (which import rejects), never a "complete" one.
          logError(`[memory-api] export aborted: ${(e as Error)?.name ?? "error"}`);
          res.destroy();
        }
      }
      return true;
    }
  } catch (e) {
    sendError(res, e);
    return true;
  }
  json(res, 404, { error: "not_found" });
  return true;
}
