/**
 * Executable skills (Phase 3.1 of AUTONOMY_ROADMAP).
 *
 * A skill at ~/.lisa/skills/<slug>/ may include an OPTIONAL tool.js file that
 * exports a ToolDefinition. When approved, that tool is dynamically imported
 * at startup and registered into the agent's tool list — letting Lisa extend
 * her own capabilities (not just write down knowledge).
 *
 * THIS IS DANGEROUS. The tool.js runs in the same process with the same
 * privileges as Lisa herself. Real isolation (worker_threads with capability
 * gating, or a separate child process) is intentionally NOT implemented in
 * this PR — getting it half-right is worse than not having it. The trust
 * boundary is human approval per content hash:
 *
 *   - Each registered tool is approved by content SHA256.
 *   - If the file changes, approval is invalidated until a new approval.
 *   - An audit log records every approval / disable / load event.
 *   - A `.disabled` flag forces the tool to never load.
 *
 * Lisa cannot self-approve. She CAN write the file (via skill_manage or fs);
 * loading happens only after `lisa skills approve <slug>` runs interactively
 * with the user reading the source.
 *
 * The TS source can ship as `tool.ts` for human reading, but only `tool.js`
 * is loaded. We do not run a TypeScript compiler at startup; the user (or
 * Lisa via redeploy) must produce the .js. This keeps the loader minimal.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { atomicWrite, ensureDir, pathExists } from "../fs-utils.js";
import { skillsDir } from "../paths.js";
import type { ToolDefinition } from "../types.js";

const TOOL_JS = "tool.js";
const APPROVED_FILE = "approved.json";
const DISABLED_FILE = ".disabled";
const AUDIT_FILE = "audit.log";

export interface ApprovedRecord {
  /** SHA256 hex of tool.js content at approval time. */
  sha256: string;
  /** ISO timestamp of approval. */
  approvedAt: string;
  /** Reviewer's tool name as it appeared in the approved source. */
  toolName: string;
  /** Free-form note set by the reviewer. */
  note?: string;
}

export interface ExecutableCandidate {
  slug: string;
  toolJsPath: string;
  currentSha: string;
  approved: ApprovedRecord | null;
  disabled: boolean;
  /** Status the loader uses to decide whether to register. */
  status:
    | "approved-current"
    | "approved-stale"
    | "unapproved"
    | "disabled"
    | "missing";
}

/** SHA256 hex of a file. Returns null if not present. */
async function shaOf(p: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(p);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

async function readApproved(slug: string): Promise<ApprovedRecord | null> {
  const f = path.join(skillsDir(), slug, APPROVED_FILE);
  if (!(await pathExists(f))) return null;
  try {
    return JSON.parse(await fs.readFile(f, "utf8")) as ApprovedRecord;
  } catch {
    return null;
  }
}

async function writeApproved(slug: string, rec: ApprovedRecord): Promise<void> {
  await atomicWrite(path.join(skillsDir(), slug, APPROVED_FILE), JSON.stringify(rec, null, 2));
}

async function isDisabled(slug: string): Promise<boolean> {
  return await pathExists(path.join(skillsDir(), slug, DISABLED_FILE));
}

async function appendAudit(slug: string, event: string, detail?: string): Promise<void> {
  const f = path.join(skillsDir(), slug, AUDIT_FILE);
  await ensureDir(path.dirname(f));
  const ts = new Date().toISOString();
  const line = `${ts}\t${event}${detail ? `\t${detail}` : ""}\n`;
  await fs.appendFile(f, line, "utf8");
}

export async function readAudit(slug: string): Promise<string> {
  const f = path.join(skillsDir(), slug, AUDIT_FILE);
  if (!(await pathExists(f))) return "";
  return await fs.readFile(f, "utf8");
}

export async function readToolSource(slug: string): Promise<string | null> {
  // Prefer .ts if present (more readable); fall back to .js.
  for (const name of ["tool.ts", TOOL_JS]) {
    const p = path.join(skillsDir(), slug, name);
    if (await pathExists(p)) {
      return await fs.readFile(p, "utf8");
    }
  }
  return null;
}

/** Discover all candidates with a tool.js, regardless of approval state. */
export async function discoverExecutableSkills(): Promise<ExecutableCandidate[]> {
  if (!(await pathExists(skillsDir()))) return [];
  const entries = await fs.readdir(skillsDir(), { withFileTypes: true });
  const out: ExecutableCandidate[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const slug = e.name;
    const toolJsPath = path.join(skillsDir(), slug, TOOL_JS);
    const currentShaMaybe = await shaOf(toolJsPath);
    if (!currentShaMaybe) continue; // no tool.js — not an executable skill
    const approved = await readApproved(slug);
    const disabled = await isDisabled(slug);
    let status: ExecutableCandidate["status"];
    if (disabled) status = "disabled";
    else if (!approved) status = "unapproved";
    else if (approved.sha256 === currentShaMaybe) status = "approved-current";
    else status = "approved-stale";
    out.push({ slug, toolJsPath, currentSha: currentShaMaybe, approved, disabled, status });
  }
  return out;
}

/**
 * Load and dynamically import every approved-current executable skill.
 * Failure to import any one is logged but does not abort — the rest still
 * load. Returns the list of registered tools.
 */
export async function loadApprovedExecutableTools(
  log: (msg: string) => void = () => {},
): Promise<ToolDefinition[]> {
  const candidates = await discoverExecutableSkills();
  const out: ToolDefinition[] = [];
  for (const c of candidates) {
    if (c.status !== "approved-current") continue;
    try {
      const url = pathToFileURL(c.toolJsPath).href;
      // Dynamic import. The bust query only runs on first load; we're fine.
      const mod = (await import(url)) as { tool?: ToolDefinition };
      const tool = mod.tool;
      if (!tool || typeof tool !== "object") {
        log(`[skills] ${c.slug}: tool.js does not export "tool" — skipped`);
        await appendAudit(c.slug, "load_failed", "no tool export");
        continue;
      }
      if (!tool.name || !tool.description || !tool.execute) {
        log(`[skills] ${c.slug}: exported tool missing name/description/execute — skipped`);
        await appendAudit(c.slug, "load_failed", "incomplete tool shape");
        continue;
      }
      out.push(tool);
      await appendAudit(c.slug, "loaded", `sha=${c.currentSha.slice(0, 12)} name=${tool.name}`);
    } catch (err) {
      log(`[skills] ${c.slug}: import failed — ${(err as Error).message}`);
      await appendAudit(c.slug, "load_failed", (err as Error).message.slice(0, 200));
    }
  }
  return out;
}

/**
 * Mark a skill's current tool.js as approved by recording its SHA. Called by
 * the `lisa skills approve` CLI subcommand AFTER the user has reviewed the
 * source. Re-approval after a content change requires this to be called
 * again with the new SHA.
 */
export async function approveExecutableSkill(
  slug: string,
  opts: { toolName: string; note?: string },
): Promise<ApprovedRecord> {
  const toolJsPath = path.join(skillsDir(), slug, TOOL_JS);
  const sha = await shaOf(toolJsPath);
  if (!sha) throw new Error(`no tool.js found at ${toolJsPath}`);
  const rec: ApprovedRecord = {
    sha256: sha,
    approvedAt: new Date().toISOString(),
    toolName: opts.toolName,
    note: opts.note,
  };
  await writeApproved(slug, rec);
  // Re-enable on approval if a stale .disabled flag is present.
  const disPath = path.join(skillsDir(), slug, DISABLED_FILE);
  if (await pathExists(disPath)) {
    await fs.rm(disPath, { force: true });
    await appendAudit(slug, "re_enabled");
  }
  await appendAudit(slug, "approved", `sha=${sha.slice(0, 12)} name=${opts.toolName}`);
  return rec;
}

export async function disableExecutableSkill(slug: string, reason?: string): Promise<void> {
  const dir = path.join(skillsDir(), slug);
  if (!(await pathExists(dir))) throw new Error(`skill "${slug}" not found`);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, DISABLED_FILE), `${new Date().toISOString()}\n${reason ?? ""}\n`);
  await appendAudit(slug, "disabled", reason);
}

export async function enableExecutableSkill(slug: string): Promise<void> {
  const dir = path.join(skillsDir(), slug);
  const f = path.join(dir, DISABLED_FILE);
  if (await pathExists(f)) {
    await fs.rm(f, { force: true });
    await appendAudit(slug, "enabled");
  }
}

/** Quick text summary for the CLI / startup notice. */
export function summarizeCandidate(c: ExecutableCandidate): string {
  const tag = {
    "approved-current": "✓ loaded",
    "approved-stale":   "✗ stale (re-approve)",
    "unapproved":       "✗ unapproved",
    "disabled":         "✗ disabled",
    "missing":          "✗ missing",
  }[c.status];
  return `  ${c.slug.padEnd(28)} ${tag}  sha=${c.currentSha.slice(0, 12)}`;
}
