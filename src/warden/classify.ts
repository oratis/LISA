/**
 * Tool-call classification — what KIND of effect a call has, on what, and
 * whether it is confined.
 *
 * This is an explicit table, not inference. A tool that is not in the table is
 * a "write" that asks: a new builtin, an executable skill or a plugin tool must
 * never become auto-allowed because nobody listed it. Tool annotations are
 * hints (src/types.ts): an annotation can only ever make a tool STRICTER, and
 * an MCP server never gets to classify itself as harmless.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "../types.js";
import type { SandboxMode } from "../sandbox/mode.js";
import { lisaGlobalHome } from "../paths.js";
import { isBroadWorkspace, isInsideReal, isSensitivePath, realPath } from "./paths.js";
import { detectDataClasses } from "./preview.js";
import type { ActionCategory, DataClass } from "./types.js";

export interface ClassifyContext {
  /** Absolute workspace root of the session (the turn's cwd). */
  workspaceRoot: string;
  sandboxMode: SandboxMode;
  /** Data classes asserted by the caller (e.g. a connector manifest). */
  dataClassHints?: DataClass[];
  /** MCP servers the USER marked trusted in their rules: their results do not taint. */
  trustedMcpServers?: readonly string[];
  /** Extra paths whose reads always ask (Warden state, provider keys). */
  sensitivePaths?: readonly string[];
  /** Home directory for credential locations and the broad-workspace check (tests). */
  homeDir?: string;
  /**
   * Lisa homes (the tenant's and the operator's): a workspace that contains
   * one is too broad to count as a sandbox. Default: the operator home.
   */
  lisaHomes?: readonly string[];
}

export interface Classification {
  category: ActionCategory;
  targets: string[];
  /** False when the destinations could not be enumerated completely. */
  targetsComplete: boolean;
  dataClasses: DataClass[];
  method?: string;
  connector?: string;
  /** The effect is confined by an OS-enforced sandbox to the workspace. */
  sandboxed: boolean;
  /** Every path the call touches resolves inside the workspace. */
  withinWorkspace: boolean;
  /** The call sends data off this host. */
  egress: boolean;
  /** For egress: is the destination an argument ("chosen") or the tool's own service ("fixed")? */
  destination?: "fixed" | "chosen";
  /** The exact destination URL, when the call has one. */
  url?: string;
  /** Completing the call brings untrusted external content into the agent run. */
  taintSource: boolean;
  /** A path the call touches is a credential location or Warden's own state. */
  sensitivePath: boolean;
  /** Input keys in the order the approval card shows them — never the model's order. */
  primaryKeys: string[];
}

/** Reads of a path on this machine. */
const PATH_READ_TOOLS = new Set(["read", "ls", "grep", "transcribe"]);

/** Other reads: no host path, no destination of the model's choosing. */
const READ_TOOLS = new Set([
  "task_list",
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
]);

/** Writes confined to Lisa's own home: soul, memory, kb, skills, desires, mood, voice output. */
const SELF_TOOLS = new Set([
  "task_cancel",
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

// Task edits always disable execution; the user must enable the reviewed draft.
const DRAFT_TOOLS = new Set(["social_compose", "task_create", "watch_create", "task_update"]);
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

/**
 * Builtins whose RESULT is text the user did not write: web pages, issue and PR
 * bodies, package metadata, other agents' transcripts, audio. Once one has run,
 * the run is tainted. (`read` / `kb_read` are deliberately absent — see
 * docs/DESIGN_WARDEN.md, known limits.)
 */
const TAINT_TOOLS = new Set([
  "web_fetch",
  "web_search",
  "kb_ingest",
  "takoapi",
  "task",
  "github",
  "pr_status",
  "npm_info",
  "dispatch_status",
  "inspect_agent",
  "agent_recap",
  "transcribe",
]);

/**
 * Is this builtin a taint source — does its result carry text the user did
 * not write? For hosts that track taint without a Warden session of their own
 * (the task runner records it on the run either way).
 */
export function isBuiltinTaintSource(name: string): boolean {
  return TAINT_TOOLS.has(name);
}

/** Reads that talk to a fixed service of the tool's own. */
const FIXED_EGRESS_READS = new Set(["web_search", "npm_info", "pr_status"]);

const MCP_PREFIX = "mcp__";

/** Card order for the builtins: what the call does first, then the rest. */
const PRIMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
  bash: ["command", "cwd"],
  write: ["path", "content"],
  edit: ["path", "old_string", "new_string"],
  apply_patch: ["patches"],
  github: ["action", "repo", "cwd", "number", "title", "body", "base", "merge_method"],
  web_fetch: ["url"],
  kb_ingest: ["url", "title"],
  takoapi: ["action", "agent", "slug", "text", "message", "query"],
  dispatch_agent: ["agent", "cwd", "task", "prompt"],
  run_on_plan: ["agent", "cwd", "plan"],
  task: ["type", "description", "prompt"],
  read: ["path"],
  ls: ["path"],
  grep: ["path", "pattern", "glob"],
  skill_manage: ["action", "name", "slug"],
  mcp: ["action", "name", "command", "args", "url"],
};

/** Card order for tools the table does not know: where it goes, then what it says. */
const GENERIC_PRIMARY = [
  "url",
  "uri",
  "endpoint",
  "webhook",
  "host",
  "domain",
  "to",
  "cc",
  "bcc",
  "recipient",
  "recipients",
  "channel",
  "channel_id",
  "chat_id",
  "handle",
  "repo",
  "path",
  "file_path",
  "command",
  "action",
  "subject",
  "title",
  "body",
  "text",
  "message",
  "content",
];

function primaryKeysFor(name: string, input: Record<string, unknown>): string[] {
  const preferred = Object.hasOwn(PRIMARY_KEYS, name) ? PRIMARY_KEYS[name]! : GENERIC_PRIMARY;
  return preferred.filter((key) => Object.hasOwn(input, key));
}

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

/** True when `p` (resolved against the workspace, through symlinks) stays inside it. */
export function isInsideWorkspace(workspaceRoot: string, p: string): boolean {
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) return false;
  const root = path.resolve(workspaceRoot);
  // A workspace of "/" confines nothing; never report it as confinement.
  if (root === path.parse(root).root) return false;
  return isInsideReal(root, path.resolve(root, p));
}

/** The file the call will actually touch: resolved against the workspace and through symlinks. */
function resolveTarget(workspaceRoot: string, p: string): string {
  return realPath(path.resolve(workspaceRoot || "/", p));
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

// ── tool-name vocabulary ─────────────────────────────────────────────────

/** `sendMessage`, `create_payment`, `mcp-x.runSQL` → ["send","message"], … lower-cased. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A token and its singular form (`orders` → `order`, `keys` → `key`). */
function forms(token: string): string[] {
  return token.length > 3 && token.endsWith("s") ? [token, token.slice(0, -1)] : [token];
}

function hasAny(tokens: string[], vocabulary: ReadonlySet<string>): boolean {
  return tokens.some((token) => forms(token).some((form) => vocabulary.has(form)));
}

const CREDENTIAL_WORDS = new Set([
  "password",
  "passwd",
  "passcode",
  "passphrase",
  "credential",
  "secret",
  "token",
  "key",
  "apikey",
  "otp",
  "totp",
  "mfa",
  "login",
  "signin",
]);
const PURCHASE_WORDS = new Set([
  "pay",
  "payment",
  "purchase",
  "buy",
  "order",
  "checkout",
  "charge",
  "transfer",
  "refund",
  "subscribe",
  "subscription",
  "donate",
  "withdraw",
  "deposit",
]);
const DELETE_WORDS = new Set([
  "delete",
  "remove",
  "destroy",
  "drop",
  "purge",
  "trash",
  "erase",
  "wipe",
  "clear",
  "truncate",
  "revoke",
  "uninstall",
  "unlink",
]);
const SEND_WORDS = new Set(["send", "reply", "forward", "invite", "notify", "sms", "dm"]);
const PUBLISH_WORDS = new Set([
  "post",
  "publish",
  "tweet",
  "share",
  "merge",
  "release",
  "announce",
]);
/** Any other verb that changes something. Its presence means "not a read". */
const MUTATE_WORDS = new Set([
  "create",
  "update",
  "write",
  "upload",
  "run",
  "exec",
  "execute",
  "eval",
  "set",
  "add",
  "insert",
  "put",
  "patch",
  "edit",
  "modify",
  "move",
  "rename",
  "copy",
  "save",
  "import",
  "sync",
  "start",
  "stop",
  "restart",
  "kill",
  "cancel",
  "close",
  "approve",
  "reject",
  "archive",
  "assign",
  "apply",
  "install",
  "enable",
  "disable",
  "register",
  "book",
  "schedule",
  "submit",
  "sql",
  "shell",
  "spawn",
  "deploy",
  "comment",
  "place",
  "make",
  "generate",
  "append",
  "replace",
  "reset",
  "grant",
  "lock",
  "unlock",
  "mark",
  "star",
  "follow",
  "join",
  "leave",
  "open",
  "click",
  "type",
  "fill",
  "navigate",
]);
/** A name must contain one of these before a readOnlyHint is believed. */
const READ_WORDS = new Set([
  "get",
  "list",
  "search",
  "read",
  "view",
  "fetch",
  "find",
  "show",
  "describe",
  "count",
  "check",
  "lookup",
  "query",
  "retrieve",
  "status",
  "info",
  "inspect",
  "summarize",
  "analyze",
  "estimate",
  "preview",
  "browse",
  "resolve",
  "whoami",
  "ping",
  "health",
  "calc",
  "calculate",
  "convert",
  "parse",
  "validate",
]);
/** Words that make a credential NOUN harmless (`count_tokens`). */
const MEASURE_WORDS = new Set(["count", "estimate"]);
/**
 * Words that are as often a noun as a verb (`list_releases`, `get_post`,
 * `get_order`). In a name that also carries a read verb, on a tool that claims
 * to be read-only, they are read as nouns.
 */
const NOUN_OR_VERB = new Set([
  "post",
  "release",
  "comment",
  "schedule",
  "patch",
  "order",
  "payment",
  "subscription",
  "deposit",
  "sql",
  "shell",
]);

/**
 * The category a tool NAME implies, or undefined when it implies nothing.
 * Every category returned here is one the default matrix never auto-allows.
 * "exec" is deliberately absent — an unknown `deploy_widget` re-labelled as
 * exec would be easier to allow than the write-that-asks it already is.
 */
function categoryFromName(toolName: string, claimsReadOnly: boolean): ActionCategory | undefined {
  const all = nameTokens(toolName);
  if (hasAny(all, CREDENTIAL_WORDS) && !hasAny(all, MEASURE_WORDS)) return "credential";
  // `get_order`, `list_releases`: with a read verb in the name and a
  // read-only claim, the ambiguous words are nouns. Without both, they are
  // verbs — `place_order` and `create_payment` are never lookups.
  const lookup = claimsReadOnly && hasAny(all, READ_WORDS);
  const tokens = lookup
    ? all.filter((token) => !forms(token).some((form) => NOUN_OR_VERB.has(form)))
    : all;
  if (hasAny(tokens, PURCHASE_WORDS)) return "purchase";
  if (hasAny(tokens, DELETE_WORDS)) return "delete";
  if (hasAny(tokens, SEND_WORDS)) return "send";
  if (hasAny(tokens, PUBLISH_WORDS)) return "publish";
  if (hasAny(tokens, MUTATE_WORDS)) return "write";
  return undefined;
}

/** May a readOnlyHint be believed for this name? Only for a plain lookup. */
function nameReadsOnly(toolName: string): boolean {
  const tokens = nameTokens(toolName);
  return hasAny(tokens, READ_WORDS) && categoryFromName(toolName, true) === undefined;
}

// ── destinations of tools the table does not know ────────────────────────

const RECIPIENT_KEYS = new Set([
  "to",
  "cc",
  "bcc",
  "recipient",
  "recipients",
  "channel",
  "channel_id",
  "chat_id",
  "handle",
  "repo",
  "repository",
  "path",
  "file_path",
]);
const URL_KEYS = new Set(["url", "uri", "endpoint", "webhook", "host", "domain"]);
/** Keys that are known NOT to name a destination. */
const CONTENT_KEYS = new Set([
  "subject",
  "title",
  "body",
  "text",
  "message",
  "content",
  "html",
  "markdown",
  "description",
  "summary",
  "note",
  "query",
  "q",
  "limit",
  "offset",
  "page",
  "cursor",
  "format",
  "max_results",
  "action",
  "command",
  "name",
  "id",
  "number",
  "state",
  "sort",
  "order",
  "tags",
  "labels",
  "language",
]);
const MAX_TARGETS = 16;

interface Destinations {
  targets: string[];
  /** Every destination was enumerated: no unknown key, nothing nested, nothing dropped. */
  complete: boolean;
  /** The single URL argument, when there is exactly one. */
  url?: string;
}

/**
 * Recipients / hosts / paths of a call the table has no entry for. Fails
 * toward "incomplete": a list that is too long, a nested value, or a key this
 * function does not recognise means a target grant can never cover the call.
 */
function genericDestinations(input: Record<string, unknown>): Destinations {
  const out = new Set<string>();
  const urls: string[] = [];
  let complete = true;
  const take = (value: unknown, asUrl: boolean): void => {
    const one = (item: unknown) => {
      if (typeof item !== "string" || item.length === 0 || item.length > 320) {
        complete = false;
        return;
      }
      if (asUrl) {
        urls.push(item);
        out.add(hostOf(item) ?? item);
      } else {
        out.add(item);
      }
    };
    if (Array.isArray(value)) {
      if (value.length > MAX_TARGETS) complete = false;
      for (const item of value.slice(0, MAX_TARGETS)) one(item);
    } else {
      one(value);
    }
  };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const lower = key.toLowerCase();
    if (RECIPIENT_KEYS.has(lower)) take(value, false);
    else if (URL_KEYS.has(lower)) take(value, true);
    else if (!CONTENT_KEYS.has(lower)) complete = false;
    else if (typeof value === "object") complete = false;
  }
  return {
    targets: [...out],
    complete: complete && out.size > 0,
    url: urls.length === 1 ? urls[0] : undefined,
  };
}

// ── paths in the arguments of tools the table does not know ─────────────

/** Free text: a value under one of these keys says something, it does not name a location. */
const FREE_TEXT_KEYS = new Set([
  "subject",
  "title",
  "body",
  "text",
  "message",
  "content",
  "html",
  "markdown",
  "description",
  "summary",
  "note",
  "query",
  "q",
]);
/** A tool (or its server) whose name says it works on files: its relative paths are paths too. */
const FILESYSTEM_WORDS = new Set([
  "file",
  "fs",
  "filesystem",
  "dir",
  "directory",
  "folder",
  "path",
]);
/** Keys that name a location, on a filesystem tool. */
const PATH_KEY_WORDS = new Set([
  "path",
  "file",
  "filename",
  "filepath",
  "dir",
  "directory",
  "folder",
  "source",
  "src",
  "destination",
  "dest",
  "target",
  "from",
  "to",
  "root",
  "location",
  "cwd",
]);
const MAX_PATH_SCAN = { strings: 256, depth: 8, length: 4096 };

interface PathArguments {
  /** Every location the arguments name, resolved through symlinks. */
  paths: string[];
  /** The argument strings those came from (so they are not listed twice). */
  raw: Set<string>;
  /** The input was too large or too deep to look at whole. */
  truncated: boolean;
}

/** Does this tool, by its name, its server's or its title, work on files? */
function isFilesystemTool(...names: (string | undefined)[]): boolean {
  return names.some((name) => name !== undefined && hasAny(nameTokens(name), FILESYSTEM_WORDS));
}

/**
 * Every path an argument names, at any depth of the input (bounded): an
 * absolute path, `~` or `~/…`, a `file:` URL — whatever the key is called
 * (`destination`, `filePath`, `target`, an array of them) — and, on a
 * filesystem tool, a relative path under a key that names a location. A path
 * hidden in free text (`content`, `body`) is not a location. #422 review
 * NEW-3: only `path` / `file_path` used to count, so a move's `destination`
 * never met the checks a builtin write meets.
 */
function pathArguments(
  input: Record<string, unknown>,
  opts: { filesystem: boolean; workspaceRoot: string; homeDir?: string },
): PathArguments {
  const home = opts.homeDir ?? os.homedir();
  const paths = new Set<string>();
  const raw = new Set<string>();
  let scanned = 0;
  let truncated = false;
  const locate = (given: string, pathKey: boolean): string | undefined => {
    // As a server would most likely read it: surrounding whitespace is not part of a path.
    const value = given.trim();
    if (!value) return undefined;
    if (value.length > MAX_PATH_SCAN.length) {
      // Too long to be a path a filesystem takes; one that starts like a path is not looked at.
      if (/^(?:[/~]|file:)/i.test(value)) truncated = true;
      return undefined;
    }
    if (value === "~" || value.startsWith("~/")) return path.join(home, value.slice(2));
    if (/^file:/i.test(value)) {
      try {
        return fileURLToPath(new URL(value));
      } catch {
        // A file: URL that does not parse still names a file: count it as one.
        return path.resolve(opts.workspaceRoot || "/", value.replace(/^file:(\/\/)?/i, ""));
      }
    }
    if (path.isAbsolute(value)) return value;
    if (opts.filesystem && pathKey) return path.resolve(opts.workspaceRoot || "/", value);
    return undefined;
  };
  const visit = (value: unknown, pathKey: boolean, depth: number): void => {
    if (truncated) return;
    if (typeof value === "string") {
      if (++scanned > MAX_PATH_SCAN.strings) {
        truncated = true;
        return;
      }
      const located = locate(value, pathKey);
      if (located !== undefined) {
        paths.add(realPath(located));
        raw.add(value);
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (depth >= MAX_PATH_SCAN.depth) {
      truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, pathKey, depth + 1);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      if (FREE_TEXT_KEYS.has(childKey.toLowerCase())) continue;
      visit(child, hasAny(nameTokens(childKey), PATH_KEY_WORDS), depth + 1);
    }
  };
  visit(input, false, 0);
  return { paths: [...paths], raw, truncated };
}

const FETCHER =
  "curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|ftp|telnet|gh|glab|aria2c|httpie|http|https|xh|lynx|w3m|links|npx|bunx|pnpx|uvx|pipx";
const PACKAGE_MANAGER =
  "npm|pnpm|yarn|bun|bunx|npx|pip|pip3|pipx|uv|poetry|brew|gem|bundle|cargo|go|apt|apt-get|dnf|yum|pacman|docker|podman|composer|nuget|dotnet";

/**
 * Does a shell command pull content from the network? BEST EFFORT — a string
 * match cannot see through a variable, an alias or an encoded payload. It
 * exists so the common cases taint the run, not as a guarantee.
 */
const NETWORK_COMMAND = new RegExp(
  [
    `(?:^|[\\s;|&(\`$/"'=])(?:${FETCHER})(?=$|[\\s;|&)"'\`])`,
    "\\bgit\\s+(?:clone|fetch|pull|ls-remote|submodule|remote)\\b",
    `(?:^|[\\s;|&(\`/])(?:${PACKAGE_MANAGER})\\s+(?:install|i|add|get|pull|run|x|dlx|exec|create|update|upgrade|fetch|download|search|view|info|show)\\b`,
    "\\b(?:https?|ftp|wss?|git|ssh):\\/\\/",
    "\\burllib\\b|\\brequests\\.|\\bhttpx\\b|\\baiohttp\\b|\\bhttp\\.client\\b|\\bsocket\\b",
    "\\bfetch\\s*\\(|\\bXMLHttpRequest\\b|\\bnet\\.(?:connect|Socket)\\b|require\\(['\"](?:https?|net)['\"]\\)",
    "Invoke-WebRequest|Invoke-RestMethod|\\/dev\\/tcp\\/|\\bopen-uri\\b|Net::HTTP|LWP::",
  ].join("|"),
  "i",
);

/** Exported for tests: the bash network heuristic. */
export function looksLikeNetworkCommand(command: string): boolean {
  return NETWORK_COMMAND.test(command);
}

/**
 * The targets of a call the table has no entry for: its recipients and hosts,
 * and every path its arguments name (resolved, in place of the string that
 * named it). `sensitive` when one of those paths is a credential location or
 * Warden's state — or the input was too large to look at whole, so one could
 * hide there.
 */
function locatedTargets(
  input: Record<string, unknown>,
  destinations: Destinations,
  filesystem: boolean,
  ctx: ClassifyContext,
): { targets: string[]; truncated: boolean; sensitive: boolean } {
  const found = pathArguments(input, {
    filesystem,
    workspaceRoot: ctx.workspaceRoot,
    ...(ctx.homeDir !== undefined ? { homeDir: ctx.homeDir } : {}),
  });
  const targets = [
    ...new Set([
      ...destinations.targets.filter((target) => !found.raw.has(target)),
      ...found.paths,
    ]),
  ];
  return {
    targets,
    truncated: found.truncated,
    sensitive:
      found.truncated ||
      found.paths.some((p) => isSensitivePath(p, ctx.sensitivePaths, ctx.homeDir)),
  };
}

function classifyMcp(
  name: string,
  input: Record<string, unknown>,
  tool: ToolDefinition | undefined,
  base: Classification,
  ctx: ClassifyContext,
): Classification {
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf("__");
  const server = sep > 0 ? rest.slice(0, sep) : rest;
  const toolPart = sep > 0 ? rest.slice(sep + 2) : "";
  const annotations = tool?.annotations;
  const claimsReadOnly = annotations?.readOnlyHint === true;
  // An annotation only ever makes a tool stricter. The one thing a
  // readOnlyHint can do is confirm what the NAME already says: a server that
  // labels `sendMessage` or `transfer_funds` read-only is not believed.
  let category: ActionCategory =
    categoryFromName(toolPart, claimsReadOnly) ??
    (claimsReadOnly && nameReadsOnly(toolPart) ? "read" : "write");
  if (annotations?.destructiveHint === true && (category === "read" || category === "write")) {
    category = "delete";
  }
  const destinations = genericDestinations(input);
  const located = locatedTargets(
    input,
    destinations,
    isFilesystemTool(server, toolPart, annotations?.title),
    ctx,
  );
  const trusted = ctx.trustedMcpServers?.includes(server) === true;
  return {
    ...base,
    category,
    connector: server,
    method: toolPart || undefined,
    targets: located.targets.length > 0 ? located.targets : [`mcp:${server}`],
    targetsComplete: destinations.complete && !located.truncated,
    // The same checks a builtin file tool meets: a credential location or
    // Warden's state asks to read (and the task files and Warden's state are
    // guarded against writes, policy.ts), whatever the server is.
    sensitivePath: located.sensitive,
    // Whatever the server says about itself, the call leaves this host for a
    // destination its arguments pick, and its result is text nobody vetted —
    // unless the USER marked the server trusted.
    egress: true,
    destination: trusted ? "fixed" : "chosen",
    url: destinations.url,
    taintSource: !trusted,
  };
}

/**
 * Classify one tool call. Total: any name and any input (including malformed
 * input) yields a classification, and uncertainty always resolves to the more
 * restrictive reading.
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
    targetsComplete: true,
    dataClasses: detectDataClasses(input, ctx.dataClassHints),
    sandboxed: false,
    withinWorkspace: false,
    egress: false,
    taintSource: TAINT_TOOLS.has(name),
    sensitivePath: false,
    primaryKeys: primaryKeysFor(name, rec),
  };
  // A bounded mode confines writes to the workspace — which means nothing when
  // the workspace is "/", the user's home or a directory holding the Lisa home.
  const confined =
    ctx.sandboxMode !== "danger-full-access" &&
    !isBroadWorkspace(ctx.workspaceRoot, {
      ...(ctx.homeDir !== undefined ? { homeDir: ctx.homeDir } : {}),
      lisaHomes: ctx.lisaHomes ?? [lisaGlobalHome()],
    });
  const sensitive = (p: string) => isSensitivePath(p, ctx.sensitivePaths, ctx.homeDir);

  if (name.startsWith(MCP_PREFIX)) return classifyMcp(name, rec, tool, base, ctx);

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
      destination: "fixed",
    };
  }

  if (name === "takoapi") {
    const action = str(rec.action);
    const slug = str(rec.agent) ?? str(rec.slug);
    const discover = action === "discover";
    return {
      ...base,
      category: discover ? "read" : "network",
      method: action,
      connector: "takoapi",
      targets: [slug ? `takoapi:${slug}` : "takoapi"],
      egress: true,
      // Discovery queries the registry; a call sends text to an agent the
      // model picked.
      destination: discover ? "fixed" : "chosen",
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

  if (PATH_READ_TOOLS.has(name)) {
    const target = resolveTarget(ctx.workspaceRoot, str(rec.path) ?? ".");
    return {
      ...base,
      category: "read",
      targets: [target],
      withinWorkspace: isInsideWorkspace(ctx.workspaceRoot, target),
      sensitivePath: sensitive(target),
    };
  }

  if (READ_TOOLS.has(name)) {
    if (name === "web_fetch") {
      const url = str(rec.url);
      const host = hostOf(url);
      return {
        ...base,
        category: "read",
        targets: [host ?? "web_fetch"],
        targetsComplete: host !== undefined,
        egress: true,
        destination: "chosen",
        url,
      };
    }
    if (name === "github_link") {
      // `open: true` launches the browser at a URL built from the repo's
      // remote: an off-host request to wherever that remote points.
      const opens = rec.open === true;
      const cwd = str(rec.cwd);
      return {
        ...base,
        category: "read",
        targets: cwd ? [cwd] : [],
        targetsComplete: false,
        egress: opens,
        destination: opens ? "chosen" : undefined,
      };
    }
    if (name === "review_diff") {
      const viaGitHub = typeof rec.pr === "number";
      return {
        ...base,
        category: "read",
        egress: viaGitHub,
        destination: viaGitHub ? "fixed" : undefined,
        // A PR diff is text somebody else wrote.
        taintSource: viaGitHub,
      };
    }
    const fixed = FIXED_EGRESS_READS.has(name);
    return { ...base, category: "read", egress: fixed, destination: fixed ? "fixed" : undefined };
  }

  if (SELF_TOOLS.has(name)) {
    if (name === "kb_ingest") {
      const url = str(rec.url);
      const host = hostOf(url);
      return {
        ...base,
        category: "self",
        targets: host ? [host] : ["kb_ingest"],
        targetsComplete: host !== undefined,
        egress: true,
        destination: "chosen",
        url,
      };
    }
    return { ...base, category: "self" };
  }

  if (DRAFT_TOOLS.has(name)) return { ...base, category: "draft" };

  if (WRITE_TOOLS.has(name)) {
    const paths = writePaths(name, rec);
    const targets = paths ? paths.map((p) => resolveTarget(ctx.workspaceRoot, p)) : [];
    const within =
      paths !== null && targets.every((target) => isInsideWorkspace(ctx.workspaceRoot, target));
    const deletes =
      name === "apply_patch" &&
      Array.isArray(rec.patches) &&
      rec.patches.some((patch) => asRecord(patch).action === "delete");
    return {
      ...base,
      category: deletes ? "delete" : "write",
      targets,
      targetsComplete: paths !== null,
      withinWorkspace: within,
      sandboxed: within && confined,
      sensitivePath: targets.some(sensitive),
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
      // What a command touches cannot be enumerated from its text.
      targetsComplete: false,
      sandboxed: name === "bash" && confined,
      withinWorkspace: name === "bash",
      taintSource:
        base.taintSource ||
        (name === "bash" && command !== undefined && looksLikeNetworkCommand(command)),
    };
  }

  // Unknown tool (plugin, executable skill, future builtin): a write that asks,
  // tightened further when its name carries a mutating verb. Never a read.
  const destinations = genericDestinations(rec);
  const located = locatedTargets(rec, destinations, isFilesystemTool(name), ctx);
  const named = categoryFromName(name, false);
  return {
    ...base,
    category: named ?? "write",
    targets: located.targets,
    targetsComplete: destinations.complete && !located.truncated,
    sensitivePath: located.sensitive,
    egress: destinations.targets.length > 0,
    destination: destinations.targets.length > 0 ? "chosen" : undefined,
    url: destinations.url,
    // Nobody vetted what an unlisted tool returns.
    taintSource: true,
  };
}

/** Every builtin name the table knows — used by the coverage test against the registry. */
export function isKnownBuiltin(name: string): boolean {
  return (
    PATH_READ_TOOLS.has(name) ||
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
