import fs from "node:fs/promises";
import path from "node:path";
import { lisaGlobalHome } from "../paths.js";
import { ensureDir, pathExists } from "../fs-utils.js";
import { parseFrontmatter } from "../skills/frontmatter.js";
import type { Skill } from "../types.js";
import type {
  HookSpec,
  LoadedPlugin,
  PluginManifest,
  SlashCommand,
  SubagentDefinition,
} from "./types.js";

const PLUGINS_DIR = path.join(lisaGlobalHome(), "plugins");

export async function loadAllPlugins(): Promise<LoadedPlugin[]> {
  await ensureDir(PLUGINS_DIR);
  const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
  const out: LoadedPlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const root = path.join(PLUGINS_DIR, entry.name);
    try {
      const plugin = await loadPlugin(root);
      out.push(plugin);
    } catch {
      // skip unparseable plugins
    }
  }
  return out;
}

async function loadPlugin(root: string): Promise<LoadedPlugin> {
  const manifestPath = path.join(root, ".lisa-plugin", "plugin.json");
  let manifest: PluginManifest = {
    name: path.basename(root),
  };
  if (await pathExists(manifestPath)) {
    const raw = await fs.readFile(manifestPath, "utf8");
    manifest = JSON.parse(raw) as PluginManifest;
  }

  const [commands, agents, skills, hooks, mcpServers] = await Promise.all([
    loadCommands(path.join(root, "commands")),
    loadAgents(path.join(root, "agents")),
    loadSkills(path.join(root, "skills")),
    loadHooks(path.join(root, "hooks")),
    loadMcp(root),
  ]);

  return { manifest, root, commands, agents, skills, hooks, mcpServers };
}

async function loadCommands(dir: string): Promise<SlashCommand[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  const out: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const file = path.join(dir, entry);
    const raw = await fs.readFile(file, "utf8");
    const parsed = parseFrontmatter(raw);
    const description = (parsed?.frontmatter as Record<string, unknown> | undefined)?.[
      "description"
    ];
    const argumentHint = (parsed?.frontmatter as Record<string, unknown> | undefined)?.[
      "argument-hint"
    ];
    out.push({
      name: path.basename(entry, ".md"),
      description:
        typeof description === "string"
          ? description
          : "(no description)",
      argumentHint: typeof argumentHint === "string" ? argumentHint : undefined,
      body: parsed?.body ?? raw,
      source: file,
    });
  }
  return out;
}

async function loadAgents(dir: string): Promise<SubagentDefinition[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  const out: SubagentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const file = path.join(dir, entry);
    const raw = await fs.readFile(file, "utf8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;
    const fm = parsed.frontmatter as unknown as Record<string, unknown>;
    out.push({
      name: typeof fm.name === "string" ? fm.name : path.basename(entry, ".md"),
      description:
        typeof fm.description === "string" ? fm.description : "(no description)",
      body: parsed.body,
      source: file,
      tools:
        typeof fm.tools === "string"
          ? fm.tools.split(",").map((s) => s.trim())
          : undefined,
      model: typeof fm.model === "string" ? fm.model : undefined,
    });
  }
  return out;
}

async function loadSkills(dir: string): Promise<Skill[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    if (!(await pathExists(skillFile))) continue;
    const raw = await fs.readFile(skillFile, "utf8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;
    out.push({ ...parsed, path: skillFile });
  }
  return out;
}

async function loadHooks(dir: string): Promise<HookSpec[]> {
  const file = path.join(dir, "hooks.json");
  if (!(await pathExists(file))) return [];
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
  const out: HookSpec[] = [];
  for (const [event, group] of Object.entries(parsed.hooks ?? {})) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const matcher = (item as { matcher?: string }).matcher;
      const hooks = (item as { hooks?: unknown[] }).hooks ?? [];
      for (const h of hooks) {
        const hookObj = h as {
          type: string;
          command?: string;
          timeout?: number;
        };
        if (hookObj.type !== "command" || !hookObj.command) continue;
        out.push({
          event: event as HookSpec["event"],
          matcher,
          command: hookObj.command,
          timeout_ms: hookObj.timeout,
        });
      }
    }
  }
  return out;
}

async function loadMcp(
  root: string,
): Promise<{ name: string; command: string; args?: string[]; env?: Record<string, string> }[]> {
  const file = path.join(root, ".mcp.json");
  if (!(await pathExists(file))) return [];
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw) as {
    mcpServers?: Record<
      string,
      { command: string; args?: string[]; env?: Record<string, string> }
    >;
  };
  return Object.entries(parsed.mcpServers ?? {}).map(([name, spec]) => ({
    name,
    command: spec.command,
    args: spec.args,
    env: spec.env,
  }));
}

export const PLUGINS_ROOT = PLUGINS_DIR;
