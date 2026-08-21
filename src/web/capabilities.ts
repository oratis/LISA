import type { Edition } from "../edition.js";
import type { ToolDefinition } from "../types.js";
import { cloudSafeSubset } from "../tools/registry.js";

export type CapabilityProfile = "local-owner" | "cloud-chat";

export function capabilityProfileForEdition(edition: Edition): CapabilityProfile {
  return edition === "cloud" ? "cloud-chat" : "local-owner";
}

export function toolsForCapabilityProfile(
  tools: ToolDefinition[],
  profile: CapabilityProfile,
): ToolDefinition[] {
  return profile === "cloud-chat" ? cloudSafeSubset(tools) : tools;
}

/**
 * Host-control routes that have meaning only when the caller owns the machine
 * running LISA. These are denied at the HTTP boundary in the hosted edition,
 * independently from client-side edition flags and tool filtering.
 */
const CLOUD_DENIED_ROUTE_PREFIXES = [
  "/api/agent/",
  "/api/agents/",
  "/api/advisor/",
  "/api/claude/",
  "/api/config/",
  // Consent state is stored per-machine, not per-tenant (src/consent/store.ts
  // resolves ~/.lisa/consent.json directly instead of going through the
  // per-user home scope in src/paths.ts). Leaving these routes open in the
  // hosted edition let any signed-in tenant read every tenant's grant list and
  // overwrite it — including a one-request /api/consent/revoke-all that
  // switches the mail digest off for the whole deployment.
  "/api/consent/",
  "/api/control/",
  "/api/devices/",
  "/api/dispatch/",
  "/api/mail/",
  "/api/pair/",
  "/api/plans/",
  "/api/screen-advisor/",
  "/api/sense/",
  "/api/vision/",
] as const;

const CLOUD_DENIED_EXACT_ROUTES = new Set([
  "/api/kb/ingest",
  "/api/plans",
]);

export function isCloudDeniedRoute(rawUrl: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return true;
  }
  if (CLOUD_DENIED_EXACT_ROUTES.has(pathname)) return true;
  return CLOUD_DENIED_ROUTE_PREFIXES.some((prefix) => {
    const root = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return pathname === root || pathname.startsWith(`${root}/`);
  });
}
