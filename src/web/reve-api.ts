/**
 * `/api/reve/*` — the auditable Dream log (W9, docs/DESIGN_REVE_DREAMS.md).
 *
 *   GET  /api/reve/dreams?limit=n            newest-first summaries
 *   GET  /api/reve/dreams/{id}               full record (diffs size-capped)
 *   POST /api/reve/dreams/{id}/revert        { parts: ["memory","kb","skills"], force? }
 *   POST /api/reve/dreams/{id}/reconsider    { note }
 *   GET  /api/reve/reconsider                the reconsider queue
 *   GET  /api/reve/metrics?days=n            coherence time series
 *
 * Tenancy: every read and write goes through lisaHome(), which the server has
 * already scoped to the signed-in account's subtree on the cloud edition, so a
 * caller can only ever reach its own `users/<uid>/reve/`. The host passes
 * `allowed: false` for a cloud caller WITHOUT an account (shared token), which
 * would otherwise land in the operator's global home.
 *
 * Sovereignty: revert accepts user parts only; "soul" is refused (400) — the
 * user's lever over Lisa's soul is reconsider, which never writes soul files.
 */
import type http from "node:http";
import { BodyTooLargeError, readCappedText } from "./http-body.js";
import { clampDays, metricsSeries } from "../reve/metrics.js";
import { ReconsiderError, listReconsiderRequests, requestReconsider } from "../reve/reconsider.js";
import { RevertConflictError, RevertInputError, revertDream } from "../reve/revert.js";
import {
  CorruptDreamError,
  DreamNotFoundError,
  listDreams,
  readDream,
  readDreamsSince,
} from "../reve/store.js";

export interface ReveApiOptions {
  /** False for a cloud caller that is not scoped to an account. */
  allowed: boolean;
  /** Recorded in the audit log for reverts (e.g. "uid:abc" or "local"). */
  actor?: string;
  now?: () => Date;
}

const REVE_BODY_LIMIT = 16 * 1024;

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

class BadBody extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function bodyObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  // CSRF guard (same rule as the server's readJsonBody): require JSON.
  const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!ctype.includes("application/json")) throw new BadBody(415, "unsupported_media_type");
  let raw: string;
  try {
    raw = await readCappedText(req, REVE_BODY_LIMIT);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new BadBody(413, "body_too_large");
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new BadBody(400, "invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadBody(400, "json_body_must_be_an_object");
  }
  return parsed as Record<string, unknown>;
}

export async function handleReveApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  opts: ReveApiOptions,
): Promise<boolean> {
  const url = new URL(rawUrl, "http://127.0.0.1");
  const pathname = url.pathname;
  if (pathname !== "/api/reve" && !pathname.startsWith("/api/reve/")) return false;
  if (!opts.allowed) {
    json(res, 403, { error: "account_required" });
    return true;
  }
  const method = req.method ?? "GET";
  const parts = pathname.split("/").slice(3); // after /api/reve
  try {
    if (parts[0] === "dreams" && parts.length === 1) {
      if (method !== "GET") return methodNotAllowed(res);
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const listing = await listDreams(
        Number.isFinite(limit) ? Math.min(100, Math.max(1, limit)) : 20,
      );
      const pending = (await listReconsiderRequests()).filter((r) => r.status === "pending").length;
      json(res, 200, {
        dreams: listing.dreams,
        corrupt: listing.corrupt,
        pendingReconsider: pending,
      });
      return true;
    }
    if (parts[0] === "dreams" && parts.length === 2) {
      if (method !== "GET") return methodNotAllowed(res);
      const id = parts[1]!;
      const dream = await readDream(id);
      json(res, 200, { dream, reconsider: await listReconsiderRequests(id) });
      return true;
    }
    if (parts[0] === "dreams" && parts.length === 3 && parts[2] === "revert") {
      if (method !== "POST") return methodNotAllowed(res);
      const body = await bodyObject(req);
      const result = await revertDream(parts[1]!, {
        parts: body.parts,
        force: body.force === true,
        actor: opts.actor,
      });
      json(res, 200, { ok: true, ...result });
      return true;
    }
    if (parts[0] === "dreams" && parts.length === 3 && parts[2] === "reconsider") {
      if (method !== "POST") return methodNotAllowed(res);
      const body = await bodyObject(req);
      const request = await requestReconsider(parts[1]!, body.note);
      json(res, 201, { ok: true, request });
      return true;
    }
    if (parts[0] === "reconsider" && parts.length === 1) {
      if (method !== "GET") return methodNotAllowed(res);
      json(res, 200, { requests: await listReconsiderRequests() });
      return true;
    }
    if (parts[0] === "metrics" && parts.length === 1) {
      if (method !== "GET") return methodNotAllowed(res);
      const days = clampDays(url.searchParams.get("days"), 30);
      const now = opts.now?.() ?? new Date();
      const records = await readDreamsSince(now.getTime() - days * 24 * 60 * 60_000);
      json(res, 200, metricsSeries(records, { days, now }));
      return true;
    }
    json(res, 404, { error: "reve_route_not_found" });
    return true;
  } catch (err) {
    if (err instanceof BadBody) json(res, err.status, { error: err.code });
    else if (err instanceof DreamNotFoundError) json(res, 404, { error: "dream_not_found" });
    else if (err instanceof CorruptDreamError) json(res, 422, { error: "dream_corrupt" });
    else if (err instanceof RevertInputError) {
      json(res, 400, { error: "invalid_parts", message: err.message });
    } else if (err instanceof RevertConflictError) {
      json(res, 409, { error: "revert_conflict", conflicts: err.conflicts });
    } else if (err instanceof ReconsiderError) {
      json(res, err.code === "no_soul_changes" ? 409 : 400, {
        error: err.code,
        message: err.message,
      });
    } else {
      json(res, 500, { error: "reve_request_failed" });
    }
    return true;
  }
}

function methodNotAllowed(res: http.ServerResponse): true {
  json(res, 405, { error: "method_not_allowed" });
  return true;
}
