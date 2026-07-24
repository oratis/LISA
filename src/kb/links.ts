/**
 * The knowledge base's link graph.
 *
 * v1.0 told Lisa to cross-link wiki pages with `[[slug]]` (SCHEMA.md) and
 * recorded each page's `sources:` in frontmatter — but nothing ever read either
 * one. The KB was a pile of files with decorative links: no backlinks, no way
 * to see what a page is connected to, no way to tell a hub from an orphan.
 *
 * This module parses those links into an actual graph, which buys three things:
 *
 *   1. Backlinks — "what else mentions this?" is how you actually navigate a
 *      wiki, and it is the one view you cannot get by searching.
 *   2. A ranked index. index.md is injected into every system prompt and capped
 *      (prompt.ts), so a flat list gets truncated mid-way once the KB grows —
 *      and what gets cut is arbitrary. Ranking by (backlinks × recency) means
 *      truncation drops the least-connected tail instead.
 *   3. Orphans and broken links — the concrete to-do list for the idle
 *      "tend the wiki" pass.
 *
 * Link syntax: `[[slug]]`, `[[slug|display text]]`, and `[[kb:slug]]` (the form
 * memory entries use — see prompt.ts). A bare slug resolves to the wiki page of
 * that name if there is one, otherwise the source — wiki-first, because the
 * wiki is the layer of named concepts.
 */
import type { KbEntry } from "./store.js";
import type { KbLayer } from "./paths.js";

/** `layer/slug` — unique across the whole KB (a wiki page and a source may share a slug). */
export type KbKey = string;

export function kbKey(layer: KbLayer, slug: string): KbKey {
  return `${layer}/${slug}`;
}

export interface KbNode {
  key: KbKey;
  layer: KbLayer;
  slug: string;
  title: string;
  tags: string[];
  /** Whitespace-collapsed opening of the body. */
  gist: string;
  /** `updated` (wiki) or `created` (sources); "" when the entry has neither. */
  at: string;
}

export interface KbGraph {
  nodes: Map<KbKey, KbNode>;
  /** key → keys it points at (deduped, order preserved). */
  forward: Map<KbKey, KbKey[]>;
  /** key → keys pointing at it. The view v1.0 had no way to produce. */
  back: Map<KbKey, KbKey[]>;
  /** Wiki pages with no edges in either direction. */
  orphans: KbKey[];
  /** Wiki pages ranked by (1 + backlinks) × recency, best first. */
  hubs: { key: KbKey; score: number; backlinks: number }[];
  /** tag → keys carrying it, most-used tag first when iterated via sortedTags(). */
  tags: Map<string, KbKey[]>;
  /** `[[link]]`s that point at nothing — the wiki's to-do list. */
  broken: { from: KbKey; target: string }[];
}

/**
 * `[[slug]]`, `[[slug|text]]`, `[[kb:slug]]`.
 *
 * The surrounding `\s*` is intentionally omitted (the capture is `.trim()`ed at
 * the call site) and both the target and alias are length-bounded: with the
 * greedy `\s*` and an unbounded lazy class, a `[[` followed by a long whitespace
 * run and no closing `]]` caused catastrophic backtracking (ReDoS) — and this
 * runs over every entry body, including untrusted `sources`, on each KB mutation
 * and every `kb_read`/`kb_links`. Bounding it is O(n) on any input.
 */
const WIKILINK = /\[\[(?:kb:)?([^\]|#\n]{1,200}?)(?:\|[^\]\n]{0,200})?\]\]/g;

/** Every `[[…]]` target in a body, in order, deduped. */
export function parseWikilinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(WIKILINK)) {
    const target = m[1]!.trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/** Half-life (days) for the recency term in the hub score. */
const RECENCY_HALFLIFE_DAYS = 30;

function recencyWeight(at: string, now: number): number {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 0.5; // undated entries rank mid-pack, not last
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return 1 / (1 + ageDays / RECENCY_HALFLIFE_DAYS);
}

/**
 * Build the graph from every entry. Pure over its input — the caller does the
 * I/O — so it is cheap to test and can be rebuilt from any entry list.
 */
export function buildGraph(entries: KbEntry[], opts: { now?: number } = {}): KbGraph {
  const now = opts.now ?? Date.now();
  const nodes = new Map<KbKey, KbNode>();
  // Bare-slug → key, wiki winning ties: a `[[oauth]]` written in prose means
  // the concept page, not a raw capture that happens to share the slug.
  const bySlug = new Map<string, KbKey>();

  for (const e of entries) {
    const key = kbKey(e.layer, e.slug);
    nodes.set(key, {
      key,
      layer: e.layer,
      slug: e.slug,
      title: e.title,
      tags: e.tags,
      gist: e.body.replace(/\s+/g, " ").trim().slice(0, 160),
      at: e.updated || e.created || "",
    });
    if (e.layer === "wiki" || !bySlug.has(e.slug)) bySlug.set(e.slug, key);
  }

  const forward = new Map<KbKey, KbKey[]>();
  const back = new Map<KbKey, KbKey[]>();
  const broken: { from: KbKey; target: string }[] = [];

  const addEdge = (from: KbKey, to: KbKey): void => {
    const f = forward.get(from) ?? [];
    if (!f.includes(to)) f.push(to);
    forward.set(from, f);
    const b = back.get(to) ?? [];
    if (!b.includes(from)) b.push(from);
    back.set(to, b);
  };

  for (const e of entries) {
    const from = kbKey(e.layer, e.slug);
    const targets = [
      ...parseWikilinks(e.body),
      // A wiki page's `sources:` frontmatter is a real edge too — it is how a
      // distilled page records what it was distilled from.
      ...(e.layer === "wiki" ? (e.sources ?? []) : []),
    ];
    for (const target of targets) {
      const to = bySlug.get(target) ?? (nodes.has(target) ? target : undefined);
      if (!to || to === from) {
        if (!to) broken.push({ from, target });
        continue;
      }
      addEdge(from, to);
    }
  }

  const tags = new Map<string, KbKey[]>();
  for (const node of nodes.values()) {
    for (const tag of node.tags) {
      const list = tags.get(tag) ?? [];
      list.push(node.key);
      tags.set(tag, list);
    }
  }

  const hubs = [...nodes.values()]
    .filter((n) => n.layer === "wiki")
    .map((n) => {
      const backlinks = back.get(n.key)?.length ?? 0;
      return { key: n.key, backlinks, score: (1 + backlinks) * recencyWeight(n.at, now) };
    })
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  const orphans = [...nodes.values()]
    .filter(
      (n) =>
        n.layer === "wiki" &&
        !(forward.get(n.key)?.length ?? 0) &&
        !(back.get(n.key)?.length ?? 0),
    )
    .map((n) => n.key)
    .sort();

  return { nodes, forward, back, orphans, hubs, tags, broken };
}

/** Tags by usage, most-used first — the shape the index renders. */
export function sortedTags(graph: KbGraph): { tag: string; count: number }[] {
  return [...graph.tags.entries()]
    .map(([tag, keys]) => ({ tag, count: keys.length }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Resolve a user/model-supplied reference ("oauth", "kb:oauth", "wiki/oauth", "[[oauth]]"). */
export function resolveRef(graph: KbGraph, ref: string): KbNode | null {
  const cleaned = ref.trim().replace(/^\[\[|\]\]$/g, "").replace(/^kb:/, "").trim();
  if (!cleaned) return null;
  const direct = graph.nodes.get(cleaned);
  if (direct) return direct;
  for (const layer of ["wiki", "sources"] as KbLayer[]) {
    const node = graph.nodes.get(kbKey(layer, cleaned));
    if (node) return node;
  }
  return null;
}

/** Serializable form of the graph — written to kb/index.json for the UI and tools. */
export interface KbGraphJson {
  generatedAt: string;
  nodes: KbNode[];
  edges: [KbKey, KbKey][];
  hubs: { key: KbKey; score: number; backlinks: number }[];
  orphans: KbKey[];
  broken: { from: KbKey; target: string }[];
}

export function graphToJson(graph: KbGraph, generatedAt: string): KbGraphJson {
  const edges: [KbKey, KbKey][] = [];
  for (const [from, tos] of graph.forward) for (const to of tos) edges.push([from, to]);
  return {
    generatedAt,
    nodes: [...graph.nodes.values()],
    edges,
    hubs: graph.hubs,
    orphans: graph.orphans,
    broken: graph.broken,
  };
}
