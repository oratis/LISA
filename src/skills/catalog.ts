/** Owner-only import catalog. Listing never activates third-party instructions. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { skillsDir } from "../paths.js";
import { validateSkillName } from "./manager.js";
import { parseFrontmatter } from "./frontmatter.js";

export type ImportSource = "codex" | "claude";
/** Files and folders copied for one skill, and their total size. */
const MAX_IMPORT_ENTRIES = 256;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export interface SkillCandidate {
  name: string;
  description: string;
  source: ImportSource;
}
function sourceDir(source: ImportSource): string {
  if (source === "codex")
    return path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "skills");
  if (source === "claude")
    return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "skills");
  throw new Error("Unknown skill source");
}
export async function skillImportCatalog(): Promise<SkillCandidate[]> {
  const out: SkillCandidate[] = [];
  for (const source of ["codex", "claude"] as const) {
    const root = sourceDir(source);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        validateSkillName(entry.name);
        const file = path.join(root, entry.name, "SKILL.md");
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > 128 * 1024) continue;
        const parsed = parseFrontmatter(await fs.readFile(file, "utf8"));
        if (parsed?.frontmatter.name !== entry.name) continue;
        out.push({ name: entry.name, description: parsed.frontmatter.description, source });
      } catch {
        /* One incompatible skill must not hide the rest of the catalog. */
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}
export async function importSkill(source: ImportSource, name: string): Promise<void> {
  validateSkillName(name);
  const candidate = (await skillImportCatalog()).find(
    (s) => s.source === source && s.name === name,
  );
  if (!candidate) throw new Error("Skill is unavailable or incompatible");
  // The folder itself must still be a real directory: a symlink swapped in
  // after listing would otherwise make realpath() import whatever it targets.
  const folder = path.join(sourceDir(source), name);
  if (!(await fs.lstat(folder)).isDirectory())
    throw new Error("Skills with symbolic links cannot be imported");
  const sourceRoot = await fs.realpath(folder);
  const destination = path.join(skillsDir(), name);
  if (
    await fs.lstat(destination).then(
      () => true,
      () => false,
    )
  )
    throw new Error("A personal skill already has this name");
  await fs.mkdir(skillsDir(), { recursive: true });
  const staging = await fs.mkdtemp(path.join(skillsDir(), ".import-"));
  let count = 0;
  let bytes = 0;
  async function copy(relative: string): Promise<void> {
    const from = path.join(sourceRoot, relative);
    const stat = await fs.lstat(from);
    const real = await fs.realpath(from);
    if (stat.isSymbolicLink() || (real !== sourceRoot && !real.startsWith(sourceRoot + path.sep))) {
      throw new Error("Skills with symbolic links cannot be imported");
    }
    // Directories count too, so a deep or wide empty tree is bounded as well.
    if (++count > MAX_IMPORT_ENTRIES) throw new Error("Skill exceeds the import size limit");
    if (stat.isDirectory()) {
      await fs.mkdir(path.join(staging, relative), { recursive: true });
      for (const entry of await fs.readdir(from)) await copy(path.join(relative, entry));
    } else if (stat.isFile()) {
      if ((bytes += stat.size) > MAX_IMPORT_BYTES)
        throw new Error("Skill exceeds the import size limit");
      const file = await fs.open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        // Read exactly the size that was checked: a file that grows (or is
        // swapped) after lstat must not be pulled into memory unbounded.
        const opened = await file.stat();
        if (opened.ino !== stat.ino || opened.dev !== stat.dev)
          throw new Error("Skill changed during import; try again");
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < stat.size) {
          const { bytesRead } = await file.read(buffer, offset, stat.size - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const extra = await file.read(Buffer.alloc(1), 0, 1, stat.size);
        if (offset !== stat.size || extra.bytesRead)
          throw new Error("Skill changed during import; try again");
        await fs.writeFile(path.join(staging, relative), buffer, {
          mode: stat.mode & 0o100 ? 0o700 : 0o600,
          flag: "wx",
        });
      } finally {
        await file.close();
      }
    } else throw new Error("Unsupported file in skill");
  }
  try {
    await copy("");
    await fs.rename(staging, destination);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
