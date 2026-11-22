import type { PublicGames } from "../connectors/gaming/public-games.js";
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
  github?: Pick<ConnectorService, "summary">,
  publicGames?: Pick<PublicGames, "configured" | "query">,
  gameModel?: string,
): Promise<boolean> {
  const url = new URL(rawUrl, "http://localhost");
  const match =
    /^\/api\/connectors\/([a-z][a-z0-9-]{0,48})(?:\/requests(?:\/([a-zA-Z0-9_-]{1,100})\/(authorize|resources|confirm|cancel|retry))?|\/(disconnect))$/.exec(
      url.pathname,
    );
  if (
    url.pathname !== "/api/connectors" &&
    url.pathname !== "/api/games/public" &&
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
    if (url.pathname === "/api/games/public") {
      if (!publicGames) {
        json(403, { error: "local_owner_required" });
      } else if (req.method === "GET") {
        json(200, publicGames.configured());
      } else if (req.method !== "POST") {
        json(405, { error: "method_not_allowed" });
      } else if (
        req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        json(415, { error: "content_type_must_be_json" });
      } else {
        const input: unknown = JSON.parse(await readCappedText(req, 4096));
        const abort = new AbortController();
        const cancel = () => abort.abort();
        res.once("close", cancel);
        try {
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]);
          json(200, await publicGames.query(input, signal));
        } finally {
          res.off("close", cancel);
        }
      }
      return true;
    }
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
      const connectors = await Promise.all(
        CONNECTOR_CATALOG.map(async (c) => {
          const service = c.id === "github" ? github : services.get(c.id);
          const available = !!service;
          try {
            return {
              ...c,
              available,
              connection: service
                ? await service.summary()
                : { status: "unavailable", resourceCount: 0 },
            };
          } catch {
            return {
              ...c,
              available,
              connection: {
                status: "error",
                resourceCount: 0,
                lastError: "connector_state_corrupt",
              },
            };
          }
        }),
      );
      json(200, {
        // Unavailable sources (no OAuth client, or no EventKit reader in this build) stay
        // listed so a client can explain why they cannot be connected here.
        connectors,
        ...(session && gameModel ? { gameModel } : {}),
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
    const importing = match[1] === "game-library" && action === "authorize";
    const data: unknown = JSON.parse(await readCappedText(req, importing ? 128 * 1024 : 16_384));
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new ConnectorError("invalid_body");
    const body = data as Record<string, unknown>;
    if (importing) {
      if (
        body.mode !== "import" ||
        !Array.isArray(body.games) ||
        !body.games.length ||
        body.games.length > 30
      )
        throw new ConnectorError("game_import_invalid");
      await service.authorize(id, "import", JSON.stringify(body.games));
    } else if (action === "authorize") await service.authorize(id, String(body.mode ?? "login"));
    else if (action === "confirm")
      await service.confirm(
        id,
        body.resources,
        AbortSignal.timeout(90_000),
        typeof body.recipient === "string" ? body.recipient : undefined,
      );
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
            ? url.pathname === "/api/games/public"
              ? (error.httpStatus ?? 409)
              : 409
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
