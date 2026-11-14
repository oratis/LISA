import type http from "node:http";
import type { AgentSession } from "../integrations/types.js";
import type { SessionInfo } from "../sessions/list.js";
import { LISA_API_VERSION, LISA_API_VERSION_HEADER } from "./api-contract.generated.js";
import { errorBody } from "./error-shape.js";

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
export function applyApiVersionHeader(rawUrl: string, response: http.ServerResponse): void {
  if (!response.headersSent && isVersionedApiSurface(rawUrl)) {
    response.setHeader(LISA_API_VERSION_HEADER, LISA_API_VERSION);
  }
}

export type ApiAgentSession = Omit<AgentSession, "lastMtime" | "jsonlPath"> & {
  lastMtime: string;
  /** Local owner only, never included in the shared event stream. */
  displayName?: string;
  resumable?: boolean;
};

export interface AgentSessionsResponse {
  sessions: ApiAgentSession[];
}

/**
 * Canonical wire serialization of ONE roster row — used by the REST roster
 * (`GET /api/agents/sessions`) and the live `agent_session_update` SSE event
 * alike, so a client that replaces a row with the event's copy keeps the same
 * fields (#490: the event used to carry `jsonlPath` and drop `resumable`).
 *
 * `isLiveClaudeSession` is only consulted for an observe-only claude row, so a
 * caller can pass a lazy check (it reads ~/.claude/sessions).
 */
export function apiAgentSession(
  session: AgentSession,
  isLiveClaudeSession: (sessionId: string) => boolean,
): ApiAgentSession {
  // jsonlPath is a server-internal file handle (step-timeline endpoint);
  // it must never reach the wire (it leaks the local home directory).
  const { jsonlPath: _jsonlPath, ...rest } = session;
  return {
    ...rest,
    lastMtime: new Date(session.lastMtime).toISOString(),
    ...(session.agent === "claude-code" &&
    !session.controllable &&
    !isLiveClaudeSession(session.sessionId)
      ? { resumable: true }
      : {}),
  };
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
    sessions: sessions.map((session) =>
      apiAgentSession(session, (id) => liveClaudeSessions.has(id)),
    ),
  };
}

/**
 * The JSON error body agent-control routes answer with (contract:
 * ErrorResponse): a stable machine `error` code a client can branch on, and a
 * `message` it can show as-is. Extra fields (e.g. legacy `ok: false`) are kept.
 */
export function writeApiError(
  res: http.ServerResponse,
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(errorBody(error, extra, message)));
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
export function lisaSessionsResponse(sessions: readonly SessionInfo[]): LisaSessionsResponse {
  return {
    sessions: sessions.map((s) => {
      const { path: _path, ...rest } = s;
      return rest;
    }),
  };
}
