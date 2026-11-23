import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lisaGlobalHome } from "../paths.js";
import type { ApprovalMode } from "../approval.js";
import { isKnownBuiltin } from "./classify.js";
import { isInsideProtected } from "./paths.js";
import type { ActionRequest } from "./types.js";

export type ChatPermission = "ask" | "smart" | "full";

/** The administrator chooses the ceiling. The composer can always tighten it. */
export function chatPermissions(mode: ApprovalMode): ChatPermission[] {
  if (mode === "auto") return ["smart", "ask", "full"];
  if (mode === "warden") return ["smart", "ask"];
  return ["ask"];
}

// Anchored to the running module, in both src/ and dist/. The launch cwd may
// be an unrelated project, or '/' when launched by the Mac application.
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Locate all Lisa source and installation trees that require explicit approval to modify. */
export function lisaCodeRoots(workspace: string): string[] {
  const roots = new Set([packageRoot]);
  let enclosing = path.resolve(packageRoot);
  while (enclosing !== path.dirname(enclosing)) {
    if (enclosing.toLowerCase().endsWith(".app")) {
      roots.add(enclosing);
      break;
    }
    enclosing = path.dirname(enclosing);
  }
  const checkout = process.env.LISA_SOURCE_ROOT;
  if (checkout && path.isAbsolute(checkout)) roots.add(checkout);
  // A globally installed Lisa may have been launched inside a separate
  // source checkout. Protect it even when the user starts in a subdirectory.
  let dir = path.resolve(workspace);
  while (dir !== path.dirname(dir)) {
    try {
      if (
        JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "@oratis/lisa"
      ) {
        roots.add(dir);
        break;
      }
    } catch {
      /* A directory need not contain a package manifest. */
    }
    dir = path.dirname(dir);
  }
  return [...roots];
}

// These tools can run host code (including repository-configured Git helpers)
// or install code that executes later without going through Lisa's file tools.
const hostTools = new Set([
  "github",
  "github_link",
  "pr_status",
  "repo_digest",
  "review_diff",
  "npm_info",
  "mcp",
  "skill_manage",
  "compare_agents",
  "signal_agent",
  "dispatch_agent",
  "run_on_plan",
]);

// The connector continuation has a closed, host-created tool set. It never
// loads the same-named third-party tools from the ordinary chat registry.
export interface ChatPermissionPolicy {
  mode: ChatPermission;
  askAll?: boolean;
  codeRoots: readonly string[];
  hostHookTools?: ReadonlySet<string>;
  /** Built by the closed connector continuation, never the plugin registry. */
  connectorReads?: ReadonlySet<string>;
}

/** Return an explicit approval reason when local chat protections require human confirmation. */
export function chatApprovalReason(
  req: ActionRequest,
  policy: ChatPermissionPolicy,
): string | undefined {
  if (req.tool === "redeploy")
    return "Rebuild or restart Lisa. Review and authorize this deployment once.";
  if (
    (req.category === "write" || req.category === "delete") &&
    req.targets.some(
      (target) =>
        path.isAbsolute(target) && policy.codeRoots.some((root) => isInsideProtected(root, target)),
    )
  ) {
    return "This changes Lisa’s own files. Review the paths and the complete change before approving once.";
  }
  if (
    (req.category === "write" || req.category === "delete") &&
    req.targets.some(
      (target) => path.isAbsolute(target) && isInsideProtected(lisaGlobalHome(), target),
    )
  ) {
    return "This directly modifies Lisa’s private state or configuration. Review this invocation once.";
  }
  if (
    req.category === "exec" ||
    policy.hostHookTools?.has(req.tool) ||
    (!isKnownBuiltin(req.tool) && !policy.connectorReads?.has(req.tool)) ||
    (hostTools.has(req.tool) && !(req.tool === "skill_manage" && req.category === "read"))
  ) {
    return "This tool can run host code or change what runs on your machine, including Lisa herself. Authorize only this invocation.";
  }
  if (
    policy.askAll ||
    (policy.mode === "ask" && (req.egress || !["read", "self", "draft"].includes(req.category)))
  ) {
    return "Your chat permissions require approval for this action.";
  }
  return undefined;
}
