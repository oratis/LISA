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
import { assertSafeSlug } from "../soul/slug.js";
import { kbSlug } from "./slug.js";
import { commitKb } from "./git.js";
import { ensureSchema } from "./schema.js";
import {
  kbIndexFile,
  kbLockPath,
  kbSourcesDir,
  kbWikiDir,
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
  /**
   * Any other frontmatter key, preserved verbatim on read and written back on
   * save. This is where ingest provenance lives (url / site / author /
   * published / lang / hash / via / supersedes) without the store needing to
   * know about any of it — and it means a key a future version adds survives a
   * round-trip through an older one rather than being silently dropped.
   */
  extra?: Record<string, string>;
  /** Markdown body (frontmatter stripped). */
  body: string;
}

/** Frontmatter keys the store owns; everything else lands in `extra`. */
const KNOWN_KEYS = new Set(["title", "tags", "created", "updated", "origin", "sources"]);

export interface KbEntryMeta {
  layer: KbLayer;
  slug: string;
  title: string;
  tags: string[];
  created?: string;
  updated?: string;
  origin?: string;
  sources?: string[];
  extra?: Record<string, string>;
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
    const m = lines[i]!.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
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
  for (const [k, v] of Object.entries(entry.extra ?? {})) {
    // A newline in a value would forge frontmatter lines on the next read, so
    // collapse whitespace. Empty values are dropped rather than written blank.
    const flat = String(v).replace(/\s+/g, " ").trim();
    if (flat && !KNOWN_KEYS.has(k)) fm.push(`${k}: ${flat}`);
  }
  fm.push("---", "");
  return fm.join("\n") + entry.body.trimEnd() + "\n";
}

function parseEntry(layer: KbLayer, slug: string, raw: string): KbEntry {
  const { meta, body } = parseFrontmatter(raw);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!KNOWN_KEYS.has(k) && typeof v === "string") extra[k] = v;
  }
  return {
    layer,
    slug,
    title: (meta.title as string) || slug,
    tags: (meta.tags as string[]) ?? [],
    created: meta.created as string | undefined,
    updated: meta.updated as string | undefined,
    origin: meta.origin as string | undefined,
    sources: (meta.sources as string[]) ?? undefined,
    extra: Object.keys(extra).length ? extra : undefined,
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
    extra: entry.extra,
    excerpt: entry.body.replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

// ── scaffold ──────────────────────────────────────────────────────────

/** Create the KB layout (dirs + default schema) if missing. Idempotent. */
export async function ensureKbScaffold(): Promise<void> {
  await ensureDir(kbSourcesDir());
  await ensureDir(kbWikiDir());
  await ensureSchema();
}

/**
 * A slug that doesn't collide with an existing entry. `base` is already minted
 * (kbSlug) — this only appends -2, -3 … when the file is taken.
 */
async function uniqueSlug(layer: KbLayer, base: string): Promise<string> {
  const root = base || `entry-${Date.now()}`;
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
  return readTextOrEmpty(kbIndexFile());
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
  await atomicWrite(kbIndexFile(), lines.join("\n").trimEnd() + "\n");
}

/** Public index rebuild (acquires the lock). */
export function regenerateIndex(): Promise<void> {
  return withFileLock(kbLockPath(), regenerateIndexLocked);
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
  /** Provenance frontmatter (url / site / author / published / hash / via …). */
  extra?: Record<string, string>;
}): Promise<KbEntry> {
  await ensureKbScaffold();
  return withFileLock(kbLockPath(), async () => {
    const title = opts.title.trim() || "untitled";
    const created = new Date().toISOString();
    const slug = await uniqueSlug(
      "sources",
      kbSlug({ title, url: opts.extra?.url, date: created }),
    );
    const entry: KbEntry = {
      layer: "sources",
      slug,
      title,
      tags: opts.tags ?? [],
      created,
      origin: opts.origin,
      extra: opts.extra,
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
  extra?: Record<string, string>;
}): Promise<KbEntry> {
  await ensureKbScaffold();
  return withFileLock(kbLockPath(), async () => {
    const slug = opts.slug
      ? assertSafeSlug(opts.slug)
      : kbSlug({ title: opts.title }) || `page-${Date.now()}`;
    const entry: KbEntry = {
      layer: "wiki",
      slug,
      title: opts.title.trim() || slug,
      tags: opts.tags ?? [],
      updated: new Date().toISOString(),
      sources: opts.sources ?? [],
      extra: opts.extra,
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
  return withFileLock(kbLockPath(), async () => {
    const file = entryFile(layer, slug);
    if (!(await pathExists(file))) return false;
    await fs.rm(file, { force: true });
    await regenerateIndexLocked();
    await commitKb(`kb: remove ${layer}/${slug}`);
    return true;
  });
}
