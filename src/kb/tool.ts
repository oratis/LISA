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
import { addSource, listEntries, listFullEntries, readEntry, writeWiki } from "./store.js";
import { buildGraph, kbKey, resolveRef } from "./links.js";
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

const kbRead: ToolDefinition<{ layer?: KbLayer; slug: string }, string> = {
  name: "kb_read",
  description:
    "Read one knowledge-base entry in full, by slug (from kb_search, index.md, or a [[wikilink]]). " +
    "layer is 'wiki' (pages you maintain) or 'sources' (the user's raw, immutable captures); " +
    "omit it and a [[slug]] resolves to the wiki page if there is one, else the source. " +
    "The reply ends with the pages that link here, so you can follow the graph.",
  inputSchema: {
    type: "object",
    properties: {
      layer: { type: "string", enum: ["wiki", "sources"] },
      slug: {
        type: "string",
        description: "Entry slug; '[[slug]]', 'kb:slug' and 'wiki/slug' are accepted too",
      },
    },
    required: ["slug"],
  },
  async execute(input) {
    // Resolve first — the model routinely passes a [[wikilink]] verbatim, and a
    // bare slug shouldn't need the caller to already know which layer it's in.
    const entries = await listFullEntries();
    const graph = buildGraph(entries);
    const ref = input.layer ? kbKey(input.layer, cleanSlug(input.slug)) : input.slug;
    const node = resolveRef(graph, ref) ?? resolveRef(graph, input.slug);
    if (!node) return `(no knowledge-base entry "${input.slug}")`;

    const e = await readEntry(node.layer, node.slug);
    if (!e) return `(no knowledge-base entry "${input.slug}")`;
    const meta = [
      `${e.layer}/${e.slug}`,
      e.tags.length ? `tags: ${e.tags.join(", ")}` : "",
      e.sources?.length ? `sources: ${e.sources.join(", ")}` : "",
      e.origin ? `origin: ${e.origin}` : "",
      e.extra?.url ? `url: ${e.extra.url}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    const back = (graph.back.get(node.key) ?? []).map(
      (k) => `[[${graph.nodes.get(k)?.slug ?? k}]] ${graph.nodes.get(k)?.title ?? ""}`.trim(),
    );
    const backlinks = back.length ? `\n\n---\n**Linked from:** ${back.join(" · ")}` : "";
    return `# ${e.title}\n_${meta}_\n\n${e.body}${backlinks}`;
  },
};

function cleanSlug(raw: string): string {
  return raw.trim().replace(/^\[\[|\]\]$/g, "").replace(/^kb:/, "").trim();
}

const kbLinks: ToolDefinition<{ slug: string }, string> = {
  name: "kb_links",
  description:
    "Show how a knowledge-base entry is connected: what it links to, what links back to it, " +
    "and pages that share its tags. Use it to explore around a topic — backlinks surface " +
    "connections that a keyword search can't. Accepts a slug or a [[wikilink]].",
  inputSchema: {
    type: "object",
    properties: { slug: { type: "string" } },
    required: ["slug"],
  },
  async execute(input) {
    const graph = buildGraph(await listFullEntries());
    const node = resolveRef(graph, input.slug);
    if (!node) return `(no knowledge-base entry "${input.slug}")`;

    const label = (k: string): string => {
      const n = graph.nodes.get(k);
      return n ? `[${n.layer}/${n.slug}] ${n.title}` : k;
    };
    const forward = (graph.forward.get(node.key) ?? []).map(label);
    const back = (graph.back.get(node.key) ?? []).map(label);
    const related = [...graph.nodes.values()]
      .filter(
        (n) => n.key !== node.key && n.tags.some((t) => node.tags.includes(t)),
      )
      .slice(0, 8)
      .map((n) => label(n.key));

    const section = (title: string, items: string[]): string =>
      items.length ? `${title}\n${items.map((i) => `  - ${i}`).join("\n")}` : `${title}\n  (none)`;

    return [
      `# ${node.title} (${node.layer}/${node.slug})`,
      node.tags.length ? `tags: ${node.tags.map((t) => `#${t}`).join(" ")}` : "",
      "",
      section("Links to:", forward),
      section("Linked from:", back),
      section("Shares tags with:", related),
    ]
      .filter((s) => s !== "")
      .join("\n");
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
  kbLinks as ToolDefinition,
  kbAdd as ToolDefinition,
  kbWrite as ToolDefinition,
];
