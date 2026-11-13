import type http from "node:http";
import type { ConnectorService } from "../connectors/service.js";
import { CONNECTOR_CATALOG, type ConnectorProvider } from "../connectors/catalog.js";
import { ConnectorError } from "../connectors/types.js";
import { crossSiteProblem } from "./warden-api.js";
import { BodyTooLargeError, readCappedText } from "./http-body.js";

export async function handleConnectorApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  services: Map<ConnectorProvider, ConnectorService>,
  localOwner: boolean,
): Promise<boolean> {
  const url = new URL(rawUrl, "http://localhost");
  const match =
    /^\/api\/connectors\/([a-z][a-z0-9-]{0,48})(?:\/requests(?:\/([a-zA-Z0-9_-]{1,100})\/(authorize|resources|confirm|cancel|retry))?|\/(disconnect))$/.exec(
      url.pathname,
    );
  if (
    url.pathname !== "/api/connectors" &&
    (!match || match[1] === "github" || !CONNECTOR_CATALOG.some((c) => c.id === match[1]))
  )
    return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const problem = crossSiteProblem(req, true, null);
  if (!localOwner || services.size === 0 || problem) {
    json(403, { error: problem ?? "local_owner_required" });
    return true;
  }
  try {
    if (req.method === "GET" && url.pathname === "/api/connectors") {
      const session = url.searchParams.get("sessionId");
      if (session !== null && !/^[a-zA-Z0-9_-]{1,100}$/.test(session))
        throw new ConnectorError("invalid_session");
      const requests = [];
      const unavailableProviders = [];
      if (session !== null) {
        // One corrupt provider store must not hide the other providers' cards.
        const groups = await Promise.all(
          Array.from(services, async ([provider, service]) => {
            try {
              return { provider, requests: await service.list(session) };
            } catch {
              return { provider, requests: null };
            }
          }),
        );
        for (const group of groups) {
          if (group.requests === null) unavailableProviders.push(group.provider);
          else
            for (const request of group.requests)
              requests.push({ provider: group.provider, request });
        }
      }
      json(200, {
        // Unavailable sources (no OAuth client, or no EventKit reader in this build) stay
        // listed so a client can explain why they cannot be connected here.
        connectors: CONNECTOR_CATALOG.map((c) => ({
          ...c,
          available: c.id === "github" || services.has(c.id),
        })),
        ...(session === null ? {} : { requests, unavailableProviders }),
      });
      return true;
    }
    const service = services.get(match?.[1] as ConnectorProvider);
    if (!match || !service) {
      json(404, { error: "not_found" });
      return true;
    }
    const id = match[2] ?? "",
      action = match[3] ?? match[4];
    if (req.method === "GET" && !action) {
      json(200, { requests: await service.list(url.searchParams.get("sessionId") ?? "") });
      return true;
    }
    if (req.method === "GET" && action === "resources") {
      json(200, {
        resources: await service.resources(
          id,
          Number(url.searchParams.get("page") ?? 1),
          AbortSignal.timeout(90_000),
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
    const data: unknown = JSON.parse(await readCappedText(req, 16_384));
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new ConnectorError("invalid_body");
    const body = data as Record<string, unknown>;
    if (action === "authorize") await service.authorize(id, String(body.mode ?? "login"));
    else if (action === "confirm")
      await service.confirm(id, body.resources, AbortSignal.timeout(90_000));
    else if (action === "cancel") await service.cancel(id);
    else if (action === "retry") await service.retry(id);
    else if (action === "disconnect") await service.disconnect();
    else {
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
          : error instanceof ConnectorError
            ? 409
            : 503,
      {
        error:
          error instanceof ConnectorError
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
