/**
 * What a task envelope may contain — one check for every way a task comes
 * into being or is read back: the model's tools, the API, the CLI, the
 * heartbeat migration and a task file found on disk (#422 review NEW-1).
 *
 * The envelope is what a confirmation pre-approves, and the user confirms it
 * from a screen that lists its tool names, categories and targets. So the
 * envelope may only hold things that are what they look like:
 *
 *   - a tool name is a builtin name (`bash`, `web_fetch`) or an MCP name
 *     (`mcp__<server>__<tool>`), letters, digits, `_` and `-`, bounded;
 *   - a category is one of Warden's action categories, or the heartbeat
 *     migration's own label;
 *   - a target is printable text (no control, bidi or invisible character),
 *     bounded.
 *
 * Anything else is refused on create and edit; a task file that holds it
 * loads switched off, unconfirmed, saying why (store.ts).
 */
import { ACTION_CATEGORIES } from "../warden/types.js";
import { isPrintable, visible } from "./visible.js";

/** Envelope category marking a routine that came from heartbeat.json (for the Warden wiring). */
export const HEARTBEAT_LEGACY_CATEGORY = "heartbeat-legacy";

/** Every category an envelope may name: Warden's, plus the migration's label (which pre-approves nothing). */
export const ENVELOPE_CATEGORIES: readonly string[] = Object.freeze([
  ...ACTION_CATEGORIES,
  HEARTBEAT_LEGACY_CATEGORY,
]);

export const ENVELOPE_LIMITS = Object.freeze({
  items: 64,
  /** `mcp__` + server (≤ 64) + `__` + tool (≤ 128). */
  toolName: 199,
  target: 200,
});

const BUILTIN_TOOL = /^(?!mcp__)[a-z][a-z0-9_]{0,63}$/;
const MCP_TOOL = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_-]{1,128}$/;

/** A tool name an envelope may hold: a builtin name or `mcp__<server>__<tool>`. */
export function isEnvelopeToolName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= ENVELOPE_LIMITS.toolName &&
    (BUILTIN_TOOL.test(v) || MCP_TOOL.test(v))
  );
}

export function isEnvelopeCategory(v: unknown): v is string {
  return typeof v === "string" && ENVELOPE_CATEGORIES.includes(v);
}

/** A target an envelope may hold: non-empty printable text, bounded. */
export function isEnvelopeTarget(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.trim().length > 0 &&
    v.length <= ENVELOPE_LIMITS.target &&
    isPrintable(v)
  );
}

function shown(v: unknown): string {
  return typeof v === "string" ? `"${visible(v.slice(0, 40))}"` : `(${typeof v})`;
}

/**
 * Why `envelope` is not a valid envelope, or null when it is (absent is valid).
 * The reason quotes at most 40 characters of what it rejects, escaped.
 * Fields other than the three are not looked at (the parsers drop them).
 */
export function envelopeProblem(envelope: unknown): string | null {
  if (envelope === undefined) return null;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return "envelope must be an object";
  }
  const v = envelope as Record<string, unknown>;
  const checks = [
    ["tools", isEnvelopeToolName, "a builtin tool name or mcp__<server>__<tool>"],
    ["categories", isEnvelopeCategory, `one of ${ENVELOPE_CATEGORIES.join(", ")}`],
    ["targets", isEnvelopeTarget, `printable text of at most ${ENVELOPE_LIMITS.target} characters`],
  ] as const;
  for (const [field, ok, what] of checks) {
    const list = v[field];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > ENVELOPE_LIMITS.items) {
      return `envelope.${field} must be a list of at most ${ENVELOPE_LIMITS.items} entries`;
    }
    for (const item of list) {
      if (!ok(item)) return `envelope.${field} entry ${shown(item)} is not ${what}`;
    }
  }
  return null;
}
