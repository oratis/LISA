import type { Edition } from "../edition.js";
import type { ToolDefinition } from "../types.js";
import { cloudSafeSubset } from "../tools/registry.js";

/**
 * WHO is acting, as a first-class value (T-13).
 *
 * Every privileged call site has to answer "on whose authority?", and until
 * now only the two chat surfaces did — everything unattended fell through to
 * `untrustedSurfaceMode()`, which answers a narrower question (how to confine
 * a shell) and answers nothing at all about tools. The cloud autonomy sweep is
 * what that cost: it ran desire reviews with `opts.tools`, the process's FULL
 * registry, because nobody at that call site had declared a profile.
 *
 *  - `local-owner`    — the human at the keyboard of the machine Lisa runs on.
 *  - `local-autonomy` — Lisa acting on her own on that machine (heartbeat,
 *                       idle, desire pursuit). Same tools as the owner (it IS
 *                       the owner's machine) but confined like an untrusted
 *                       surface, because the INPUT is untrusted: a fetched
 *                       page, an inbound message.
 *  - `cloud-chat`     — a signed-in hosted user.
 *  - `cloud-autonomy` — Lisa acting on her own inside a cloud tenant. Never
 *                       more than a cloud user could ask for by hand.
 *  - `remote-device`  — a paired phone or an inbound channel message: off-host
 *                       and not the owner's keyboard.
 */
export type CapabilityProfile =
  | "local-owner"
  | "local-autonomy"
  | "cloud-chat"
  | "cloud-autonomy"
  | "remote-device";

/**
 * Profiles that get the cloud-safe tool subset. Written as the allow-list's
 * complement on purpose: a NEW profile added to the union without a decision
 * here is a type error at `toolsForCapabilityProfile`, not a silent grant.
 */
const FULL_HOST_PROFILES: readonly CapabilityProfile[] = ["local-owner", "local-autonomy"];

export function capabilityProfileForEdition(edition: Edition): CapabilityProfile {
  return edition === "cloud" ? "cloud-chat" : "local-owner";
}

/** The profile for Lisa's own unattended work on this edition. */
export function autonomyProfileForEdition(edition: Edition): CapabilityProfile {
  return edition === "cloud" ? "cloud-autonomy" : "local-autonomy";
}

export function toolsForCapabilityProfile(
  tools: ToolDefinition[],
  profile: CapabilityProfile,
): ToolDefinition[] {
  return FULL_HOST_PROFILES.includes(profile) ? tools : cloudSafeSubset(tools);
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
