import type http from "node:http";
import type { AgentSession } from "../integrations/types.js";
import type { SessionInfo } from "../sessions/list.js";
import {
  LISA_API_VERSION,
  LISA_API_VERSION_HEADER,
} from "./api-contract.generated.js";

export { LISA_API_VERSION, LISA_API_VERSION_HEADER };

/** REST and SSE surfaces consumed outside the server-rendered web application. */
export function isVersionedApiSurface(rawUrl: string): boolean {
  const pathname = rawUrl.split("?", 1)[0] ?? rawUrl;
  return (
    pathname === "/chat" ||
    pathname === "/events" ||
    pathname === "/api" ||
    pathname.startsWith("/api/")
  );
}

/**
 * Advertise the response protocol before any route writes its status/headers.
 * Existing response bodies remain byte-compatible in v1.
 */
export function applyApiVersionHeader(
  rawUrl: string,
  response: http.ServerResponse,
): void {
  if (!response.headersSent && isVersionedApiSurface(rawUrl)) {
    response.setHeader(LISA_API_VERSION_HEADER, LISA_API_VERSION);
  }
}

export type ApiAgentSession = Omit<AgentSession, "lastMtime" | "jsonlPath"> & {
  lastMtime: string;
  resumable?: boolean;
};

export interface AgentSessionsResponse {
  sessions: ApiAgentSession[];
}

/**
 * Canonical REST serialization for the shared AgentSession model. Keeping this
 * pure lets CI validate the actual server DTO against the OpenAPI schema.
 */
export function agentSessionsResponse(
  sessions: readonly AgentSession[],
  liveClaudeSessions: ReadonlySet<string>,
): AgentSessionsResponse {
  return {
    sessions: sessions.map((session) => {
      // jsonlPath is a server-internal file handle (step-timeline endpoint);
      // it must never reach the wire (it leaks the local home directory).
      const { jsonlPath: _jsonlPath, ...rest } = session;
      return {
        ...rest,
        lastMtime: new Date(session.lastMtime).toISOString(),
        ...(session.agent === "claude-code" &&
        !session.controllable &&
        !liveClaudeSessions.has(session.sessionId)
          ? { resumable: true }
          : {}),
      };
    }),
  };
}

/** Wire shape of a Lisa chat session — the on-disk `path` never serializes. */
export type ApiLisaSession = Omit<SessionInfo, "path">;

export interface LisaSessionsResponse {
  sessions: ApiLisaSession[];
}

/**
 * Canonical REST serialization for GET /api/sessions (contract:
 * LisaSessionsResponse). Strips the absolute on-disk file path — it leaks
 * the local home directory and no client needs it.
 */
export function lisaSessionsResponse(
  sessions: readonly SessionInfo[],
): LisaSessionsResponse {
  return {
    sessions: sessions.map((s) => {
      const { path: _path, ...rest } = s;
      return rest;
    }),
  };
}
