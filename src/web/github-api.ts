import type http from "node:http";
import { GitHubConnector } from "../connectors/github.js";
import { GitHubError } from "../connectors/github-driver.js";
import { crossSiteProblem } from "./warden-api.js";
import { BodyTooLargeError, readCappedText } from "./http-body.js";

export async function handleGitHubApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  service: GitHubConnector | undefined,
  localOwner: boolean,
): Promise<boolean> {
  if (!rawUrl.startsWith("/api/connectors/github")) return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  // Even metadata is private. Cloud, LAN/device tokens and DNS rebinding are denied.
  const problem = crossSiteProblem(req, true, null);
  if (!localOwner || !service || problem) {
    json(403, { error: problem ?? "local_owner_required" });
    return true;
  }
  const url = new URL(rawUrl, "http://localhost");
  const signal = AbortSignal.timeout(90_000);
  try {
    if (req.method === "GET" && url.pathname === "/api/connectors/github/requests") {
      json(200, { requests: await service.list(url.searchParams.get("sessionId") ?? "") });
      return true;
    }
    const match =
      /^\/api\/connectors\/github\/requests\/([a-zA-Z0-9_-]{1,100})\/(authorize|repositories|confirm|cancel|retry)$/.exec(
        url.pathname,
      );
    if (req.method === "GET" && match?.[2] === "repositories") {
      json(200, {
        repositories: await service.repositories(
          match[1]!,
          Number(url.searchParams.get("page") ?? 1),
          signal,
        ),
      });
      return true;
    }
    if (req.method !== "POST") {
      json(404, { error: "not_found" });
      return true;
    }
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      json(415, { error: "content_type_must_be_json" });
      return true;
    }
    const body: unknown = JSON.parse(await readCappedText(req, 16_384));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new GitHubError("invalid_body");
    const data = body as Record<string, unknown>;
    if (url.pathname === "/api/connectors/github/disconnect") await service.disconnect();
    else if (match) {
      const id = match[1]!;
      if (match[2] === "authorize") await service.authorize(id, data.mode as "existing" | "login");
      else if (match[2] === "confirm") await service.confirm(id, data.repositories, signal);
      else if (match[2] === "cancel") await service.cancel(id);
      else if (match[2] === "retry") await service.retry(id);
      else {
        json(404, { error: "not_found" });
        return true;
      }
    } else {
      json(404, { error: "not_found" });
      return true;
    }
    json(200, { ok: true });
  } catch (error) {
    json(
      error instanceof BodyTooLargeError
        ? 413
        : error instanceof SyntaxError
          ? 400
          : error instanceof GitHubError
            ? 409
            : 503,
      {
        error:
          error instanceof GitHubError
            ? error.code
            : error instanceof SyntaxError
              ? "invalid_json"
              : error instanceof BodyTooLargeError
                ? "body_too_large"
                : "connector_unavailable",
      },
    );
  }
  return true;
}
