import fs from "node:fs/promises";
import path from "node:path";
import { skillsDir } from "../paths.js";
import { atomicWrite, ensureDir, pathExists } from "../fs-utils.js";
import type { Skill, SkillFrontmatter } from "../types.js";
import { buildFrontmatter, parseFrontmatter } from "./frontmatter.js";

const VALID_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function skillDir(name: string): string {
  return path.join(skillsDir(), name);
}

function skillFile(name: string): string {
  return path.join(skillDir(name), "SKILL.md");
}

export function validateSkillName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `invalid skill name "${name}": must be lowercase letters, digits, hyphens (max 63 chars)`,
    );
  }
}

export async function listSkills(): Promise<Skill[]> {
  await ensureDir(skillsDir());
  const entries = await fs.readdir(skillsDir(), { withFileTypes: true });
  const out: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = skillFile(entry.name);
    if (!(await pathExists(file))) continue;
    const raw = await fs.readFile(file, "utf8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;
    if (parsed.frontmatter.name !== entry.name) continue;
    out.push({ ...parsed, path: file });
  }
  out.sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
  return out;
}

export async function getSkill(name: string): Promise<Skill | null> {
  const file = skillFile(name);
  if (!(await pathExists(file))) return null;
  const raw = await fs.readFile(file, "utf8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  return { ...parsed, path: file };
}

export async function createSkill(
  fm: SkillFrontmatter,
  body: string,
): Promise<Skill> {
  validateSkillName(fm.name);
  if (fm.description.length > 1024) {
    throw new Error("skill description too long (max 1024 chars)");
  }
  const file = skillFile(fm.name);
  if (await pathExists(file)) {
    throw new Error(`skill "${fm.name}" already exists`);
  }
  const content = buildFrontmatter(fm, body.endsWith("\n") ? body : body + "\n");
  await atomicWrite(file, content);
  return { frontmatter: fm, body, path: file };
}

export async function patchSkill(
  name: string,
  oldString: string,
  newString: string,
): Promise<Skill> {
  validateSkillName(name);
  const existing = await getSkill(name);
  if (!existing) throw new Error(`skill "${name}" not found`);
  if (oldString === newString) {
    throw new Error("old_string and new_string are identical");
  }
  const occurrences = countOccurrences(existing.body, oldString);
  if (occurrences === 0) {
    throw new Error(
      `old_string not found in skill "${name}". Use skill_view to inspect current content.`,
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `old_string matches ${occurrences} places in skill "${name}". Provide more context to disambiguate.`,
    );
  }
  const newBody = existing.body.replace(oldString, newString);
  const content = buildFrontmatter(
    existing.frontmatter,
    newBody.endsWith("\n") ? newBody : newBody + "\n",
  );
  await atomicWrite(existing.path, content);
  return { ...existing, body: newBody };
}

export async function rewriteSkill(
  name: string,
  body: string,
  description?: string,
): Promise<Skill> {
  validateSkillName(name);
  const existing = await getSkill(name);
  if (!existing) throw new Error(`skill "${name}" not found`);
  const fm: SkillFrontmatter = {
    ...existing.frontmatter,
    description: description ?? existing.frontmatter.description,
  };
  if (fm.description.length > 1024) {
    throw new Error("skill description too long (max 1024 chars)");
  }
  const content = buildFrontmatter(fm, body.endsWith("\n") ? body : body + "\n");
  await atomicWrite(existing.path, content);
  return { frontmatter: fm, body, path: existing.path };
}

export async function deleteSkill(name: string): Promise<void> {
  validateSkillName(name);
  const dir = skillDir(name);
  if (!(await pathExists(dir))) throw new Error(`skill "${name}" not found`);
  await fs.rm(dir, { recursive: true, force: true });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
