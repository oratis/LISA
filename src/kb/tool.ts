/**
 * Knowledge-base tools exposed to the agent.
 *
 * Read tools (kb_search / kb_read / kb_list) are read-only + remote-safe.
 * Write tools (kb_add / kb_write) are path-jailed to ~/.lisa/kb and are
 * deliberately allowed for autonomous runs (so idle/heartbeat reflection can
 * tend the wiki) — see registry subset membership.
 */
import type { ToolDefinition } from "../types.js";
import { searchKb } from "./search.js";
import { addSource, listEntries, readEntry, writeWiki } from "./store.js";
import type { KbLayer } from "./paths.js";

const kbSearch: ToolDefinition<{ query: string; limit?: number }, string> = {
  name: "kb_search",
  description:
    "Search the user's personal knowledge base — their saved sources + the wiki pages you maintain. " +
    "Reach for this whenever a question touches the user's own captured knowledge, notes, or documents. " +
    "This is their curated KB, distinct from memory_search (raw past-conversation transcripts). " +
    "Returns ranked layer/slug + title + excerpt; follow up with kb_read for the full page.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    },
    required: ["query"],
  },
  async execute(input) {
    const hits = await searchKb(input.query, input.limit ?? 5);
    if (hits.length === 0) return "(no matches in the knowledge base)";
    return hits
      .map(
        (h) =>
          `[${h.layer}/${h.slug}] ${h.title} (score=${h.score.toFixed(2)})\n  ${h.excerpt}`,
      )
      .join("\n\n");
  },
};

const kbRead: ToolDefinition<{ layer: KbLayer; slug: string }, string> = {
  name: "kb_read",
  description:
    "Read one knowledge-base entry in full, by layer + slug (from kb_search or index.md). " +
    "layer is 'wiki' (pages you maintain) or 'sources' (the user's raw, immutable captures).",
  inputSchema: {
    type: "object",
    properties: {
      layer: { type: "string", enum: ["wiki", "sources"] },
      slug: { type: "string" },
    },
    required: ["layer", "slug"],
  },
  async execute(input) {
    const e = await readEntry(input.layer, input.slug);
    if (!e) return `(no ${input.layer} entry "${input.slug}")`;
    const meta = [
      e.tags.length ? `tags: ${e.tags.join(", ")}` : "",
      e.sources?.length ? `sources: ${e.sources.join(", ")}` : "",
      e.origin ? `origin: ${e.origin}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `# ${e.title}${meta ? `\n_${meta}_` : ""}\n\n${e.body}`;
  },
};

const kbList: ToolDefinition<{ layer?: KbLayer }, string> = {
  name: "kb_list",
  description:
    "List knowledge-base entries (title + tags), newest first. Omit layer for both; " +
    "pass 'wiki' or 'sources' to filter one layer.",
  inputSchema: {
    type: "object",
    properties: { layer: { type: "string", enum: ["wiki", "sources"] } },
  },
  async execute(input) {
    const entries = await listEntries(input.layer);
    if (entries.length === 0) return "(knowledge base is empty)";
    return entries
      .map(
        (e) =>
          `[${e.layer}/${e.slug}] ${e.title}${e.tags.length ? ` · ${e.tags.map((t) => `#${t}`).join(" ")}` : ""}`,
      )
      .join("\n");
  },
};

const kbAdd: ToolDefinition<
  { title: string; content: string; tags?: string[] },
  string
> = {
  name: "kb_add",
  description:
    "Capture a new SOURCE into the knowledge base (Layer 1 — raw, immutable). " +
    "Use to save a document, decision, or something the user asked you to remember into their KB. " +
    "Sources are never overwritten. To organize/distill, build a wiki page with kb_write.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["title", "content"],
  },
  async execute(input) {
    const e = await addSource({
      title: input.title,
      body: input.content,
      tags: input.tags,
      origin: "lisa",
    });
    return `Saved source "${e.title}" (sources/${e.slug}).`;
  },
};

const kbWrite: ToolDefinition<
  { slug?: string; title: string; content: string; tags?: string[]; sources?: string[] },
  string
> = {
  name: "kb_write",
  description:
    "Create or update a WIKI page (Layer 2 — the knowledge you maintain). Your curation tool: " +
    "distill sources + what you know about the user into a clear, cross-linked page. Upserts by slug " +
    "(omit slug to derive from the title). List the source slugs the page draws on.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "stable page id; omit to derive from title" },
      title: { type: "string" },
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      sources: { type: "array", items: { type: "string" } },
    },
    required: ["title", "content"],
  },
  async execute(input) {
    const e = await writeWiki({
      slug: input.slug,
      title: input.title,
      body: input.content,
      tags: input.tags,
      sources: input.sources,
    });
    return `Wrote wiki page "${e.title}" (wiki/${e.slug}).`;
  },
};

/** All KB tools (read tools first). Registered in tools/registry.ts. */
export const kbTools: ToolDefinition[] = [
  kbSearch as ToolDefinition,
  kbRead as ToolDefinition,
  kbList as ToolDefinition,
  kbAdd as ToolDefinition,
  kbWrite as ToolDefinition,
];
