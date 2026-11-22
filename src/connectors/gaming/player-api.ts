import {
  pinnedTransport,
  readResponseTextCapped,
  resolvePublicAddresses,
  withDeadline,
} from "../../tools/web_fetch.js";
import { redactKnownSecrets } from "../../warden/secrets.js";
import { ConnectorError } from "../types.js";
import type { Resource } from "../workspace/data.js";
import { fail, row, type Http } from "../workspace/http.js";

const playerOrigins = new Set([
  "https://api.itch.io",
  "https://steamcommunity.com",
  "https://api.steampowered.com",
]);
const retryAt = new Map<string, number>();

/** Only provider-owned endpoints are used. Neither credentials nor a response body enter an error. */
export const playerHttp: Http = async (url, init, signal, text) => {
  if (!playerOrigins.has(url.origin) || url.username || url.password || url.hash)
    fail("workspace_invalid_endpoint");
  if ((retryAt.get(url.origin) ?? 0) > Date.now()) fail("workspace_rate_limited");
  try {
    return await withDeadline(signal, 20_000, async (deadline) => {
      const [address] = await resolvePublicAddresses(url.hostname);
      deadline?.throwIfAborted();
      const response = await pinnedTransport(
        url.href,
        { ...init, redirect: "manual", signal: deadline },
        address!,
      );
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) {
          const retry = response.headers.get("Retry-After");
          const until =
            retry && /^\d+$/.test(retry)
              ? Date.now() + Number(retry) * 1000
              : Date.parse(retry ?? "");
          retryAt.set(
            url.origin,
            Math.max(
              retryAt.get(url.origin) ?? 0,
              Number.isFinite(until) ? until : Date.now() + 60_000,
            ),
          );
          fail("workspace_rate_limited");
        }
        if (response.status === 401)
          fail(
            url.origin === "https://api.itch.io"
              ? "workspace_reauthorize"
              : "workspace_inaccessible",
          );
        if (
          response.status === 400 &&
          url.pathname === "/ISteamUserStats/GetPlayerAchievements/v1/"
        )
          fail("game_library_unavailable");
        if ([403, 404].includes(response.status)) fail("workspace_inaccessible");
        fail("workspace_request_failed");
      }
      const body = await readResponseTextCapped(response, text ? 8192 : 4_000_000);
      if (body.truncated) fail("game_library_incomplete");
      return text ? body.text : JSON.parse(body.text);
    });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    fail(signal.aborted ? "request_cancelled" : "workspace_request_failed");
  }
};

export function storedPlayerGrant(raw: string) {
  try {
    return row(JSON.parse(raw));
  } catch {
    fail("workspace_reauthorize");
  }
}

export function pageEnd(page: number) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) fail("invalid_page");
  return page * 30;
}

export function displayName(value: unknown, secret?: string): string {
  if (typeof value !== "string" || !value.trim()) fail();
  const name = secret ? redactKnownSecrets(value, [secret]) : value;
  return name
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 200);
}

export function isGameResource(
  value: unknown,
  validId: (id: unknown) => boolean,
): value is Resource {
  const item = value as Resource | null;
  return (
    !!item &&
    validId(item.id) &&
    typeof item.name === "string" &&
    !!item.name.trim() &&
    item.name.length <= 200
  );
}

export function selectedGames(input: unknown, resources: Resource[], extraOperation?: string) {
  const args = row(input);
  const keys = Object.keys(args);
  if (args.operation === "list" && keys.length === 1) return resources.map((r) => r.id);
  if (
    (args.operation !== "read" && (!extraOperation || args.operation !== extraOperation)) ||
    keys.some((key) => key !== "operation" && key !== "resourceId")
  )
    fail("read_operation_required");
  if (typeof args.resourceId !== "string" || !resources.some((r) => r.id === args.resourceId))
    fail("resource_not_granted");
  return [args.resourceId];
}

export function playerTool(name: string, description: string, achievements = false) {
  return {
    name,
    description,
    inputSchema: {
      type: "object" as const,
      properties: {
        operation: {
          type: "string",
          enum: achievements ? ["list", "read", "achievements"] : ["list", "read"],
        },
        resourceId: {
          type: "string",
          description: "A confirmed game ID, required except for list.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  };
}
