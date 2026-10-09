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
import { lisaGlobalHome, lisaHome } from "../paths.js";
import { protectFromSandbox } from "../sandbox/protect.js";
import { logWarn } from "../log.js";
import path from "node:path";
import { auditDecision, auditQuietly } from "./audit.js";
import { loadGrants, useGrants, type LoadedGrants } from "./grants.js";
import type { ApprovalOutcome, InboxItemView, WardenInbox } from "./inbox.js";
import { evaluate, type PolicyResult } from "./policy.js";
import { buildActionRequest } from "./request.js";
import { defaultRules, loadRules, type LoadedRules } from "./rules.js";
import { loadDigestKey, wardenDir } from "./store.js";
import type {
  ActionRequest,
  DataClass,
  Decision,
  Origin,
  RuntimeSurface,
  TaskEnvelope,
} from "./types.js";

/**
 * URLs that have appeared verbatim in a conversation — in what the user wrote
 * or in an earlier tool result. A fetch of one of these was not composed by the
 * model, so it cannot carry data the model appended.
 */
export class KnownUrls {
  private readonly urls = new Set<string>();
  constructor(private readonly max = 4000) {}

  /** Record every http(s) URL found in `text`. */
  note(text: unknown): void {
    if (typeof text !== "string" || text.length === 0) return;
    // Bounded scan: a tool result can be megabytes.
    const scan = text.length > 1_000_000 ? text.slice(0, 1_000_000) : text;
    for (const match of scan.matchAll(/https?:\/\/[^\s"'<>`\\)\]}]{1,2048}/g)) {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      if (this.urls.has(url)) continue;
      if (this.urls.size >= this.max) {
        const oldest = this.urls.values().next().value;
        if (oldest !== undefined) this.urls.delete(oldest);
      }
      this.urls.add(url);
    }
  }

  has(url: string): boolean {
    return this.urls.has(url) || this.urls.has(url.replace(/[.,;:!?]+$/, ""));
  }

  get size(): number {
    return this.urls.size;
  }
}

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
  /**
   * The run already carries untrusted content: a resumed conversation that
   * read the web, or a user message with attachments.
   */
  initialTaint?: boolean;
  /** Called once, the first time the run becomes tainted (persist it). */
  onTaint?: () => void;
  /**
   * URLs already seen in this conversation. Share one instance across the
   * turns of a conversation; the session adds what the tool results contain.
   */
  knownUrls?: KnownUrls;
  /** Text the USER wrote this turn: URLs in it are destinations the user chose. */
  userText?: string;
  /** Tenant home. Defaults to `lisaHome()` captured NOW — create the session inside the request scope. */
  home?: string;
  loadRules?: () => Promise<LoadedRules>;
  loadGrants?: () => Promise<LoadedGrants>;
  /** How long an "ask" waits. Default: the inbox default (10 minutes). */
  approvalTimeoutMs?: number;
  /** Aborting cancels any pending approval (a cancel is a deny). */
  signal?: AbortSignal;
  /**
   * An "ask" is now pending in the inbox (the item exists and was announced).
   * Each call is followed by exactly one `onApprovalSettled`, after this one's
   * promise has settled. Hooks never change a decision: a throw is logged.
   */
  onApprovalPending?: (item: InboxItemView, req: ActionRequest) => void | Promise<void>;
  /** The pending approval was answered, expired or cancelled. */
  onApprovalSettled?: (outcome: ApprovalOutcome, req: ActionRequest) => void | Promise<void>;
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
  /** Pass to `runAgent({ approval })` and to `toolCtx.approval`. */
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
  // Reads of these always ask: Warden's state, and the operator's provider keys.
  const sensitivePaths = [
    wardenDir(home),
    path.join(lisaGlobalHome(), "config.env"),
    path.join(lisaGlobalHome(), "warden"),
  ];
  // …and they are unreachable from a sandboxed shell, not only from file tools.
  protectFromSandbox({ path: protectedPaths[0] });
  const knownUrls = opts.knownUrls ?? new KnownUrls();
  knownUrls.note(opts.userText);
  /** Names of taint-source tools this session allowed and has not yet seen finish. */
  const armed = new Map<string, number>();
  let tainted = opts.initialTaint === true;

  /** Run a host hook; a throw is logged and never reaches the decision. */
  const quietly = async (fn: () => unknown, name: string): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      log(`[warden] ${name} threw: ${(err as Error).message}`);
    }
  };

  const taint = (): void => {
    if (tainted) return;
    tainted = true;
    try {
      opts.onTaint?.();
    } catch (err) {
      log(`[warden] onTaint threw: ${(err as Error).message}`);
    }
  };

  async function loadRulesSafely(): Promise<LoadedRules> {
    // A loader that THROWS is treated exactly like a corrupt file: no user
    // rules, with every side effect floored at "ask".
    try {
      return await rulesLoader();
    } catch (err) {
      log(`[warden] rules unavailable (${(err as Error).message}); side effects will ask`);
      return { rules: defaultRules(), corrupt: true };
    }
  }

  async function policyFor(req: ActionRequest, rules: LoadedRules): Promise<PolicyResult> {
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
    const rules = await loadRulesSafely();
    // No key ⇒ no digest ⇒ this throws and the call is denied by `decide`.
    const digestKey = await loadDigestKey(home);
    const { req, taintSource, primaryKeys } = buildActionRequest(
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
        // A corrupt rules file trusts no server.
        trustedMcpServers: rules.corrupt ? [] : rules.rules.trustedMcpServers,
        sensitivePaths,
        digestKey,
        isKnownUrl: (url) => knownUrls.has(url),
        now: started,
      },
    );
    // A command that names Warden's state directory, its approval API or its
    // CLI is flagged, which makes the policy ask for this exact command
    // whatever grants or rules exist. Defence in depth only: a string match
    // cannot see through a variable or an encoded payload.
    if (req.category === "exec" && mentionsWardenState(toolInput, protectedPaths[0]!)) {
      req.guarded = true;
    }
    let result = await policyFor(req, rules);

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
          scopes: ["once"],
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
        taint();
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
        let pending: Promise<void> | undefined;
        const outcome = await opts.inbox.request(req, {
          home,
          reason: result.reason,
          payload: toolInput,
          primaryKeys,
          scopes: result.scopes,
          bindTargets: result.bindTargets,
          timeoutMs: opts.approvalTimeoutMs,
          signal: opts.signal,
          ...(opts.onApprovalPending
            ? {
                onQueued: (item: InboxItemView) => {
                  pending = quietly(() => opts.onApprovalPending!(item, req), "onApprovalPending");
                },
              }
            : {}),
        });
        if (pending) {
          await pending;
          await quietly(() => opts.onApprovalSettled?.(outcome, req), "onApprovalSettled");
        }
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
      // Whatever a tool returned is now part of the conversation: a URL in it
      // is one the model can fetch without having composed it.
      knownUrls.note(event.toolResult);
      const pending = armed.get(event.toolName) ?? 0;
      if (pending <= 0) return;
      if (pending === 1) armed.delete(event.toolName);
      else armed.set(event.toolName, pending - 1);
      taint();
    },
    get tainted() {
      return tainted;
    },
  };
}

const WARDEN_STATE_PATTERN = new RegExp(
  [
    "warden[\\\\/](?:rules|grants|pending|audit|tainted|digest)",
    "\\.lisa[\\\\/]warden",
    "\\/api\\/(?:approvals|warden)\\b",
    // The CLI that edits the same state: `lisa warden …`, `lisa approvals …`,
    // `node dist/cli.js warden …`.
    "\\b(?:lisa|cli\\.[cm]?[jt]s)[\"']?\\s+(?:warden|approvals)\\b",
  ].join("|"),
  "i",
);

/**
 * Does an exec input name Warden's state files, its approval API or its CLI?
 * DEFENCE IN DEPTH, not a boundary: `p=approvals; curl …/api/$p` passes this
 * check. A confined command is additionally denied the directory and the port
 * by its sandbox profile (src/sandbox/protect.ts), and an unconfined one asks
 * by default — but once the user lets an unconfined command run, nothing here
 * stops it from approving on loopback. Closing that needs approvals signed by
 * a native approver (docs/DESIGN_WARDEN.md, known limits).
 */
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
