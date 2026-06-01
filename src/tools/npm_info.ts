/**
 * npm_info (integration) — the npm registry, the external service every JS
 * agent touches. view a package's metadata, find outdated deps in a repo, or
 * audit it for known vulnerabilities. No auth; uses the local npm CLI.
 */
import type { ToolDefinition } from "../types.js";
import { runIn, isDir, gitRoot } from "./exec-util.js";

interface NpmInput {
  action: "view" | "outdated" | "audit";
  /** Package name for view (optionally name@range). */
  package?: string;
  cwd?: string;
}

/** Pure: format `npm view --json` metadata. Exported for tests. */
export function formatView(json: string): string {
  let d: any;
  try { d = JSON.parse(json); } catch { return json.trim(); }
  if (Array.isArray(d)) d = d[d.length - 1]; // version range → newest match
  const lines = [
    `${d.name}@${d.version}`,
    d.description ? `  ${d.description}` : "",
    d.license ? `  license: ${d.license}` : "",
    d.homepage ? `  homepage: ${d.homepage}` : "",
    d.deprecated ? `  ⚠ DEPRECATED: ${d.deprecated}` : "",
    d.dist?.unpackedSize ? `  size: ${Math.round(d.dist.unpackedSize / 1024)} KB` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Pure: format `npm outdated --json`. Exported for tests. */
export function formatOutdated(json: string): string {
  let d: Record<string, any>;
  try { d = JSON.parse(json || "{}"); } catch { return json.trim(); }
  const names = Object.keys(d);
  if (names.length === 0) return "(all dependencies up to date)";
  return `${names.length} outdated:\n` + names.map((n) => `  ${n}: ${d[n].current ?? "?"} → ${d[n].latest ?? "?"}`).join("\n");
}

/** Pure: summarise `npm audit --json` (npm v7+ shape). Exported for tests. */
export function formatAudit(json: string): string {
  let d: any;
  try { d = JSON.parse(json); } catch { return json.trim(); }
  const v = d?.metadata?.vulnerabilities;
  if (!v) return "(no audit data)";
  const total = (v.critical ?? 0) + (v.high ?? 0) + (v.moderate ?? 0) + (v.low ?? 0) + (v.info ?? 0);
  if (total === 0) return "(no known vulnerabilities)";
  const parts = ["critical", "high", "moderate", "low", "info"].filter((k) => v[k]).map((k) => `${v[k]} ${k}`);
  return `${total} vulnerabilit${total === 1 ? "y" : "ies"}: ${parts.join(", ")}  (run \`npm audit\` for detail)`;
}

export const npmInfoTool: ToolDefinition<NpmInput, string> = {
  name: "npm_info",
  description:
    "npm registry info: action:'view' (package — latest version, description, license, deprecation), " +
    "'outdated' (which of a repo's dependencies have newer versions), 'audit' (known vulnerabilities in " +
    "a repo). Use when the user asks about a package, whether deps are current, or for a security pass. " +
    "Read-only; no auth; uses the local npm CLI.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["view", "outdated", "audit"] },
      package: { type: "string", description: "Package name (optionally name@range) for action:'view'." },
      cwd: { type: "string", description: "Repo path for outdated/audit. Defaults to current directory." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (input.action === "view") {
      if (!input.package) return "(view needs a package name)";
      const r = await runIn(ctx.cwd, "npm", ["view", input.package, "--json"], { timeoutMs: 20000, signal: ctx.signal, maxBytes: 200_000 });
      if (r.spawnError) return "(npm isn't installed)";
      if (r.code !== 0) return `(npm view failed: ${r.stderr.trim().slice(0, 160) || "no such package?"})`;
      return formatView(r.stdout);
    }

    const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;
    if (!(await isDir(cwd))) return `(not a directory: ${cwd})`;
    const root = (await gitRoot(cwd, ctx.signal)) ?? cwd;

    if (input.action === "outdated") {
      // npm outdated exits non-zero when there ARE outdated deps — that's not an error.
      const r = await runIn(root, "npm", ["outdated", "--json"], { timeoutMs: 60000, signal: ctx.signal, maxBytes: 200_000 });
      if (r.spawnError) return "(npm isn't installed)";
      return formatOutdated(r.stdout || "{}");
    }

    // audit
    const r = await runIn(root, "npm", ["audit", "--json"], { timeoutMs: 60000, signal: ctx.signal, maxBytes: 400_000 });
    if (r.spawnError) return "(npm isn't installed)";
    if (!r.stdout.trim()) return `(npm audit produced no output${r.stderr ? ": " + r.stderr.trim().slice(0, 120) : ""})`;
    return formatAudit(r.stdout);
  },
};
