import path from "node:path";
import { LISA_HOME } from "../paths.js";
import { assertSafeSlug } from "../soul/slug.js";

/**
 * Personal knowledge base — the user-owned, Karpathy-style 3-layer store.
 * Lives under ~/.lisa/kb/ as its own directory (and its own git repo for
 * provenance), separate from soul/ so a large KB never bloats soul history and
 * the privacy boundary stays clean (soul = Lisa's private self, kb = shared).
 *
 * Layers (see docs/PLAN_KNOWLEDGE_BASE_v1.0.md):
 *   sources/  — Layer 1, immutable raw captures (chat excerpts, pasted docs)
 *   wiki/     — Layer 2, Lisa-maintained concept/entity/synthesis pages
 *   SCHEMA.md — Layer 3, the rules doc telling Lisa how to work the KB
 *   index.md  — generated table-of-contents (kept small, injected always-on)
 */
export const KB_DIR = path.join(LISA_HOME, "kb");
export const KB_SOURCES_DIR = path.join(KB_DIR, "sources");
export const KB_WIKI_DIR = path.join(KB_DIR, "wiki");
export const KB_SCHEMA_FILE = path.join(KB_DIR, "SCHEMA.md");
export const KB_INDEX_FILE = path.join(KB_DIR, "index.md");
export const KB_LOCK_PATH = path.join(KB_DIR, ".write.lock");

export type KbLayer = "sources" | "wiki";

export function layerDir(layer: KbLayer): string {
  return layer === "sources" ? KB_SOURCES_DIR : KB_WIKI_DIR;
}

/**
 * Filesystem path for an entry. The slug is run through assertSafeSlug (the
 * shared path-traversal gate) so a slug like "../../etc/x" throws rather than
 * escaping the KB dir — this is the single chokepoint jailing every KB write.
 */
export function entryFile(layer: KbLayer, slug: string): string {
  return path.join(layerDir(layer), `${assertSafeSlug(slug)}.md`);
}
