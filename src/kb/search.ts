/**
 * TF-IDF search over the knowledge base (sources + wiki), mirroring the memory
 * transcript index (memory/vector.ts) but over KB entries keyed by layer/slug.
 * Kept self-contained (own index, own cache) so the KB doesn't couple to
 * memory's session-specific index; only the tokenizer is shared (../tokenize.ts
 * — see there for why CJK needs bigrams). The index is fingerprint-cached over
 * the KB dirs, so repeated searches in one conversation are free until the KB
 * actually changes.
 *
 * (Semantic/embedding search is a deliberate future enhancement — it can reuse
 * memory/embedding.ts the same way memory_search does; TF-IDF is the robust,
 * dependency-free default and is well-suited to a curated KB with good titles.)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../fs-utils.js";
import { tokenize } from "../tokenize.js";
import { kbSourcesDir, kbWikiDir, layerDir, type KbLayer } from "./paths.js";
import { readEntry } from "./store.js";

interface KbDoc {
  layer: KbLayer;
  slug: string;
  title: string;
  text: string;
  termFreq: Map<string, number>;
}

export interface KbIndex {
  docs: KbDoc[];
  idf: Map<string, number>;
}

export interface KbHit {
  layer: KbLayer;
  slug: string;
  title: string;
  score: number;
  excerpt: string;
}

function excerptAround(text: string, qTokens: string[], width: number): string {
  const lower = text.toLowerCase();
  for (const t of qTokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0) {
      const start = Math.max(0, idx - width / 2);
      const end = Math.min(text.length, idx + width / 2);
      return (
        (start > 0 ? "…" : "") +
        text.slice(start, end).replace(/\s+/g, " ").trim() +
        (end < text.length ? "…" : "")
      );
    }
  }
  return text.slice(0, width).replace(/\s+/g, " ").trim();
}

// ── fingerprint cache ─────────────────────────────────────────────────

let cachedIndex: KbIndex | null = null;
let cachedFingerprint = "";

async function kbFingerprint(): Promise<string> {
  const parts: string[] = [];
  for (const dir of [kbWikiDir(), kbSourcesDir()]) {
    if (!(await pathExists(dir))) continue;
    for (const f of (await fs.readdir(dir)).sort()) {
      if (!f.endsWith(".md")) continue;
      try {
        const st = await fs.stat(path.join(dir, f));
        parts.push(`${dir}/${f}:${st.mtimeMs}:${st.size}`);
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return parts.join("|");
}

/** Drop the cached index (test hook / explicit invalidation). */
export function clearKbIndexCache(): void {
  cachedIndex = null;
  cachedFingerprint = "";
}

export async function buildKbIndex(opts: { cache?: boolean } = {}): Promise<KbIndex> {
  if (opts.cache !== false) {
    const fp = await kbFingerprint();
    if (cachedIndex && fp === cachedFingerprint) return cachedIndex;
    const built = await buildUncached();
    cachedIndex = built;
    cachedFingerprint = fp;
    return built;
  }
  return buildUncached();
}

async function buildUncached(): Promise<KbIndex> {
  const docs: KbDoc[] = [];
  const docFreq = new Map<string, number>();
  for (const layer of ["wiki", "sources"] as KbLayer[]) {
    const dir = layerDir(layer);
    if (!(await pathExists(dir))) continue;
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".md")) continue;
      const slug = f.slice(0, -3);
      const e = await readEntry(layer, slug).catch(() => null);
      if (!e) continue;
      // Title + tags are weighted into the searchable text so a title/tag hit ranks.
      const text = [e.title, e.tags.join(" "), e.body].filter(Boolean).join("\n");
      const tokens = tokenize(text);
      if (tokens.length === 0) continue;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of new Set(tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      docs.push({ layer, slug, title: e.title, text, termFreq: tf });
    }
  }
  const idf = new Map<string, number>();
  const N = Math.max(1, docs.length);
  for (const [term, df] of docFreq) idf.set(term, Math.log(1 + N / df));
  return { docs, idf };
}

export function searchKbIndex(index: KbIndex, query: string, k = 5): KbHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const qFreq = new Map<string, number>();
  for (const t of qTokens) qFreq.set(t, (qFreq.get(t) ?? 0) + 1);
  const scored: { doc: KbDoc; score: number }[] = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const [term, qf] of qFreq) {
      const tf = doc.termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      score += qf * tf * (index.idf.get(term) ?? 0);
    }
    if (score > 0) scored.push({ doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => ({
    layer: s.doc.layer,
    slug: s.doc.slug,
    title: s.doc.title,
    score: s.score,
    excerpt: excerptAround(s.doc.text, qTokens, 200),
  }));
}

/** Convenience: build (cached) + search. */
export async function searchKb(query: string, k = 5): Promise<KbHit[]> {
  return searchKbIndex(await buildKbIndex(), query, k);
}
