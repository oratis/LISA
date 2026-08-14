/**
 * Layered `SKILL.md` discovery (P1 — docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §7).
 *
 * Skills previously came from exactly one place, `~/.lisa/skills`. The
 * ecosystem convention (Claude Code, dsh) also puts them next to the project
 * they belong to, so a repo can ship the workflows that only make sense inside
 * it. Reading those costs nothing and is the same compatibility argument as the
 * AGENTS.md chain.
 *
 * Ranks, lowest number scanned first:
 *
 *   100  <project>/.lisa/skills
 *   200  <project>/.agents/skills
 *   400  <lisaHome>/skills          (the existing, authoritative location)
 *
 * **Collision rule — home wins, deliberately inverted from dsh.** dsh resolves
 * nearest-first, so a project skill shadows a global one of the same name. That
 * is the right default for a coding harness; it is the wrong default here,
 * because a Lisa skill is prompt material she wrote about how to work, and
 * `cd`-ing into a hostile repo must not be enough to redefine one of her own
 * skills. Project skills are therefore additive: on a name collision the home
 * skill stands and the project one is dropped.
 *
 * This mirrors the precedent already set for tools, where a builtin beats an
 * injected one of the same name (src/tools/registry.ts).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { skillsDir } from "../paths.js";
import { pathExists } from "../fs-utils.js";
import { parseFrontmatter } from "./frontmatter.js";
import { validateSkillName } from "./manager.js";
import type { Skill } from "../types.js";

/**
 * Upper bound on a discovered `SKILL.md`. Project skills are untrusted (they
 * arrive by `cd`), so a symlinked or multi-GB file must not OOM the scan; home
 * skills are never this large. Skills over this are skipped.
 */
const MAX_SKILL_BYTES = 128 * 1024;

export interface SkillSource {
  dir: string;
  rank: number;
  scope: "home" | "project";
}

export interface DiscoveredSkill extends Skill {
  scope: "home" | "project";
  /** Directory it was discovered under. */
  source: string;
}

export interface SkillDiscovery {
  skills: DiscoveredSkill[];
  /** Project skills dropped because a home skill already owns the name. */
  shadowed: Array<{ name: string; path: string }>;
}

/** The directories scanned for a given working directory, in rank order. */
export function skillSources(projectRoot: string): SkillSource[] {
  return [
    { dir: path.join(projectRoot, ".lisa", "skills"), rank: 100, scope: "project" },
    { dir: path.join(projectRoot, ".agents", "skills"), rank: 200, scope: "project" },
    { dir: skillsDir(), rank: 400, scope: "home" },
  ];
}

async function readSkillsIn(source: SkillSource): Promise<DiscoveredSkill[]> {
  if (!(await pathExists(source.dir))) return [];
  let entries;
  try {
    entries = await fs.readdir(source.dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    // Untrusted project dirs land verbatim in the prompt index — hold their
    // names to the same charset the tool enforces before trusting them.
    try {
      validateSkillName(entry.name);
    } catch {
      continue;
    }
    const file = path.join(source.dir, entry.name, "SKILL.md");
    try {
      // lstat (not stat): refuse a symlinked SKILL.md (a repo could point it at
      // a secret) and bound the size so a huge / `/dev/zero` file can't OOM the
      // scan — the same untrusted-read hazard the AGENTS.md chain guards.
      const lst = await fs.lstat(file);
      if (!lst.isFile() || lst.size > MAX_SKILL_BYTES) continue;
      const raw = await fs.readFile(file, "utf8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;
      // Same guard the home loader has always applied: the declared name must
      // match its directory, so a skill cannot claim to be another one.
      if (parsed.frontmatter.name !== entry.name) continue;
      out.push({ ...parsed, path: file, scope: source.scope, source: source.dir });
    } catch {
      // skip unreadable/unparseable skills rather than failing the whole scan
    }
  }
  return out;
}

/**
 * Discover skills for a working directory. Home skills are resolved first so
 * they own their names; project skills fill in the rest.
 */
export async function discoverSkills(projectRoot: string): Promise<SkillDiscovery> {
  const sources = skillSources(projectRoot);
  const home = sources.filter((s) => s.scope === "home");
  const project = sources.filter((s) => s.scope === "project");

  const skills: DiscoveredSkill[] = [];
  const claimed = new Set<string>();
  const shadowed: Array<{ name: string; path: string }> = [];

  for (const source of home) {
    for (const skill of await readSkillsIn(source)) {
      if (claimed.has(skill.frontmatter.name)) continue;
      claimed.add(skill.frontmatter.name);
      skills.push(skill);
    }
  }
  for (const source of project.sort((a, b) => a.rank - b.rank)) {
    for (const skill of await readSkillsIn(source)) {
      if (claimed.has(skill.frontmatter.name)) {
        shadowed.push({ name: skill.frontmatter.name, path: skill.path });
        continue;
      }
      claimed.add(skill.frontmatter.name);
      skills.push(skill);
    }
  }

  skills.sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
  return { skills, shadowed };
}

/** Fingerprint contribution so adding a project skill hot-reloads the prompt. */
export async function skillSourcesFingerprint(projectRoot: string): Promise<string> {
  const parts: string[] = [];
  for (const source of skillSources(projectRoot)) {
    try {
      const entries = (await fs.readdir(source.dir)).sort();
      const inner: string[] = [];
      for (const name of entries) {
        try {
          const st = await fs.stat(path.join(source.dir, name, "SKILL.md"));
          inner.push(`${name}:${Math.floor(st.mtimeMs)}`);
        } catch {
          inner.push(`${name}:0`);
        }
      }
      parts.push(`${source.dir}[${inner.join(",")}]`);
    } catch {
      parts.push(`${source.dir}:0`);
    }
  }
  return parts.join("|");
}
