/**
 * User rules — per-category behaviour with optional per-tool and per-target
 * overrides, persisted at `<home>/warden/rules.json`.
 *
 * Rules are layered UNDER the system invariants (policy.ts): they can tighten
 * anything, and loosen only what the invariants leave open. A corrupt or
 * unreadable file never degrades to "allow": it falls back to the built-in
 * defaults (no user rules at all) and is reported.
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

export interface WardenRules {
  version: typeof RULES_VERSION;
  /** Behaviour per category. Absent = the built-in default matrix. */
  categories: Partial<Record<ActionCategory, RuleBehavior>>;
  /** Per-tool overrides (exact tool name). Win over the category rule. */
  tools: Record<string, RuleBehavior>;
  /** Per-target overrides (exact recipient / host / path). Win over tool and category. */
  targets: Record<string, RuleBehavior>;
  updatedAt?: string;
}

/** Categories whose behaviour is a system invariant, not a preference. */
export const LOCKED_CATEGORIES: Partial<Record<ActionCategory, RuleBehavior>> = {
  purchase: "handoff",
  credential: "handoff",
};

export function defaultRules(): WardenRules {
  return { version: RULES_VERSION, categories: {}, tools: {}, targets: {} };
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
  const out: Record<string, RuleBehavior> = {};
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
    out[key] = behavior;
  }
  return out;
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
    const set = categories[category as ActionCategory];
    if (set !== undefined && set !== locked) {
      throw new RulesValidationError(
        `categories.${category} is fixed to "${locked}" and cannot be changed`,
      );
    }
  }
  return {
    version: RULES_VERSION,
    categories,
    tools: behaviorMap(doc.tools, "tools", () => true),
    targets: behaviorMap(doc.targets, "targets", () => true),
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
    throw new RulesValidationError(
      "rules.json is corrupt; fix or delete it before changing rules",
    );
  }
  return await saveRules(
    { ...rules, categories: { ...rules.categories, [category]: behavior } },
    home,
  );
}

/** The user's rule for a request, most specific first; undefined = no rule. */
export function ruleFor(
  rules: WardenRules,
  req: { tool: string; category: ActionCategory; targets: string[] },
): { behavior: RuleBehavior; ruleId: string } | undefined {
  let strictest: { behavior: RuleBehavior; ruleId: string } | undefined;
  for (const target of req.targets) {
    const behavior = rules.targets[target];
    if (!behavior) continue;
    if (!strictest || strictness(behavior) > strictness(strictest.behavior)) {
      strictest = { behavior, ruleId: `rule:target:${target.slice(0, 80)}` };
    }
  }
  if (strictest) return strictest;
  const tool = rules.tools[req.tool];
  if (tool) return { behavior: tool, ruleId: `rule:tool:${req.tool}` };
  const category = rules.categories[req.category];
  if (category) return { behavior: category, ruleId: `rule:category:${req.category}` };
  return undefined;
}

/** auto < preapproved < ask < handoff. */
export function strictness(behavior: RuleBehavior): number {
  return ["auto", "preapproved", "ask", "handoff"].indexOf(behavior);
}

export function stricter(a: RuleBehavior, b: RuleBehavior): RuleBehavior {
  return strictness(a) >= strictness(b) ? a : b;
}

export { ACTION_CATEGORIES };
