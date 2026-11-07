/**
 * User rules — per-category behaviour with optional per-tool and per-target
 * overrides, persisted at `<home>/warden/rules.json`.
 *
 * Rules are layered UNDER the system invariants (policy.ts): they can tighten
 * anything, and loosen only what the invariants leave open. A corrupt or
 * unreadable file never degrades to "allow": it falls back to the built-in
 * defaults (no user rules at all) and is reported.
 *
 * Origin scoping: a rule that LOOSENS (`auto`, or anything below the default
 * it replaces) applies to the attended chat only, unless `origins` names the
 * task origin for it — `tools.bash = auto` written for chat must not let every
 * unattended routine run the shell. A rule that tightens applies everywhere.
 */
import path from "node:path";
import { withFileLock } from "../soul/lock.js";
import { logWarn } from "../log.js";
import { readJsonState, wardenDir, writeJsonAtomic } from "./store.js";
import {
  ACTION_CATEGORIES,
  isActionCategory,
  isRuleBehavior,
  type ActionCategory,
  type RuleBehavior,
} from "./types.js";

export const RULES_VERSION = 1;
const MAX_OVERRIDES = 500;

/** Where a loosening rule applies: the attended chat, unattended task runs, or both. */
export const RULE_ORIGINS = ["chat", "task"] as const;
export type RuleOrigin = (typeof RULE_ORIGINS)[number];
/** Where a loosening rule applies when `origins` says nothing about it. */
export const DEFAULT_RULE_ORIGINS: readonly RuleOrigin[] = ["chat"];

export interface RuleOriginScopes {
  categories?: Partial<Record<ActionCategory, RuleOrigin[]>>;
  tools?: Record<string, RuleOrigin[]>;
  targets?: Record<string, RuleOrigin[]>;
}

export interface WardenRules {
  version: typeof RULES_VERSION;
  /** Behaviour per category. Absent = the built-in default matrix. */
  categories: Partial<Record<ActionCategory, RuleBehavior>>;
  /** Per-tool overrides (exact tool name). Win over the category rule. */
  tools: Record<string, RuleBehavior>;
  /** Per-target overrides (exact recipient / host / path). Win over tool and category. */
  targets: Record<string, RuleBehavior>;
  /**
   * MCP servers whose results the USER vouches for. Every other `mcp__*`
   * result taints the run, whatever the server says about itself.
   */
  trustedMcpServers: string[];
  /**
   * Where each LOOSENING rule applies, by the rule's map and key — e.g.
   * `{ tools: { bash: ["chat", "task"] } }`. A loosening rule not listed here
   * applies to the chat only (`DEFAULT_RULE_ORIGINS`); tightening rules apply
   * to every origin whatever this says. Every entry must name an existing rule.
   */
  origins?: RuleOriginScopes;
  updatedAt?: string;
}

/** Categories whose behaviour is a system invariant, not a preference. */
export const LOCKED_CATEGORIES: Partial<Record<ActionCategory, RuleBehavior>> = {
  purchase: "handoff",
  credential: "handoff",
};

export function defaultRules(): WardenRules {
  return { version: RULES_VERSION, categories: {}, tools: {}, targets: {}, trustedMcpServers: [] };
}

export class RulesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesValidationError";
  }
}

function behaviorMap(
  value: unknown,
  label: string,
  keyOk: (key: string) => boolean,
): Record<string, RuleBehavior> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RulesValidationError(`${label} must be an object`);
  }
  const out: Array<[string, RuleBehavior]> = [];
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_OVERRIDES) {
    throw new RulesValidationError(`${label} has too many entries (max ${MAX_OVERRIDES})`);
  }
  for (const [key, behavior] of entries) {
    if (!key || key.length > 512 || !keyOk(key)) {
      throw new RulesValidationError(`${label}: unknown or invalid key "${key.slice(0, 64)}"`);
    }
    if (!isRuleBehavior(behavior)) {
      throw new RulesValidationError(`${label}.${key.slice(0, 64)}: invalid behavior`);
    }
    out.push([key, behavior]);
  }
  // fromEntries defines OWN properties, so a key such as "__proto__" is stored
  // as data instead of being swallowed by the prototype setter.
  return Object.fromEntries(out);
}

/**
 * Own-property lookup that only ever yields one of the four behaviours.
 *
 * Tool names, targets and categories are model- or file-supplied strings.
 * Indexing a plain object with them (`rules.targets[target]`) finds
 * `Object.prototype` members for names like "constructor" or "toString"; this
 * is the only way rule maps are read.
 */
export function ownBehavior(
  map: Readonly<Record<string, unknown>> | undefined,
  key: string,
): RuleBehavior | undefined {
  if (!map || typeof key !== "string" || !Object.hasOwn(map, key)) return undefined;
  const value = map[key];
  return isRuleBehavior(value) ? value : undefined;
}

function serverList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_OVERRIDES) {
    throw new RulesValidationError("trustedMcpServers must be a list of server names");
  }
  for (const name of value) {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
      throw new RulesValidationError("trustedMcpServers: invalid server name");
    }
  }
  return [...new Set(value as string[])];
}

function originList(value: unknown, label: string): RuleOrigin[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new RulesValidationError(
      `${label} must be a non-empty list of: ${RULE_ORIGINS.join(", ")}`,
    );
  }
  for (const origin of value) {
    if (typeof origin !== "string" || !(RULE_ORIGINS as readonly string[]).includes(origin)) {
      throw new RulesValidationError(`${label}: unknown origin (use ${RULE_ORIGINS.join(", ")})`);
    }
  }
  return [...new Set(value as RuleOrigin[])];
}

function parseOrigins(
  value: unknown,
  rules: Pick<WardenRules, "categories" | "tools" | "targets">,
): RuleOriginScopes | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RulesValidationError("origins must be an object");
  }
  const doc = value as Record<string, unknown>;
  const out: RuleOriginScopes = {};
  for (const key of Object.keys(doc)) {
    if (key !== "categories" && key !== "tools" && key !== "targets") {
      throw new RulesValidationError(`origins: unknown key "${key.slice(0, 64)}"`);
    }
    const scopes = doc[key];
    if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) {
      throw new RulesValidationError(`origins.${key} must be an object`);
    }
    const entries = Object.entries(scopes as Record<string, unknown>);
    if (entries.length > MAX_OVERRIDES) {
      throw new RulesValidationError(`origins.${key} has too many entries (max ${MAX_OVERRIDES})`);
    }
    const map = rules[key] as Readonly<Record<string, unknown>>;
    const parsed: Array<[string, RuleOrigin[]]> = [];
    for (const [name, origins] of entries) {
      // An origin scope for a rule that does not exist is a typo, not a no-op.
      if (ownBehavior(map, name) === undefined) {
        throw new RulesValidationError(`origins.${key}.${name.slice(0, 64)} names no rule`);
      }
      parsed.push([name, originList(origins, `origins.${key}.${name.slice(0, 64)}`)]);
    }
    if (parsed.length > 0) out[key] = Object.fromEntries(parsed);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Own-property lookup of a rule's origin scope; only ever a list of known origins. */
export function ownOrigins(
  map: Readonly<Record<string, unknown>> | undefined,
  key: string,
): readonly RuleOrigin[] | undefined {
  if (!map || typeof key !== "string" || !Object.hasOwn(map, key)) return undefined;
  const value = map[key];
  if (!Array.isArray(value)) return undefined;
  const origins = value.filter((o): o is RuleOrigin =>
    (RULE_ORIGINS as readonly unknown[]).includes(o),
  );
  return origins.length > 0 ? origins : undefined;
}

/**
 * Validate an untrusted rules document. Strict: an unknown category, an unknown
 * behaviour or an attempt to loosen a locked category rejects the WHOLE
 * document — a half-applied rule set is not something to guess at.
 */
export function parseRules(value: unknown): WardenRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RulesValidationError("rules must be an object");
  }
  const doc = value as Record<string, unknown>;
  if (doc.version !== undefined && doc.version !== RULES_VERSION) {
    throw new RulesValidationError(`unsupported rules version ${String(doc.version)}`);
  }
  const categories = behaviorMap(doc.categories, "categories", isActionCategory) as Partial<
    Record<ActionCategory, RuleBehavior>
  >;
  for (const [category, locked] of Object.entries(LOCKED_CATEGORIES)) {
    const set = ownBehavior(categories, category);
    if (set !== undefined && set !== locked) {
      throw new RulesValidationError(
        `categories.${category} is fixed to "${locked}" and cannot be changed`,
      );
    }
  }
  const tools = behaviorMap(doc.tools, "tools", () => true);
  const targets = behaviorMap(doc.targets, "targets", () => true);
  const origins = parseOrigins(doc.origins, { categories, tools, targets });
  return {
    version: RULES_VERSION,
    categories,
    tools,
    targets,
    trustedMcpServers: serverList(doc.trustedMcpServers),
    ...(origins ? { origins } : {}),
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : undefined,
  };
}

export function rulesFile(home?: string): string {
  return path.join(wardenDir(home), "rules.json");
}

export interface LoadedRules {
  rules: WardenRules;
  /** True when the file existed but could not be trusted; `rules` is then the built-in default. */
  corrupt: boolean;
}

/** Load the user rules. Corrupt ⇒ built-in defaults (never "allow"), flagged and logged. */
export async function loadRules(home?: string): Promise<LoadedRules> {
  const file = rulesFile(home);
  const read = await readJsonState(file, (value) => {
    try {
      return parseRules(value);
    } catch {
      return null;
    }
  });
  if (read.state === "ok") return { rules: read.value, corrupt: false };
  if (read.state === "corrupt") {
    logWarn(`[warden] rules.json is corrupt (${read.error}); using built-in defaults`);
    return { rules: defaultRules(), corrupt: true };
  }
  return { rules: defaultRules(), corrupt: false };
}

/** Replace the user rules. Validates first; throws RulesValidationError on a bad document. */
export async function saveRules(value: unknown, home?: string): Promise<WardenRules> {
  const rules = { ...parseRules(value), updatedAt: new Date().toISOString() };
  const file = rulesFile(home);
  await withFileLock(`${file}.lock`, async () => {
    await writeJsonAtomic(file, rules);
  });
  return rules;
}

/** Set one category's behaviour (CLI `lisa warden rules set`). */
export async function setCategoryRule(
  category: ActionCategory,
  behavior: RuleBehavior,
  home?: string,
): Promise<WardenRules> {
  const { rules, corrupt } = await loadRules(home);
  if (corrupt) {
    throw new RulesValidationError("rules.json is corrupt; fix or delete it before changing rules");
  }
  return await saveRules(
    { ...rules, categories: { ...rules.categories, [category]: behavior } },
    home,
  );
}

export interface MatchedRule {
  behavior: RuleBehavior;
  ruleId: string;
  /** Where the rule applies when it loosens (`origins`); absent ⇒ DEFAULT_RULE_ORIGINS. */
  origins?: readonly RuleOrigin[];
}

export interface RuleMatch {
  /** The tool rule, else the category rule. */
  base?: MatchedRule;
  /** The stricter of the tool rule and the category rule. */
  strictBase?: MatchedRule;
  /** The strictest rule among the request's targets that have one. */
  target?: MatchedRule;
  /** Every target of the request has a rule, and the target list is complete. */
  targetsCovered: boolean;
}

type RuleSubject = {
  tool: string;
  category: ActionCategory;
  targets: string[];
  targetsComplete?: boolean;
};

/**
 * Every explicit user rule that bears on a request. `admit` drops rules that
 * do not apply to the request's origin (policy.ts: a loosening rule not scoped
 * to it); a dropped target rule leaves its target uncovered.
 */
export function matchRules(
  rules: WardenRules,
  req: RuleSubject,
  admit: (rule: MatchedRule) => boolean = () => true,
): RuleMatch {
  const scoped = (
    map: "categories" | "tools" | "targets",
    key: string,
    behavior: RuleBehavior | undefined,
    ruleId: string,
  ): MatchedRule | undefined => {
    if (behavior === undefined) return undefined;
    const origins = ownOrigins(rules.origins?.[map], key);
    const rule: MatchedRule = { behavior, ruleId, ...(origins ? { origins } : {}) };
    return admit(rule) ? rule : undefined;
  };
  let target: MatchedRule | undefined;
  let covered = req.targets.length > 0 && req.targetsComplete !== false;
  for (const name of req.targets) {
    const rule = scoped(
      "targets",
      name,
      ownBehavior(rules.targets, name),
      `rule:target:${name.slice(0, 80)}`,
    );
    if (rule === undefined) {
      covered = false;
      continue;
    }
    if (!target || strictness(rule.behavior) > strictness(target.behavior)) target = rule;
  }
  const tool = scoped(
    "tools",
    req.tool,
    ownBehavior(rules.tools, req.tool),
    `rule:tool:${req.tool}`,
  );
  const category = scoped(
    "categories",
    req.category,
    ownBehavior(rules.categories, req.category),
    `rule:category:${req.category}`,
  );
  const base = tool || category || undefined;
  const strictBase =
    tool && category
      ? strictness(category.behavior) > strictness(tool.behavior)
        ? category
        : tool
      : base;
  return { base, strictBase, target, targetsCovered: covered && target !== undefined };
}

/**
 * The user's explicit rule for a request, or undefined when there is none.
 *
 * A target rule is the most specific and may LOOSEN — but only when every
 * target of the request has one. If it covers just part of the recipients it
 * can only tighten, and the stricter of the tool and category rules applies:
 * `targets: {"#team": "auto"}` says nothing about a post that also goes to
 * `#public-announce`.
 */
export function ruleFor(rules: WardenRules, req: RuleSubject): MatchedRule | undefined {
  const match = matchRules(rules, req);
  if (match.target && match.targetsCovered) return match.target;
  let chosen = match.target ? match.strictBase : match.base;
  if (
    match.target &&
    (!chosen || strictness(match.target.behavior) > strictness(chosen.behavior))
  ) {
    // A partial target rule that is at least "ask" still tightens; a looser
    // one is ignored (it would otherwise speak for recipients it never named).
    if (strictness(match.target.behavior) >= strictness("ask")) chosen = match.target;
  }
  return chosen;
}

const ORDER: readonly RuleBehavior[] = ["auto", "preapproved", "ask", "handoff"];

/**
 * auto < preapproved < ask < handoff. Anything that is not one of the four
 * behaviours ranks as "ask": an unrecognised value must never sort BELOW auto
 * and lose to it.
 */
export function strictness(behavior: unknown): number {
  const index = ORDER.indexOf(behavior as RuleBehavior);
  return index >= 0 ? index : ORDER.indexOf("ask");
}

export function stricter(a: RuleBehavior, b: RuleBehavior): RuleBehavior {
  return strictness(a) >= strictness(b) ? a : b;
}

export { ACTION_CATEGORIES };
