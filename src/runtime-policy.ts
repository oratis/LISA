/**
 * Runtime policy — one object that says how this process behaves (T-7).
 *
 * Lisa runs on three surfaces out of a single composition root: the attended
 * CLI REPL, the local web server on loopback, and the multi-tenant cloud
 * server. Until now the differences between them were scattered as ad-hoc
 * `isCloud()` checks and per-option booleans threaded through
 * `startWebServer`, which is how the v0.24 review found the cloud edition
 * still running the local reflection heartbeat and the web chat path silently
 * ignoring `--approval` — the flag parsed, printed in the banner, and applied
 * to exactly one of the three surfaces.
 *
 * So: build the policy ONCE at startup from the parsed args and the
 * environment, hand it to the server, and let the server read it instead of
 * re-deriving the same decisions at each call site. A surface's behaviour is
 * then something you can print, diff and snapshot-test, rather than something
 * you reconstruct by grepping.
 *
 * This is a policy object, not a security boundary: capability enforcement
 * still happens server-side in `toolsForCapabilityProfile` and
 * `isCloudDeniedRoute` (INVARIANTS §权限与工具 2). The policy chooses which
 * profile applies; it never becomes the only thing standing between a cloud
 * user and a host tool.
 */
import { type ApprovalMode, type ApprovalConfig, isMutatingCall } from "./approval.js";
import type { ApprovalCallback } from "./agent.js";
import { edition } from "./edition.js";
import { resolveSandboxMode, type SandboxMode } from "./sandbox/mode.js";
import { capabilityProfileForEdition, type CapabilityProfile } from "./web/capabilities.js";

/** Which of the three composition surfaces this process is. */
export type RuntimeSurface = "cli" | "local-web" | "cloud";

/**
 * How reflection runs.
 *  - `off`       — never; no timer, and `/reflect` still refuses.
 *  - `manual`    — only when something asks (the `/reflect` route, a CLI
 *                  command). No background timer.
 *  - `scheduled` — the background heartbeat also runs.
 */
export type ReflectionMode = "off" | "manual" | "scheduled";

export interface RuntimePolicy {
  surface: RuntimeSurface;
  reflection: ReflectionMode;
  /** Anthropic context-compaction beta on the turn. */
  compaction: boolean;
  approval: ApprovalMode;
  thinking: boolean;
  capabilities: CapabilityProfile;
  sandboxMode: SandboxMode;
}

/** The slice of parsed CLI args the policy is built from. */
export interface RuntimePolicyArgs {
  subcommand?: string;
  serveWeb?: boolean;
  reflect: boolean;
  thinking: boolean;
  compaction: boolean;
  approval: ApprovalMode;
  /** Explicit --sandbox, if the surface has one. */
  sandbox?: SandboxMode;
}

function surfaceOf(args: RuntimePolicyArgs, env: NodeJS.ProcessEnv): RuntimeSurface {
  if (edition(env) === "cloud") return "cloud";
  return args.subcommand === "serve" && args.serveWeb ? "local-web" : "cli";
}

function reflectionFor(surface: RuntimeSurface, args: RuntimePolicyArgs): ReflectionMode {
  if (!args.reflect) return "off";
  // Cloud is deliberately NOT "scheduled". The heartbeat reflects the
  // process-level `globalChat`, which on a multi-tenant server belongs to no
  // signed-in user: it burns a model call that no account is admitted for or
  // billed (INVARIANTS §计费 4) and writes into the operator's soul rather
  // than anyone's. Cloud reflection is per-request, through /reflect.
  if (surface === "cloud") return "manual";
  // The CLI drives its own reflection from the REPL, not from a server timer.
  return surface === "local-web" ? "scheduled" : "manual";
}

/**
 * Build the policy for this process. `env` is a parameter (not read straight
 * from `process.env`) so tests can snapshot all three surfaces in one run.
 */
export function buildRuntimePolicy(
  args: RuntimePolicyArgs,
  env: NodeJS.ProcessEnv = process.env,
): RuntimePolicy {
  const surface = surfaceOf(args, env);
  const ed = edition(env);
  return {
    surface,
    reflection: reflectionFor(surface, args),
    compaction: args.compaction,
    approval: args.approval,
    thinking: args.thinking,
    capabilities: capabilityProfileForEdition(ed),
    sandboxMode: resolveSandboxMode(args.sandbox),
  };
}

/** One line for the startup banner / `/health`-adjacent debugging. */
export function describeRuntimePolicy(p: RuntimePolicy): string {
  return (
    `surface=${p.surface} reflection=${p.reflection} approval=${p.approval} ` +
    `thinking=${p.thinking ? "on" : "off"} compaction=${p.compaction ? "on" : "off"} ` +
    `capabilities=${p.capabilities} sandbox=${p.sandboxMode}`
  );
}

/**
 * The approval callback for a NON-INTERACTIVE surface (the web server).
 *
 * `buildApprovalCallback` in approval.ts prompts on stderr and blocks on a
 * stdin line. That is right for the attended REPL and catastrophic for a
 * server: under launchd stdin is /dev/null, so a prompt would hang the turn
 * until the client's abort fires, with no human anywhere near it. The
 * faithful-and-safe reading of `--approval ask` on a surface with no
 * approver is therefore to DENY, not to wait and not to silently allow —
 * fail closed (INVARIANTS §权限与工具).
 *
 * The mode semantics themselves are not re-implemented: `isMutatingCall` is
 * the same classifier the CLI uses, so `ask-mutating` gates exactly the same
 * tools and github actions on both surfaces.
 *
 * The denial reason goes back to the model (which then explains it to the
 * user) and the audit line goes to the log WITHOUT the tool input — tool
 * arguments routinely carry file contents and credentials, and logs are not
 * an audit store (INVARIANTS §权限与工具 5).
 */
export function buildNonInteractiveApprovalCallback(
  cfg: ApprovalConfig,
  log: (msg: string) => void,
): ApprovalCallback | undefined {
  if (cfg.mode === "auto") return undefined;
  const reason =
    cfg.mode === "ask"
      ? "Tool approval is required on this surface but there is no interactive approver " +
        "(the web server has no terminal). Run this from the CLI, or start the server with --approval auto."
      : "This tool call changes state and approval is required on this surface, but there is no " +
        "interactive approver (the web server has no terminal). Run this from the CLI, or start the " +
        "server with --approval auto.";
  return async (toolName: string, toolInput: unknown) => {
    if (cfg.mode === "ask-mutating" && !isMutatingCall(cfg, toolName, toolInput)) {
      return { allow: true };
    }
    log(
      `[approval] denied ${toolName} — mode=${cfg.mode}, no interactive approver on this surface`,
    );
    return { allow: false, reason };
  };
}
