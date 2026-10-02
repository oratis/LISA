/**
 * Tool-call classification — what KIND of effect a call has, on what, and
 * whether it is confined.
 *
 * This is an explicit table, not inference. A tool that is not in the table is
 * a "write" that asks: a new builtin, an executable skill or a plugin tool must
 * never become auto-allowed because nobody listed it. Tool annotations are
 * hints (src/types.ts) — they may lower an MCP tool to "read", and can never
 * make anything more trusted than that.
 */
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import type { SandboxMode } from "../sandbox/mode.js";
import { detectDataClasses } from "./preview.js";
import type { ActionCategory, DataClass } from "./types.js";

export interface ClassifyContext {
  /** Absolute workspace root of the session (the turn's cwd). */
  workspaceRoot: string;
  sandboxMode: SandboxMode;
  /** Data classes asserted by the caller (e.g. a connector manifest). */
  dataClassHints?: DataClass[];
}

export interface Classification {
  category: ActionCategory;
  targets: string[];
  dataClasses: DataClass[];
  method?: string;
  connector?: string;
  /** The effect is confined by an OS-enforced sandbox to the workspace. */
  sandboxed: boolean;
  /** Every path the call writes resolves inside the workspace (a path check, not enforcement). */
  withinWorkspace: boolean;
  /** The call sends data off this host. */
  egress: boolean;
  /** Completing the call brings untrusted external content into the agent run. */
  taintSource: boolean;
}

const READ_TOOLS = new Set([
  "read",
  "ls",
  "grep",
  "memory_search",
  "kb_search",
  "kb_read",
  "kb_list",
  "kb_links",
  "web_search",
  "web_fetch",
  "list_agents",
  "inspect_agent",
  "dispatch_status",
  "pr_status",
  "repo_digest",
  "review_diff",
  "soul_read",
  "soul_history",
  "soul_diff",
  "npm_info",
  "agent_recap",
  "advise_now",
  "github_link",
  "transcribe",
]);

/** Writes confined to Lisa's own home: soul, memory, kb, skills, desires, mood, voice output. */
const SELF_TOOLS = new Set([
  "soul_patch",
  "soul_journal",
  "soul_feel",
  "soul_object",
  "desire_progress_log",
  "desire_revise",
  "desire_close",
  "memory",
  "kb_add",
  "kb_write",
  "kb_ingest",
  "skill_manage",
  "set_mood",
  "speak",
]);

const DRAFT_TOOLS = new Set(["social_compose"]);
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);

/**
 * Local execution / process control. Only `bash` goes through the capability
 * seam, so only `bash` can be sandboxed; the exec-util family spawns directly
 * (PLAN W2 "已知漏洞") and is always treated as unconfined.
 */
const EXEC_TOOLS = new Set([
  "bash",
  "run_checks",
  "redeploy",
  "dispatch_agent",
  "run_on_plan",
  "compare_agents",
  "signal_agent",
  "scheduled_dispatch",
  "task",
]);

/** github actions that only read. Anything else — including an unknown action — is a publish. */
const GITHUB_READ_ACTIONS = new Set([
  "issue_list",
  "issue_view",
  "pr_view",
  "run_list",
  "run_view",
  "release_list",
]);

/** Tools whose output is untrusted external content (taint sources). */
const TAINT_TOOLS = new Set(["web_fetch", "web_search", "kb_ingest", "takoapi", "task"]);

/** Tools that send bytes off-host even though they are reads. */
const EGRESS_READ_TOOLS = new Set(["web_fetch", "web_search", "npm_info"]);

const MCP_PREFIX = "mcp__";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hostOf(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** True when `p` (resolved against the workspace) stays inside it. */
export function isInsideWorkspace(workspaceRoot: string, p: string): boolean {
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) return false;
  const root = path.resolve(workspaceRoot);
  // A workspace of "/" confines nothing; never report it as confinement.
  if (root === path.parse(root).root) return false;
  const rel = path.relative(root, path.resolve(root, p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function writePaths(name: string, input: Record<string, unknown>): string[] | null {
  if (name === "apply_patch") {
    if (!Array.isArray(input.patches) || input.patches.length === 0) return null;
    const paths: string[] = [];
    for (const patch of input.patches) {
      const p = str(asRecord(patch).path);
      if (!p) return null;
      paths.push(p);
    }
    return paths;
  }
  const p = str(input.path);
  return p ? [p] : null;
}

/**
 * Verb tokens that only ever TIGHTEN an unlisted tool's category. Checked on
 * `_`/`-`-separated tokens of the tool name so `list_messages` is not a send.
 *
 * Every category here is one the default matrix never auto-allows. "exec" is
 * deliberately absent: unsandboxed exec is "auto" for the local owner, so
 * re-labelling an unknown `deploy_widget` as exec would LOOSEN it from a write
 * that asks to a call that runs.
 */
const VERB_CATEGORIES: Array<[ActionCategory, Set<string>]> = [
  ["purchase", new Set(["buy", "purchase", "pay", "checkout", "subscribe"])],
  ["credential", new Set(["password", "credential", "credentials", "otp", "login", "signin"])],
  ["delete", new Set(["delete", "remove", "destroy", "drop", "purge", "trash", "erase", "wipe"])],
  ["send", new Set(["send", "reply", "forward"])],
  ["publish", new Set(["post", "publish", "tweet", "share", "merge"])],
];

function categoryFromName(toolName: string): ActionCategory | undefined {
  const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const [category, verbs] of VERB_CATEGORIES) {
    if (tokens.some((token) => verbs.has(token))) return category;
  }
  return undefined;
}

const TARGET_KEYS = [
  "to",
  "cc",
  "bcc",
  "recipient",
  "recipients",
  "channel",
  "chat_id",
  "handle",
  "repo",
  "path",
  "file_path",
];
const URL_KEYS = ["url", "uri", "endpoint", "webhook", "host", "domain"];

/** Best-effort recipients / hosts / paths for a tool Warden has no table entry for. */
function genericTargets(input: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && value.length <= 320) out.add(value);
    else if (Array.isArray(value)) for (const item of value.slice(0, 16)) push(item);
  };
  for (const key of TARGET_KEYS) push(input[key]);
  for (const key of URL_KEYS) {
    const raw = input[key];
    const host = hostOf(raw);
    if (host) out.add(host);
    else push(raw);
  }
  return [...out].slice(0, 16);
}

const NETWORK_COMMAND =
  /(?:^|[\s;|&(`])(?:curl|wget|nc|ncat|ssh|scp|rsync|ftp|telnet)\b|\bgit\s+(?:clone|fetch|pull)\b|https?:\/\//;

function classifyMcp(
  name: string,
  input: Record<string, unknown>,
  tool: ToolDefinition | undefined,
  base: Classification,
): Classification {
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf("__");
  const server = sep > 0 ? rest.slice(0, sep) : rest;
  const toolPart = sep > 0 ? rest.slice(sep + 2) : "";
  const annotations = tool?.annotations;
  const openWorld = annotations?.openWorldHint !== false;
  // Annotations may lower a tool to "read" and nothing safer; a mutating verb
  // in the name overrides a readOnlyHint, because the hint is the server's
  // claim about itself.
  let category: ActionCategory = "write";
  if (annotations?.readOnlyHint === true) category = "read";
  if (annotations?.destructiveHint === true) category = "delete";
  const named = categoryFromName(toolPart);
  if (named) category = named;
  const targets = genericTargets(input);
  return {
    ...base,
    category,
    connector: server,
    method: toolPart || undefined,
    targets: targets.length > 0 ? targets : [`mcp:${server}`],
    egress: openWorld,
    taintSource: openWorld,
  };
}

/**
 * Classify one tool call. Pure and total: any name and any input (including
 * malformed input) yields a classification, and uncertainty always resolves to
 * the more restrictive reading.
 */
export function classifyToolCall(
  name: string,
  input: unknown,
  tool: ToolDefinition | undefined,
  ctx: ClassifyContext,
): Classification {
  const rec = asRecord(input);
  const base: Classification = {
    category: "write",
    targets: [],
    dataClasses: detectDataClasses(input, ctx.dataClassHints),
    sandboxed: false,
    withinWorkspace: false,
    egress: false,
    taintSource: TAINT_TOOLS.has(name),
  };
  const confined = ctx.sandboxMode !== "danger-full-access";

  if (name.startsWith(MCP_PREFIX)) return classifyMcp(name, rec, tool, base);

  if (name === "github") {
    const action = str(rec.action);
    const repo = str(rec.repo) ?? str(rec.cwd);
    const read = action !== undefined && GITHUB_READ_ACTIONS.has(action);
    return {
      ...base,
      category: read ? "read" : "publish",
      method: action,
      connector: "github",
      targets: repo ? [repo] : ["github"],
      egress: true,
    };
  }

  if (name === "takoapi") {
    const action = str(rec.action);
    const slug = str(rec.agent) ?? str(rec.slug);
    return {
      ...base,
      category: action === "discover" ? "read" : "network",
      method: action,
      connector: "takoapi",
      targets: [slug ? `takoapi:${slug}` : "takoapi"],
      egress: true,
    };
  }

  if (name === "mcp") {
    const action = str(rec.action);
    return {
      ...base,
      category: action === "list" ? "read" : "write",
      method: action,
      targets: ["mcp-config"],
    };
  }

  if (name === "memory" || name === "skill_manage") {
    const action = str(rec.action);
    const reads = name === "memory" ? ["read"] : ["list", "view"];
    return {
      ...base,
      category: action !== undefined && reads.includes(action) ? "read" : "self",
      method: action,
    };
  }

  if (name === "scheduled_dispatch") {
    const action = str(rec.action);
    return { ...base, category: action === "list" ? "read" : "exec", method: action };
  }

  if (READ_TOOLS.has(name)) {
    const host = name === "web_fetch" ? hostOf(rec.url) : undefined;
    return {
      ...base,
      category: "read",
      targets: host ? [host] : name === "web_fetch" ? ["web_fetch"] : [],
      egress: EGRESS_READ_TOOLS.has(name),
    };
  }

  if (SELF_TOOLS.has(name)) {
    const host = name === "kb_ingest" ? hostOf(rec.url) : undefined;
    return {
      ...base,
      category: "self",
      targets: host ? [host] : [],
      egress: name === "kb_ingest",
    };
  }

  if (DRAFT_TOOLS.has(name)) return { ...base, category: "draft" };

  if (WRITE_TOOLS.has(name)) {
    const paths = writePaths(name, rec);
    const within =
      paths !== null && paths.every((p) => isInsideWorkspace(ctx.workspaceRoot, p));
    return {
      ...base,
      category: "write",
      targets: paths ? paths.map((p) => path.resolve(ctx.workspaceRoot || "/", p)) : [],
      withinWorkspace: within,
      sandboxed: within && confined,
    };
  }

  if (EXEC_TOOLS.has(name)) {
    const command = str(rec.command);
    const targets = [str(rec.agent), str(rec.cwd)].filter(
      (value): value is string => value !== undefined,
    );
    return {
      ...base,
      category: "exec",
      targets,
      sandboxed: name === "bash" && confined,
      withinWorkspace: name === "bash",
      taintSource:
        base.taintSource ||
        (name === "bash" && command !== undefined && NETWORK_COMMAND.test(command)),
    };
  }

  // Unknown tool (plugin, executable skill, future builtin): a write that asks,
  // tightened further when its name carries a mutating verb.
  const targets = genericTargets(rec);
  return {
    ...base,
    category: categoryFromName(name) ?? "write",
    targets,
    egress: targets.length > 0,
  };
}

/** Every builtin name the table knows — used by the coverage test against the registry. */
export function isKnownBuiltin(name: string): boolean {
  return (
    READ_TOOLS.has(name) ||
    SELF_TOOLS.has(name) ||
    DRAFT_TOOLS.has(name) ||
    WRITE_TOOLS.has(name) ||
    EXEC_TOOLS.has(name) ||
    name === "github" ||
    name === "takoapi" ||
    name === "mcp"
  );
}
