import { createHash } from "node:crypto";

export const HOST_API = "/api/agent-host/v1";
export const VIEW_API = HOST_API + "/view";
export const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const HOST_ID = /^[0-9a-f]{32}$/;
export interface FleetGrant {
  workspaces: string[];
  control: boolean;
}
export interface FleetPeer extends FleetGrant {
  deviceId: string;
  hostId: string;
}
/** Bound to one secure Pocket pairing, so re-pairing cannot revive old task shares. */
export interface FleetViewer {
  deviceId: string;
  hostId: string;
  pairingId: string;
}
export function fleetViewRoute(method: string, path: string): boolean {
  if (method !== "GET" || !path.startsWith(VIEW_API + "/")) return false;
  const suffix = path.slice(VIEW_API.length);
  return (
    suffix === "/runs" ||
    /^\/runs\/[a-f0-9-]{36}\/events(?:\?after=\d{1,15}(?:&limit=\d{1,3})?)?$/.test(suffix)
  );
}
export class FleetError extends Error {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(code);
  }
}
export function requiredText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new FleetError(400, "invalid_text");
  return value;
}
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new FleetError(400, "invalid_id");
  return value;
}
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function fleetRoute(method: string, path: string): boolean {
  if (!path.startsWith(HOST_API + "/")) return false;
  const suffix = path.slice(HOST_API.length);
  if (method === "GET")
    return (
      ["/capabilities", "/runs"].includes(suffix) ||
      /^\/runs\/[a-f0-9-]{36}\/changes(?:\/\d{1,6}(?:\/\d{1,4})?)?$/.test(suffix) ||
      /^\/(?:runs|operations)\/[a-f0-9-]{36}$/.test(suffix) ||
      // The cursor has one canonical spelling, so the allow-list stays an exact match.
      /^\/runs\/[a-f0-9-]{36}\/events(?:\?after=\d{1,15}(?:&limit=\d{1,3})?)?$/.test(suffix)
    );
  return (
    method === "POST" &&
    (suffix === "/runs" ||
      /^\/runs\/[a-f0-9-]{36}\/(?:messages|decisions|cancel|handoff-preview|handoff)$/.test(suffix))
  );
}
