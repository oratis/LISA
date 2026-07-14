/**
 * Knowledge-base storage layer.
 *
 * Mirrors the soul store's discipline — every mutation runs under a
 * cross-process advisory write-lock (withFileLock) and records a best-effort
 * git commit — but keeps the KB in its own dir/repo (see paths.ts). Entries are
 * markdown files with a small frontmatter block; sources are append-only
 * captures, wiki pages are upserted. index.md (the always-on table of contents)
 * is regenerated on every mutation.
 */
import fs from "node:fs/promises";
import { ensureDir, atomicWrite, pathExists, readTextOrEmpty } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import { assertSafeSlug, normalizeSlug } from "../soul/slug.js";
import { commitKb } from "./git.js";
import { ensureSchema } from "./schema.js";
import {
  KB_INDEX_FILE,
  KB_LOCK_PATH,
  KB_SOURCES_DIR,
  KB_WIKI_DIR,
  entryFile,
  layerDir,
  type KbLayer,
} from "./paths.js";

export interface KbEntry {
  layer: KbLayer;
  slug: string;
  title: string;
  tags: string[];
  /** Sources: ISO capture time. */
  created?: string;
  /** Wiki: ISO last-update time. */
  updated?: string;
  /** Sources: where it came from (session id | "manual" | "chat:<id>"). */
  origin?: string;
  /** Wiki: source slugs this page draws on. */
  sources?: string[];
  /** Markdown body (frontmatter stripped). */
  body: string;
}

export interface KbEntryMeta {
  layer: KbLayer;
  slug: string;
  title: string;
  tags: string[];
  created?: string;
  updated?: string;
  origin?: string;
  sources?: string[];
  /** First ~160 chars of the body, whitespace-collapsed. */
  excerpt: string;
}

// ── frontmatter ───────────────────────────────────────────────────────

function parseFrontmatter(raw: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const lines = raw.split("\n");
  if (lines[0] !== "---") return { meta: {}, body: raw };
  const meta: Record<string, string | string[]> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i] === "---") {
      i++;
      break;
    }
    const m = lines[i]!.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const val = m[2]!.trim();
    if (key === "tags" || key === "sources") {
      meta[key] = val
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      meta[key] = val;
    }
  }
  if (lines[i] === "") i++; // drop one blank line after the closing ---
  return { meta, body: lines.slice(i).join("\n") };
}

function serializeEntry(entry: KbEntry): string {
  const fm: string[] = ["---", `title: ${entry.title}`];
  if (entry.tags.length) fm.push(`tags: [${entry.tags.join(", ")}]`);
  if (entry.layer === "sources") {
    if (entry.created) fm.push(`created: ${entry.created}`);
    if (entry.origin) fm.push(`origin: ${entry.origin}`);
  } else {
    if (entry.updated) fm.push(`updated: ${entry.updated}`);
    if (entry.sources?.length) fm.push(`sources: [${entry.sources.join(", ")}]`);
  }
  fm.push("---", "");
  return fm.join("\n") + entry.body.trimEnd() + "\n";
}

function parseEntry(layer: KbLayer, slug: string, raw: string): KbEntry {
  const { meta, body } = parseFrontmatter(raw);
  return {
    layer,
    slug,
    title: (meta.title as string) || slug,
    tags: (meta.tags as string[]) ?? [],
    created: meta.created as string | undefined,
    updated: meta.updated as string | undefined,
    origin: meta.origin as string | undefined,
    sources: (meta.sources as string[]) ?? undefined,
    // Serialization always appends a trailing newline; strip it on read so a
    // write→read round-trip is stable (body "x" stores as "x\n", reads as "x").
    body: body.trimEnd(),
  };
}

function metaOf(entry: KbEntry): KbEntryMeta {
  return {
    layer: entry.layer,
    slug: entry.slug,
    title: entry.title,
    tags: entry.tags,
    created: entry.created,
    updated: entry.updated,
    origin: entry.origin,
    sources: entry.sources,
    excerpt: entry.body.replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

// ── scaffold ──────────────────────────────────────────────────────────

/** Create the KB layout (dirs + default schema) if missing. Idempotent. */
export async function ensureKbScaffold(): Promise<void> {
  await ensureDir(KB_SOURCES_DIR);
  await ensureDir(KB_WIKI_DIR);
  await ensureSchema();
}

async function uniqueSlug(layer: KbLayer, base: string): Promise<string> {
  const root = normalizeSlug(base) || `entry-${Date.now()}`;
  let slug = root;
  let n = 2;
  while (await pathExists(entryFile(layer, slug))) {
    slug = `${root}-${n++}`;
  }
  return slug;
}

// ── reads ─────────────────────────────────────────────────────────────

export async function readEntry(layer: KbLayer, slug: string): Promise<KbEntry | null> {
  const file = entryFile(layer, slug);
  if (!(await pathExists(file))) return null;
  return parseEntry(layer, slug, await fs.readFile(file, "utf8"));
}

/** List entry metadata (no full body), newest first. Omit `layer` for all. */
export async function listEntries(layer?: KbLayer): Promise<KbEntryMeta[]> {
  const layers: KbLayer[] = layer ? [layer] : ["wiki", "sources"];
  const out: KbEntryMeta[] = [];
  for (const L of layers) {
    const dir = layerDir(L);
    if (!(await pathExists(dir))) continue;
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".md")) continue;
      const slug = f.slice(0, -3);
      try {
        out.push(metaOf(parseEntry(L, slug, await fs.readFile(`${dir}/${f}`, "utf8"))));
      } catch {
        // skip unparseable
      }
    }
  }
  out.sort((a, b) =>
    (b.updated || b.created || "").localeCompare(a.updated || a.created || ""),
  );
  return out;
}

export async function readIndex(): Promise<string> {
  return readTextOrEmpty(KB_INDEX_FILE);
}

// ── index regeneration ────────────────────────────────────────────────

/** Rebuild index.md from the current wiki + sources. Assumes the lock is held. */
async function regenerateIndexLocked(): Promise<void> {
  const wiki = await listEntries("wiki");
  const sources = await listEntries("sources");
  const lines = [
    "# Knowledge base index",
    "",
    `_${wiki.length} wiki page(s) · ${sources.length} source(s)_`,
    "",
  ];
  if (wiki.length) {
    lines.push("## Wiki pages", "");
    for (const w of wiki) {
      const tags = w.tags.length ? ` · ${w.tags.map((t) => `#${t}`).join(" ")}` : "";
      lines.push(`- **${w.title}** (\`${w.slug}\`)${tags} — ${w.excerpt.slice(0, 100)}`);
    }
    lines.push("");
  }
  if (sources.length) {
    lines.push("## Recent sources", "");
    for (const s of sources.slice(0, 25)) {
      const tags = s.tags.length ? ` · ${s.tags.map((t) => `#${t}`).join(" ")}` : "";
      lines.push(`- ${s.title} (\`${s.slug}\`)${tags}`);
    }
    lines.push("");
  }
  await atomicWrite(KB_INDEX_FILE, lines.join("\n").trimEnd() + "\n");
}

/** Public index rebuild (acquires the lock). */
export function regenerateIndex(): Promise<void> {
  return withFileLock(KB_LOCK_PATH, regenerateIndexLocked);
}

// ── writes ────────────────────────────────────────────────────────────

/**
 * Capture a Layer-1 source (immutable raw). Each call writes a NEW file — the
 * slug is made unique so nothing is ever overwritten. Backs the web "add to KB".
 */
export async function addSource(opts: {
  title: string;
  body: string;
  tags?: string[];
  origin?: string;
}): Promise<KbEntry> {
  await ensureKbScaffold();
  return withFileLock(KB_LOCK_PATH, async () => {
    const title = opts.title.trim() || "untitled";
    const slug = await uniqueSlug("sources", title);
    const entry: KbEntry = {
      layer: "sources",
      slug,
      title,
      tags: opts.tags ?? [],
      created: new Date().toISOString(),
      origin: opts.origin,
      body: opts.body,
    };
    await atomicWrite(entryFile("sources", slug), serializeEntry(entry));
    await regenerateIndexLocked();
    await commitKb(`kb: add source ${slug}`);
    return entry;
  });
}

/**
 * Create or update a Layer-2 wiki page (upsert by slug). Lisa's curation tool.
 */
export async function writeWiki(opts: {
  slug?: string;
  title: string;
  body: string;
  tags?: string[];
  sources?: string[];
}): Promise<KbEntry> {
  await ensureKbScaffold();
  return withFileLock(KB_LOCK_PATH, async () => {
    const slug = opts.slug
      ? assertSafeSlug(opts.slug)
      : normalizeSlug(opts.title) || `page-${Date.now()}`;
    const entry: KbEntry = {
      layer: "wiki",
      slug,
      title: opts.title.trim() || slug,
      tags: opts.tags ?? [],
      updated: new Date().toISOString(),
      sources: opts.sources ?? [],
      body: opts.body,
    };
    await atomicWrite(entryFile("wiki", slug), serializeEntry(entry));
    await regenerateIndexLocked();
    await commitKb(`kb: write wiki ${slug}`);
    return entry;
  });
}

/** Delete an entry (user-initiated). Returns false if it didn't exist. */
export async function removeEntry(layer: KbLayer, slug: string): Promise<boolean> {
  return withFileLock(KB_LOCK_PATH, async () => {
    const file = entryFile(layer, slug);
    if (!(await pathExists(file))) return false;
    await fs.rm(file, { force: true });
    await regenerateIndexLocked();
    await commitKb(`kb: remove ${layer}/${slug}`);
    return true;
  });
}
