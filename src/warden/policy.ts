/**
 * The Warden policy: one pure function from an ActionRequest to a Decision.
 *
 * Layering, first match wins:
 *   1. system invariants — not overridable by rules, grants or envelopes
 *   2. grants            — exact match; a sensitive off-host payload only
 *                          accepts payload- or recipient-bound grants
 *   3. new-recipient rule — sensitive data to a recipient with no grant ⇒ ask
 *   4. user rules        — replace the interactive default; never loosen the
 *                          taint / remote-origin / corrupt-rules floor
 *   5. default matrix
 *
 * No I/O, no clock other than `ctx.now`, no model. Every path returns a
 * Decision; anything this function does not recognise resolves to "ask".
 */
import path from "node:path";
import { matchGrants, type StoredGrant } from "./grants.js";
import { LOCKED_CATEGORIES, ruleFor, strictness, type WardenRules } from "./rules.js";
import { originColumn } from "./types.js";
import type {
  ActionCategory,
  ActionRequest,
  DataClass,
  Decision,
  OriginColumn,
  RuleBehavior,
  TaskEnvelope,
} from "./types.js";

export interface PolicyContext {
  rules: WardenRules;
  grants: StoredGrant[];
  /** The rules file existed but could not be trusted: nothing side-effecting is "auto". */
  rulesCorrupt?: boolean;
  /** What the user pre-approved when the task was created. */
  envelope?: TaskEnvelope;
  /** Absolute paths the model may never write — Warden's own state. */
  protectedPaths?: string[];
  now?: number;
}

export interface PolicyResult extends Decision {
  /** Grants the caller must record as used (and consume, for "once") before acting. */
  grantIds?: string[];
}

/** Categories with no effect outside Lisa's own home. Always "auto" by default. */
const BENIGN: ReadonlySet<ActionCategory> = new Set(["read", "self", "draft"]);
const SENSITIVE: ReadonlySet<DataClass> = new Set(["pii", "secret", "private-message"]);

function isBenign(category: ActionCategory): boolean {
  return BENIGN.has(category);
}

/** Which column of the default matrix this request falls in. */
function columnOf(req: ActionRequest): OriginColumn {
  return originColumn(req.origin);
}

/** The person at the keyboard of their own machine, in an attended turn. */
function isLocalOwnerChat(req: ActionRequest): boolean {
  return (req.surface === "cli" || req.surface === "local-web") && columnOf(req) === "chat";
}

function insidePath(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Sensitive data leaving the host: the request must be covered by a bound grant. */
function needsRecipientGrant(req: ActionRequest): boolean {
  const classes = req.dataClasses.filter((c) => SENSITIVE.has(c));
  if (classes.length === 0) return false;
  if (req.category === "send" || req.category === "publish" || req.category === "network") {
    return true;
  }
  // An off-host READ (a fetch) only trips on credentials in the request itself
  // — the exfiltration shape — not on an address someone asked to look up.
  return req.egress === true && isBenign(req.category) && classes.includes("secret");
}

/**
 * The default matrix (docs/DESIGN_WARDEN.md). Returns the behaviour BEFORE user
 * rules, for the request's column and taint state.
 */
export function defaultBehavior(req: ActionRequest): RuleBehavior {
  const column = columnOf(req);
  const category = req.category;
  if (isBenign(category)) return "auto";
  if (category === "purchase" || category === "credential") return "handoff";
  if (category === "send" || category === "publish" || category === "delete") {
    return column === "task" ? "preapproved" : "ask";
  }
  if (category === "network") {
    if (column === "task") return "preapproved";
    return column === "chat" && !req.tainted ? "auto" : "ask";
  }
  if (category === "write" || category === "exec") {
    const confinedToWorkspace = req.sandboxed;
    if (confinedToWorkspace) {
      if (column === "task") return "preapproved";
      return column === "chat" && !req.tainted ? "auto" : "ask";
    }
    // Unconfined. A write that leaves the workspace always asks. Unsandboxed
    // exec — and a workspace write the same unsandboxed shell could make
    // anyway — stays "auto" only for the local owner in an untainted attended
    // turn (today's daily-driver behaviour under danger-full-access).
    if (category === "write" && req.withinWorkspace !== true) return "ask";
    return isLocalOwnerChat(req) && !req.tainted ? "auto" : "ask";
  }
  return "ask";
}

/**
 * The strictest behaviour the context forces regardless of user rules: a
 * tainted run, a remote origin or an untrustworthy rules file never
 * auto-allows a side effect. A tainted TASK is floored at "preapproved" rather
 * than "ask" — tasks read the web as a matter of course, and what keeps them
 * safe is that only the envelope the user approved can cover the action.
 */
function floorFor(
  req: ActionRequest,
  ctx: PolicyContext,
): { behavior: RuleBehavior; ruleId: string } {
  if (isBenign(req.category)) return { behavior: "auto", ruleId: "" };
  if (ctx.rulesCorrupt) return { behavior: "ask", ruleId: "system:rules-corrupt" };
  const column = columnOf(req);
  if (column === "channel") return { behavior: "ask", ruleId: "system:remote-origin" };
  if (req.tainted) {
    return { behavior: column === "task" ? "preapproved" : "ask", ruleId: "system:tainted-run" };
  }
  return { behavior: "auto", ruleId: "" };
}

/** Does the task envelope cover this request? Absent envelope covers nothing. */
export function envelopeCovers(req: ActionRequest, envelope: TaskEnvelope | undefined): boolean {
  if (!envelope) return false;
  const byTool = envelope.tools?.includes(req.tool) === true;
  const byCategory = envelope.categories?.includes(req.category) === true;
  if (!byTool && !byCategory) return false;
  const offHost =
    req.category === "network" || req.category === "send" || req.category === "publish";
  if (envelope.targets !== undefined) {
    if (req.targets.length === 0) return !offHost;
    return req.targets.every((target) => envelope.targets!.includes(target));
  }
  // No target list: fine for confined local work, but a tainted run may only
  // reach off-host targets the envelope named (simplified tainted egress).
  return !(offHost && req.tainted);
}

function systemInvariant(req: ActionRequest, ctx: PolicyContext): Decision | null {
  // The proactive channel is read-only: Lisa's self-driven runs may read and
  // write her own home, nothing else — not even a draft. Checked first so an
  // autonomous run never produces an inbox item either (POLICY_REACH_OUT).
  if (req.origin.kind === "autonomy" && req.category !== "read" && req.category !== "self") {
    return {
      verdict: "deny",
      reason:
        "Self-driven runs are read-only: this action has an external side effect and must " +
        "come from a task the user authorised.",
      ruleId: "system:autonomy-read-only",
    };
  }
  const locked = LOCKED_CATEGORIES[req.category];
  if (locked === "handoff") {
    return {
      verdict: "handoff",
      reason:
        req.category === "purchase"
          ? "Purchases are never made on the user's behalf: hand this step back to the user."
          : "Credentials are never entered on the user's behalf: hand this step back to the user.",
      ruleId: `system:handoff-${req.category}`,
    };
  }
  if (req.surface === "cloud") {
    if (req.category === "exec") {
      return {
        verdict: "deny",
        reason: "Command execution is not available on the hosted edition.",
        ruleId: "system:cloud-no-exec",
      };
    }
    if (req.category === "write" && !req.connector) {
      return {
        verdict: "deny",
        reason: "Host file writes are not available on the hosted edition.",
        ruleId: "system:cloud-no-host-write",
      };
    }
  }
  if (req.category === "write" && touchesProtected(req, ctx)) {
    return {
      verdict: "deny",
      reason: "Warden's own rules, grants and audit files cannot be modified by a tool call.",
      ruleId: "system:warden-state-protected",
    };
  }
  return null;
}

function touchesProtected(req: ActionRequest, ctx: PolicyContext): boolean {
  if (!ctx.protectedPaths || ctx.protectedPaths.length === 0) return false;
  return req.targets.some(
    (target) =>
      path.isAbsolute(target) &&
      ctx.protectedPaths!.some((protectedPath) => insidePath(protectedPath, target)),
  );
}

function finalize(req: ActionRequest, result: PolicyResult): PolicyResult {
  // Belt and braces for the read-only proactive channel: nothing an autonomous
  // run does may wait on, or hand off to, a human.
  if (req.origin.kind === "autonomy" && result.verdict !== "allow" && result.verdict !== "deny") {
    return {
      verdict: "deny",
      reason: `Self-driven runs cannot ask for approval (${result.reason})`,
      ruleId: "system:autonomy-read-only",
    };
  }
  return result;
}

/** Decide one action. Pure. */
export function evaluate(req: ActionRequest, ctx: PolicyContext): PolicyResult {
  const now = ctx.now ?? Date.now();

  const invariant = systemInvariant(req, ctx);
  if (invariant) return finalize(req, invariant);

  const sensitiveEgress = needsRecipientGrant(req);
  // A shell command the caller flagged as naming Warden's state or approval
  // API. The flag is a string heuristic, so it asks (every time, for this
  // exact command) rather than denies: a developer grepping their own checkout
  // for "/api/approvals" must still be able to say yes.
  const guardedExec = req.category === "exec" && touchesProtected(req, ctx);
  const granted = matchGrants(req, ctx.grants, now, {
    boundOnly: sensitiveEgress || guardedExec,
  });
  if (granted) {
    return finalize(req, {
      verdict: "allow",
      reason: `Covered by a ${granted[0]!.scope} grant.`,
      grantId: granted[0]!.id,
      grantIds: granted.map((g) => g.id),
    });
  }

  if (guardedExec) {
    return finalize(req, {
      verdict: "ask",
      reason: "This command refers to Warden's own state files or approval API.",
      ruleId: "system:warden-state-guard",
    });
  }

  if (sensitiveEgress) {
    return finalize(req, {
      verdict: "ask",
      reason:
        "This sends personal or secret data to a recipient you have not approved before.",
      ruleId: "system:new-recipient-sensitive-data",
    });
  }

  // The untainted default, so that when taint is what forces the ask, the
  // floor below — not a generic default — is recorded as the reason.
  let behavior = defaultBehavior({ ...req, tainted: false });
  let ruleId = `default:${req.category}`;
  const user = ruleFor(ctx.rules, req);
  if (user) {
    behavior = user.behavior;
    ruleId = user.ruleId;
  }
  const floor = floorFor(req, ctx);
  if (strictness(floor.behavior) > strictness(behavior)) {
    behavior = floor.behavior;
    ruleId = floor.ruleId;
  }

  switch (behavior) {
    case "auto":
      return finalize(req, { verdict: "allow", reason: "Allowed by policy.", ruleId });
    case "preapproved":
      if (envelopeCovers(req, ctx.envelope)) {
        return finalize(req, {
          verdict: "allow",
          reason: "Pre-approved by the task's capability envelope.",
          ruleId: "envelope",
        });
      }
      return finalize(req, {
        verdict: "ask",
        reason: "This action was not pre-approved for the task.",
        ruleId,
      });
    case "handoff":
      return finalize(req, {
        verdict: "handoff",
        reason: "Your rules hand this kind of action back to you.",
        ruleId,
      });
    case "ask":
    default:
      return finalize(req, { verdict: "ask", reason: askReason(req, ruleId), ruleId });
  }
}

function askReason(req: ActionRequest, ruleId: string): string {
  if (ruleId === "system:tainted-run") {
    return "This run has read untrusted external content, so side effects need your approval.";
  }
  if (ruleId === "system:remote-origin") {
    return "This request came from a remote channel, so side effects need your approval.";
  }
  if (ruleId === "system:rules-corrupt") {
    return "Your Warden rules file could not be read, so side effects need your approval.";
  }
  if (req.category === "write" && req.withinWorkspace !== true) {
    return "This writes outside the workspace.";
  }
  return `"${req.category}" actions need your approval.`;
}
