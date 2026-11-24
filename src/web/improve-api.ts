/**
 * HTTP API for Improve LISA M0/M1 (`/api/improve*`).
 *
 *   GET  /api/improve              list improvement records + active capabilities
 *   POST /api/improve              create a new improvement (+ optional improvement session)
 *   POST /api/improve/{id}/preview validate ChangeSet and compute digest
 *   POST /api/improve/{id}/apply   atomically apply a previewed ChangeSet (digest-bound + CAS)
 *   POST /api/improve/{id}/rollback roll back applied capability without touching sessions/memory
 *   POST /api/improve/{id}/export  produce de-privatized community export + guided Draft PR prep
 */
import type http from "node:http";
import {
  applyImprovement,
  createImprovement,
  exportContribution,
  getImprovement,
  listImprovements,
  previewImprovement,
  rollbackImprovement,
} from "../improve/store.js";
import type { ImprovementCapabilityKind } from "../improve/types.js";
import { homeScope } from "../paths.js";
import { SessionStore } from "../sessions/store.js";
import { BodyTooLargeError, readCappedText } from "./http-body.js";
import { crossSiteProblem } from "./warden-api.js";

const IMPROVE_BODY_LIMIT = 256 * 1024;
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{3,80}$/;

function parseFilesInput(raw: unknown): Array<{ path: string; content: string }> | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error("files_must_be_array"), { status: 400 });
  }
  const out: Array<{ path: string; content: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw Object.assign(new Error("invalid_file_entry"), { status: 400 });
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.path !== "string" || typeof rec.content !== "string") {
      throw Object.assign(new Error("invalid_file_entry"), { status: 400 });
    }
    out.push({ path: rec.path, content: rec.content });
  }
  return out;
}

export interface ImproveApiOptions {
  home: string;
  cwd: string;
  model: string;
  allowChange: boolean;
  loopbackTrust: boolean;
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJsonObj(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!ctype.startsWith("application/json")) {
    throw Object.assign(new Error("content_type_must_be_json"), { status: 415 });
  }
  const raw = await readCappedText(req, IMPROVE_BODY_LIMIT);
  const parsed = JSON.parse(raw || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("body_must_be_object"), { status: 400 });
  }
  return parsed as Record<string, unknown>;
}

export async function handleImproveApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  opts: ImproveApiOptions,
): Promise<boolean> {
  const pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
  if (pathname !== "/api/improve" && !pathname.startsWith("/api/improve/")) return false;
  const method = req.method ?? "GET";

  const mayMutate = (): boolean => {
    if (!opts.allowChange) {
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
    if (method === "GET") {
      const problem = crossSiteProblem(req, opts.loopbackTrust);
      if (problem) {
        json(res, 403, { error: problem });
        return true;
      }
    }

    if (pathname === "/api/improve") {
      if (method === "GET") {
        json(res, 200, await listImprovements(opts.home));
        return true;
      }
      if (method === "POST") {
        if (!mayMutate()) return true;
        const body = await readJsonObj(req);
        const title = typeof body.title === "string" ? body.title : "";
        const goal = typeof body.goal === "string" ? body.goal : "";
        const kind: ImprovementCapabilityKind =
          body.kind === "preference" || body.kind === "workflow" || body.kind === "skill"
            ? body.kind
            : "skill";
        const originSessionId =
          typeof body.originSessionId === "string" && body.originSessionId.trim()
            ? body.originSessionId.trim()
            : undefined;
        const files = parseFilesInput(body.files);
        const requiredCapabilities = Array.isArray(body.requiredCapabilities)
          ? body.requiredCapabilities.filter((c): c is string => typeof c === "string")
          : undefined;
        const session = await homeScope.run(opts.home, () =>
          SessionStore.create({
            origin: "owner",
            kind: "improvement",
            originSessionId,
            cwd: opts.cwd,
            model: opts.model,
          }),
        );
        const record = await createImprovement(
          {
            title,
            goal,
            kind,
            packageId: typeof body.packageId === "string" ? body.packageId : undefined,
            sessionId: session.id,
            originSessionId,
            files,
            requiredCapabilities,
          },
          opts.home,
        );
        json(res, 201, { record, sessionId: session.id });
        return true;
      }
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }

    const parts = pathname.split("/").slice(3); // after /api/improve/
    const [id, action, extra] = parts;
    if (!id || !SAFE_ID_RE.test(id) || extra !== undefined) {
      json(res, 404, { error: "not_found" });
      return true;
    }

    if (action === undefined) {
      if (method !== "GET") {
        json(res, 405, { error: "method_not_allowed" });
        return true;
      }
      const record = await getImprovement(id, opts.home);
      if (!record) json(res, 404, { error: "not_found" });
      else json(res, 200, { record });
      return true;
    }

    if (method !== "POST") {
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!mayMutate()) return true;

    if (action === "preview") {
      const body = await readJsonObj(req);
      const files = parseFilesInput(body.files);
      const requiredCapabilities = Array.isArray(body.requiredCapabilities)
        ? body.requiredCapabilities.filter((c): c is string => typeof c === "string")
        : undefined;
      const record = await previewImprovement(
        id,
        {
          files,
          requiredCapabilities,
          rebaseToCurrentProfile: body.rebaseToCurrentProfile === true,
        },
        opts.home,
      );
      json(res, 200, { record });
      return true;
    }

    if (action === "apply") {
      const body = await readJsonObj(req);
      const digest = typeof body.digest === "string" ? body.digest : "";
      const result = await applyImprovement(id, digest, opts.home);
      if (!result.ok) {
        const status =
          result.error === "not_found" ? 404 : result.error === "not_preview_ready" ? 400 : 409;
        json(res, status, { error: result.error, message: result.message });
        return true;
      }
      json(res, 200, {
        ok: true,
        record: result.record,
        version: result.version,
        alreadyActive: result.alreadyActive,
      });
      return true;
    }

    if (action === "rollback") {
      const record = await rollbackImprovement(id, opts.home);
      json(res, 200, { ok: true, record });
      return true;
    }

    if (action === "export") {
      const out = await exportContribution(id, opts.home);
      json(res, 200, { ok: true, record: out.record, contribution: out.contribution });
      return true;
    }

    json(res, 404, { error: "not_found" });
    return true;
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: "body_too_large" });
      return true;
    }
    const status = (err as { status?: number }).status;
    if (status === 415 || status === 400) {
      json(res, status, { error: (err as Error).message });
      return true;
    }
    if (err instanceof SyntaxError) {
      json(res, 400, { error: "invalid_json" });
      return true;
    }
    json(res, 400, { error: "improve_request_failed", message: (err as Error).message });
    return true;
  }
}
