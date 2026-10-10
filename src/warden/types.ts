/**
 * Warden — the deterministic decision layer for side-effecting tool calls
 * (PLAN_ALWAYS_ON_UPGRADE W2a, docs/DESIGN_WARDEN.md).
 *
 * The model proposes; Warden decides. Nothing in this module calls a model,
 * and nothing in it trusts model-supplied text for anything but display.
 */
import type { RuntimeSurface } from "../runtime-policy.js";

export type { RuntimeSurface };

/**
 * What kind of effect a tool call has.
 *
 * "self" = writes confined to Lisa's own home (soul, memory, kb, skills,
 * desires, mood). They are not external side effects, which is why the
 * read-only proactive channel may still perform them.
 */
export const ACTION_CATEGORIES = [
  "read",
  "self",
  "draft",
  "write",
  "exec",
  "network",
  "send",
  "publish",
  "purchase",
  "delete",
  "credential",
] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

export const DATA_CLASSES = ["pii", "secret", "financial", "health", "private-message"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/**
 * The four user-visible rule behaviours (UI: 直接做 / 预先批准才做 / 先问 / 交还给你).
 *
 * "preapproved" = allowed only when a matching grant or an approved task
 * envelope covers the action; otherwise it asks. It never silently allows.
 */
export const RULE_BEHAVIORS = ["auto", "preapproved", "ask", "handoff"] as const;
export type RuleBehavior = (typeof RULE_BEHAVIORS)[number];

export const ORIGIN_KINDS = [
  "chat",
  "task",
  "routine",
  "watcher",
  "channel",
  "autonomy",
  "mcp",
  "cli",
] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

export interface Origin {
  kind: OriginKind;
  id?: string;
}

/**
 * The trust column of the default matrix an origin falls in. Grants are bound
 * to the column they were approved in, so an "always" approved in the owner's
 * attended chat is not standing permission for a remote channel.
 */
export type OriginColumn = "chat" | "task" | "channel";

export function originColumn(origin: Origin): OriginColumn {
  switch (origin.kind) {
    case "chat":
    case "cli":
      return "chat";
    case "task":
    case "routine":
    case "watcher":
      return "task";
    default:
      // channel, mcp, autonomy and anything unrecognised: the strictest column.
      return "channel";
  }
}

export interface ActionRequest {
  id: string;
  /** ISO-8601 */
  at: string;
  /** Authenticated tenant, or null on the single-user Mac edition. */
  uid: string | null;
  surface: RuntimeSurface;
  origin: Origin;
  taskId?: string;
  tool: string;
  /** Action/method for action-dispatched tools (e.g. github `pr_merge`). */
  method?: string;
  /** Connector / MCP server the call goes through, when there is one. */
  connector?: string;
  category: ActionCategory;
  /** Recipients, hostnames or paths the call touches. */
  targets: string[];
  dataClasses: DataClass[];
  purpose?: string;
  /** sha256 of the canonical JSON of `{tool,input}`. Binds an approval to the exact payload. */
  digest: string;
  /** Redacted, ≤240 chars. The only rendering of the input that may be shown or logged. */
  preview: string;
  /** True when the effect is confined by the workspace sandbox. */
  sandboxed: boolean;
  /** Every path the call writes resolves inside the workspace (a path check, not enforcement). */
  withinWorkspace?: boolean;
  /** The call sends data off this host. */
  egress?: boolean;
  /**
   * For an off-host call: could untrusted content have picked where it goes?
   * "chosen" = the destination is an argument (a URL to fetch, a remote agent
   * to call). "fixed" = it is the tool's own service (the search provider,
   * the npm registry). Only "chosen" destinations are an exfiltration channel.
   */
  destination?: "fixed" | "chosen";
  /**
   * Set by the session: the exact destination URL already appeared verbatim in
   * the conversation (a user message or an earlier tool result), so the model
   * did not compose it — it cannot have appended data to it.
   */
  destinationKnown?: boolean;
  /**
   * False when the recipients / destinations could not be enumerated completely
   * (too many, nested, or under keys the classifier does not know). Such a
   * request is never covered by a target grant or loosened by a target rule.
   */
  targetsComplete?: boolean;
  /** A path the call touches is a credential location or Warden's own state. */
  sensitivePath?: boolean;
  /** Set by the session: an exec whose text names Warden's state or approval API. */
  guarded?: boolean;
  /** True when untrusted external content entered this agent run before the call. */
  tainted: boolean;
}

export type Verdict = "allow" | "deny" | "ask" | "handoff";

export interface Decision {
  verdict: Verdict;
  reason: string;
  ruleId?: string;
  grantId?: string;
}

export const GRANT_SCOPES = ["once", "task", "target", "24h", "always"] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

export interface Grant {
  id: string;
  /** ISO-8601 */
  createdAt: string;
  scope: GrantScope;
  tool: string;
  category: ActionCategory;
  /** Bound target for scope "target". */
  target?: string;
  /** Bound task for scope "task". */
  taskId?: string;
  /** Bound payload digest for scope "once". */
  digest?: string;
  /** ISO-8601. Absent = no expiry ("always", "target", "task"). */
  expiresAt?: string;
  uses: number;
  lastUsedAt?: string;
}

/**
 * A task capability envelope as a pre-approval: what the user CONFIRMED the
 * task may do without asking, after being shown it in plain words. It can only
 * satisfy a "preapproved" default — it never overrides a system invariant, an
 * "ask"/"handoff" rule, or the taint and PII rules — and in a tainted run it
 * covers only reads and writes inside the run's workspace.
 */
export interface TaskEnvelope {
  categories?: ActionCategory[];
  tools?: string[];
  /** Exact targets (recipients/hosts/paths). Absent = any target of an allowed tool/category. */
  targets?: string[];
}

export type InboxItemKind = "approval" | "handoff";

/** `approval_requested` SSE payload — everything a client needs to render a card. */
export interface ApprovalRequestedEvent {
  type: "approval_requested";
  id: string;
  kind: InboxItemKind;
  at: string;
  tool: string;
  category: ActionCategory;
  targets: string[];
  preview: string;
  purpose?: string;
  digest: string;
  expiresAt: string;
  taskId?: string;
  origin: Origin;
  /** Why Warden is asking (deterministic policy reason, never model text). */
  reason: string;
  /** Scopes this item can be approved with (empty for a hand-off). */
  scopes: GrantScope[];
}

/** One field of the payload an approval covers, as the card shows it. */
export interface PayloadField {
  key: string;
  /** The whole value (secrets masked) — never clipped. */
  value: string;
  /** Shown first: the field that says what the call does. */
  primary: boolean;
}

export interface ApprovalResolvedEvent {
  type: "approval_resolved";
  id: string;
  verdict: "approved" | "denied" | "expired" | "dismissed";
  scope?: GrantScope;
}

export type WardenEvent = ApprovalRequestedEvent | ApprovalResolvedEvent;

/**
 * The inbox emitter contract. `uid` is the tenant the item belongs to (null on
 * the Mac edition); the host MUST deliver the event only to that tenant's
 * subscribers (`TenantEventBus.broadcast(event, uid)`).
 */
export type WardenEmit = (event: WardenEvent, uid: string | null) => void;

export function isActionCategory(v: unknown): v is ActionCategory {
  return typeof v === "string" && (ACTION_CATEGORIES as readonly string[]).includes(v);
}
export function isRuleBehavior(v: unknown): v is RuleBehavior {
  return typeof v === "string" && (RULE_BEHAVIORS as readonly string[]).includes(v);
}
export function isGrantScope(v: unknown): v is GrantScope {
  return typeof v === "string" && (GRANT_SCOPES as readonly string[]).includes(v);
}
