/**
 * Edition flag — Mac (local-first, full power) vs the hosted LISA Cloud edition.
 *
 * Set `LISA_EDITION=cloud` in the Cloud Run container. It drives:
 *  - which surfaces are advertised to the client (`/api/edition`) so Mac-only
 *    features (PTY/adopt, dispatch to local CLIs, Sense capture, agent control
 *    plane over your terminals) are hidden in cloud mode;
 *  - the auth model (later: cloud verifies a signed-in user instead of the
 *    loopback/LISA_WEB_TOKEN gate).
 *
 * Default is "mac" — absent/any other value ⇒ the existing local behavior is
 * unchanged. See docs/PLAN_CLOUD_v1.0.md.
 */
export type Edition = "mac" | "cloud";

export function edition(env: NodeJS.ProcessEnv = process.env): Edition {
  return env.LISA_EDITION === "cloud" ? "cloud" : "mac";
}

export function isCloud(env: NodeJS.ProcessEnv = process.env): boolean {
  return edition(env) === "cloud";
}

/** Mac-only capabilities the cloud edition hides/disables (advertised to the client). */
export const MAC_ONLY_CAPABILITIES = [
  "pty", // spawn/adopt real claude·codex CLIs under a PTY
  "dispatch-local", // dispatch_agent to local CLIs
  "sense", // screen / voice / clipboard capture
  "agent-control", // control plane over your own terminal sessions
] as const;

/** The capability/edition descriptor served at /api/edition. Pure. */
export function editionInfo(env: NodeJS.ProcessEnv = process.env): {
  edition: Edition;
  macOnlyDisabled: readonly string[];
} {
  const cloud = isCloud(env);
  return { edition: cloud ? "cloud" : "mac", macOnlyDisabled: cloud ? MAC_ONLY_CAPABILITIES : [] };
}
