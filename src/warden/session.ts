/**
 * createWardenSession — THE integration point.
 *
 * One session per agent run. It returns an `ApprovalCallback` to hand to
 * `runAgent` and an `observe` to feed from `onEvent`. Every tool call the run
 * makes is classified, decided by the pure policy, audited, and — when the
 * verdict is "ask" — parked in the inbox until a human answers or it expires.
 *
 * Fail-closed is structural here: `approval` wraps the whole pipeline in one
 * try/catch whose only outcome is a deny, and an "allow" for a side-effecting
 * call is returned only after its audit line has been written.
 */
import type { ApprovalCallback, ApprovalDecision } from "../agent.js";
import type { AgentEvent, ToolDefinition } from "../types.js";
import type { SandboxMode } from "../sandbox/mode.js";
import { lisaHome } from "../paths.js";
import { logWarn } from "../log.js";
import { auditDecision, auditQuietly } from "./audit.js";
import { loadGrants, useGrants, type LoadedGrants } from "./grants.js";
import type { WardenInbox } from "./inbox.js";
import { evaluate, type PolicyResult } from "./policy.js";
import { buildActionRequest } from "./request.js";
import { loadRules, type LoadedRules } from "./rules.js";
import { wardenDir } from "./store.js";
import type {
  ActionRequest,
  DataClass,
  Decision,
  Origin,
  RuntimeSurface,
  TaskEnvelope,
} from "./types.js";

export interface WardenSessionOptions {
  surface: RuntimeSurface;
  /** Authenticated tenant; null on the single-user Mac edition. Never client-supplied. */
  uid: string | null;
  origin: Origin;
  taskId?: string;
  sandboxMode: SandboxMode;
  /** Absolute workspace root (the run's cwd). */
  workspaceRoot: string;
  inbox: WardenInbox;
  /** The run's tools, for annotation lookup on MCP tools. */
  tools?: ToolDefinition[];
  /** What the user pre-approved when the task was created ("preapproved" behaviour). */
  envelope?: TaskEnvelope;
  /** Short, host-supplied statement of what the run is for (shown on cards). */
  purpose?: string;
  /** The run already carries untrusted external content (e.g. a resumed conversation). */
  initialTaint?: boolean;
  /** Tenant home. Defaults to `lisaHome()` captured NOW — create the session inside the request scope. */
  home?: string;
  loadRules?: () => Promise<LoadedRules>;
  loadGrants?: () => Promise<LoadedGrants>;
  /** How long an "ask" waits. Default: the inbox default (10 minutes). */
  approvalTimeoutMs?: number;
  /** Aborting cancels any pending approval (a cancel is a deny). */
  signal?: AbortSignal;
  dataClassHints?: DataClass[];
  log?: (msg: string) => void;
  now?: () => number;
}

export interface WardenOutcome {
  decision: ApprovalDecision;
  request: ActionRequest;
  verdict: Decision;
}

export interface WardenSession {
  /** Pass to `runAgent({ approval })`. */
  approval: ApprovalCallback;
  /** Feed every AgentEvent from `runAgent({ onEvent })`. */
  observe(event: AgentEvent): void;
  /** Same pipeline as `approval`, returning the request and verdict too. */
  decide(toolName: string, toolInput: unknown): Promise<WardenOutcome>;
  /** True once untrusted external content has entered the run. */
  readonly tainted: boolean;
}

const BENIGN = new Set(["read", "self", "draft"]);

function handoffInstruction(req: ActionRequest): string {
  if (req.category === "purchase") {
    return "This needs you: complete the purchase yourself. Lisa never pays on your behalf.";
  }
  if (req.category === "credential") {
    return "This needs you: enter the credential yourself. Lisa never handles passwords or codes.";
  }
  return "This needs you: your rules hand this kind of action back to you to do yourself.";
}

export function createWardenSession(opts: WardenSessionOptions): WardenSession {
  const home = opts.home ?? lisaHome();
  const now = opts.now ?? Date.now;
  const log = opts.log ?? logWarn;
  const toolsByName = new Map((opts.tools ?? []).map((tool) => [tool.name, tool]));
  const rulesLoader = opts.loadRules ?? (() => loadRules(home));
  const grantsLoader = opts.loadGrants ?? (() => loadGrants(home, now()));
  const protectedPaths = [wardenDir(home)];
  /** Names of taint-source tools this session allowed and has not yet seen finish. */
  const armed = new Map<string, number>();
  let tainted = opts.initialTaint === true;

  async function policyFor(req: ActionRequest): Promise<PolicyResult> {
    // A loader that THROWS is treated exactly like a corrupt file: no user
    // rules and no grants, with every side effect floored at "ask".
    let rules: LoadedRules;
    try {
      rules = await rulesLoader();
    } catch (err) {
      log(`[warden] rules unavailable (${(err as Error).message}); side effects will ask`);
      rules = { rules: { version: 1, categories: {}, tools: {}, targets: {} }, corrupt: true };
    }
    let grants: LoadedGrants;
    try {
      grants = await grantsLoader();
    } catch (err) {
      log(`[warden] grants unavailable (${(err as Error).message}); treating as none`);
      grants = { grants: [], corrupt: true };
    }
    return evaluate(req, {
      rules: rules.rules,
      rulesCorrupt: rules.corrupt,
      grants: grants.grants,
      envelope: opts.envelope,
      protectedPaths,
      now: now(),
    });
  }

  async function pipeline(toolName: string, toolInput: unknown): Promise<WardenOutcome> {
    const started = now();
    const { req, taintSource } = buildActionRequest(
      toolName,
      toolInput,
      toolsByName.get(toolName),
      {
        uid: opts.uid,
        surface: opts.surface,
        origin: opts.origin,
        taskId: opts.taskId,
        workspaceRoot: opts.workspaceRoot,
        sandboxMode: opts.sandboxMode,
        tainted,
        purpose: opts.purpose,
        dataClassHints: opts.dataClassHints,
        now: started,
      },
    );
    // A shell command that names Warden's state directory or its approval API
    // is flagged as touching protected state, which makes the policy ask for
    // this exact command whatever grants or rules exist. Best effort — a
    // string match cannot see through obfuscation; the sandbox is the real
    // boundary.
    if (req.category === "exec" && mentionsWardenState(toolInput, protectedPaths[0]!)) {
      req.targets = [...req.targets, protectedPaths[0]!];
    }
    let result = await policyFor(req);

    if (result.verdict === "allow" && result.grantIds && result.grantIds.length > 0) {
      // Record the use and consume a "once" grant. Losing that race (or failing
      // to write) means the grant does not cover this call: ask instead.
      let used = false;
      try {
        used = await useGrants(result.grantIds, home, now());
      } catch (err) {
        log(`[warden] could not record grant use: ${(err as Error).message}`);
      }
      if (!used) {
        result = {
          verdict: "ask",
          reason: "The grant covering this action is no longer available.",
          ruleId: "system:grant-unavailable",
        };
      }
    }

    const allow = (): WardenOutcome => {
      if (taintSource) {
        armed.set(toolName, (armed.get(toolName) ?? 0) + 1);
        // Conservative: the run counts as tainted from the moment a
        // taint-source call is let through, not only once `observe` sees it
        // finish — a host that forgets to wire `observe` must not get a
        // weaker policy.
        tainted = true;
      }
      return { decision: { allow: true }, request: req, verdict: result };
    };
    const deny = (reason: string): WardenOutcome => ({
      decision: { allow: false, reason },
      request: req,
      verdict: result,
    });

    try {
      await auditDecision(req, result, { home, latencyMs: now() - started, now: now() });
    } catch (err) {
      // No audit record ⇒ no side effect. Reads may proceed: refusing them
      // would turn a full disk into a dead assistant without protecting anything.
      log(`[warden] audit write failed: ${(err as Error).message}`);
      if (!(result.verdict === "allow" && BENIGN.has(req.category))) {
        return deny("This action was not run because it could not be recorded in the audit log.");
      }
    }

    switch (result.verdict) {
      case "allow":
        return allow();
      case "deny":
        return deny(result.reason);
      case "handoff": {
        try {
          await opts.inbox.handoff(req, { home, reason: result.reason });
        } catch (err) {
          log(`[warden] could not file a hand-off: ${(err as Error).message}`);
        }
        return deny(handoffInstruction(req));
      }
      case "ask": {
        const outcome = await opts.inbox.request(req, {
          home,
          reason: result.reason,
          timeoutMs: opts.approvalTimeoutMs,
          signal: opts.signal,
        });
        if (outcome.approved) return allow();
        if (outcome.expired) {
          return deny(
            "Approval was requested but nobody answered before it expired, so this action was " +
              "not run. Tell the user it is waiting on them; do not retry it on your own.",
          );
        }
        return deny(
          outcome.reason
            ? `The user did not approve this action: ${outcome.reason}`
            : "The user did not approve this action.",
        );
      }
      default:
        return deny("Warden returned an unknown verdict; the action was not run.");
    }
  }

  async function decide(toolName: string, toolInput: unknown): Promise<WardenOutcome> {
    try {
      return await pipeline(toolName, toolInput);
    } catch (err) {
      log(`[warden] decision failed for ${toolName}: ${(err as Error).message}`);
      const verdict: Decision = {
        verdict: "deny",
        reason: "Warden could not evaluate this action, so it was not run.",
        ruleId: "system:warden-error",
      };
      const request = buildFallbackRequest(toolName, opts, now());
      // The refusal is still a decision; record it if the log is reachable.
      await auditQuietly(auditDecision(request, verdict, { home, now: now() }));
      return { decision: { allow: false, reason: verdict.reason }, request, verdict };
    }
  }

  return {
    approval: async (toolName, toolInput) => (await decide(toolName, toolInput)).decision,
    decide,
    observe(event: AgentEvent): void {
      if (event.type !== "tool_call_end" || !event.toolName) return;
      const pending = armed.get(event.toolName) ?? 0;
      if (pending <= 0) return;
      if (pending === 1) armed.delete(event.toolName);
      else armed.set(event.toolName, pending - 1);
      tainted = true;
    },
    get tainted() {
      return tainted;
    },
  };
}

const WARDEN_STATE_PATTERN =
  /warden[\\/](?:rules|grants|pending|audit)|\.lisa[\\/]warden|\/api\/(?:approvals|warden)\b/i;

/** Does an exec input name Warden's state files or its approval API? */
export function mentionsWardenState(input: unknown, wardenPath: string): boolean {
  let text: string;
  try {
    text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
  } catch {
    return true; // unserialisable exec input: assume the worst
  }
  return text.includes(wardenPath) || WARDEN_STATE_PATTERN.test(text);
}

/** A minimal request for the error path, where classification itself may have thrown. */
function buildFallbackRequest(
  toolName: string,
  opts: WardenSessionOptions,
  at: number,
): ActionRequest {
  return {
    id: "act_error",
    at: new Date(at).toISOString(),
    uid: opts.uid,
    surface: opts.surface,
    origin: opts.origin,
    taskId: opts.taskId,
    tool: String(toolName).slice(0, 120),
    category: "write",
    targets: [],
    dataClasses: [],
    digest: "",
    preview: `${String(toolName).slice(0, 120)}(…)`,
    sandboxed: false,
    tainted: true,
  };
}
