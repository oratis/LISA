import type http from "node:http";
import type { ToolDefinition } from "../types.js";
import { readCappedText, CTRL_BODY_LIMIT } from "./http-body.js";
import {
  approveSocialDraft,
  cancelSocialDraft,
  createSocialDraft,
  getSocialDraft,
  listSocialDrafts,
  requestSocialDraftApproval,
  socialDraftDigest,
  updateSocialDraft,
} from "../sense/social/drafts.js";
import { discoverSocialConnectors } from "../sense/social/manifest.js";
import type {
  NewSocialDraft,
  SocialDraftPatch,
} from "../sense/social/types.js";
import {
  setSocialPublishingPaused,
  socialPublishingPaused,
} from "../sense/social/policy.js";

export interface SocialApiOptions {
  /** True only for loopback or an authenticated per-user cloud session. */
  allowApproval: boolean;
  /** Deterministic runner wired by the host; never a model-visible endpoint. */
  publishApproved?: (id: string, digest: string) => Promise<unknown>;
  connectorTools?: ToolDefinition[];
}

function json(
  res: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

async function bodyObject(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await readCappedText(req, CTRL_BODY_LIMIT);
  const parsed = JSON.parse(raw || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Handle authenticated `/api/sense/social/*` routes. Returns false when the
 * route is outside this domain. There is intentionally no publish endpoint:
 * a later deterministic runner consumes an approved snapshot directly.
 */
export async function handleSocialApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  opts: SocialApiOptions,
): Promise<boolean> {
  const pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
  if (!pathname.startsWith("/api/sense/social/")) return false;

  try {
    if (req.method === "GET" && pathname === "/api/sense/social/connectors") {
      const connectors = await discoverSocialConnectors();
      const accounts = opts.connectorTools
        ? await (
            await import("../sense/social/runner.js")
          ).listSocialConnectorAccounts(opts.connectorTools, connectors)
        : {};
      json(res, 200, {
        connectors: connectors.map((connector) => ({
          ...connector,
          accounts: connector.manifest
            ? accounts[connector.manifest.id] ?? []
            : [],
        })),
      });
      return true;
    }
    if (req.method === "GET" && pathname === "/api/sense/social/drafts") {
      const drafts = await listSocialDrafts();
      json(res, 200, {
        drafts: drafts.map((draft) => ({
          ...draft,
          approvalDigest:
            draft.state === "awaiting-approval"
              ? socialDraftDigest(draft)
              : undefined,
        })),
      });
      return true;
    }
    if (req.method === "GET" && pathname === "/api/sense/social/status") {
      json(res, 200, { paused: await socialPublishingPaused() });
      return true;
    }
    if (
      req.method === "POST" &&
      (pathname === "/api/sense/social/pause" ||
        pathname === "/api/sense/social/resume")
    ) {
      if (!opts.allowApproval) {
        json(res, 403, { error: "trusted_local_confirmation_required" });
        return true;
      }
      const paused = pathname.endsWith("/pause");
      await setSocialPublishingPaused(paused);
      json(res, 200, { paused });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/sense/social/drafts") {
      const payload = await bodyObject(req);
      const draft = await createSocialDraft(payload as unknown as NewSocialDraft);
      json(res, 201, { draft });
      return true;
    }

    const match = pathname.match(
      /^\/api\/sense\/social\/drafts\/([^/]+)(?:\/(request-approval|approve|cancel))?$/,
    );
    if (!match) {
      json(res, 404, { error: "social_route_not_found" });
      return true;
    }
    const id = decodeURIComponent(match[1]!);
    const action = match[2];

    if (req.method === "GET" && !action) {
      const draft = await getSocialDraft(id);
      if (!draft) json(res, 404, { error: "social_draft_not_found" });
      else {
        json(res, 200, {
          draft: {
            ...draft,
            approvalDigest:
              draft.state === "awaiting-approval"
                ? socialDraftDigest(draft)
                : undefined,
          },
        });
      }
      return true;
    }
    if (req.method === "PATCH" && !action) {
      const payload = await bodyObject(req);
      const expectedRevision = payload.expectedRevision;
      if (typeof expectedRevision !== "number") {
        json(res, 400, { error: "expectedRevision_required" });
        return true;
      }
      const patch = payload.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        json(res, 400, { error: "patch_required" });
        return true;
      }
      const draft = await updateSocialDraft(
        id,
        expectedRevision,
        patch as SocialDraftPatch,
      );
      json(res, 200, { draft });
      return true;
    }
    if (req.method === "POST" && action === "request-approval") {
      const payload = await bodyObject(req);
      if (typeof payload.expectedRevision !== "number") {
        json(res, 400, { error: "expectedRevision_required" });
        return true;
      }
      const result = await requestSocialDraftApproval(
        id,
        payload.expectedRevision,
      );
      json(res, 200, {
        draft: result.draft,
        approvalDigest: result.digest,
      });
      return true;
    }
    if (req.method === "POST" && action === "approve") {
      if (!opts.allowApproval) {
        json(res, 403, { error: "trusted_local_confirmation_required" });
        return true;
      }
      const payload = await bodyObject(req);
      if (typeof payload.digest !== "string") {
        json(res, 400, { error: "digest_required" });
        return true;
      }
      const approved = await approveSocialDraft(id, payload.digest);
      const draft = opts.publishApproved
        ? await opts.publishApproved(id, payload.digest)
        : approved;
      json(res, 200, {
        draft,
        publishingAvailable: Boolean(opts.publishApproved),
      });
      return true;
    }
    if (req.method === "POST" && action === "cancel") {
      const draft = await cancelSocialDraft(id);
      json(res, 200, { draft });
      return true;
    }

    json(res, 405, { error: "method_not_allowed" });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 400, { error: "social_request_failed", message });
    return true;
  }
}
