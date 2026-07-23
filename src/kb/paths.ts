import path from "node:path";
import { lisaHome } from "../paths.js";
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
// KB paths are FUNCTIONS of the active home (per-uid under the cloud edition).
export function kbDir(): string {
  return path.join(lisaHome(), "kb");
}
export function kbSourcesDir(): string {
  return path.join(kbDir(), "sources");
}
export function kbWikiDir(): string {
  return path.join(kbDir(), "wiki");
}
export function kbSchemaFile(): string {
  return path.join(kbDir(), "SCHEMA.md");
}
export function kbIndexFile(): string {
  return path.join(kbDir(), "index.md");
}
/** Machine-readable link graph (index.md's counterpart for the UI and tools). */
export function kbGraphFile(): string {
  return path.join(kbDir(), "index.json");
}
export function kbLockPath(): string {
  return path.join(kbDir(), ".write.lock");
}

export type KbLayer = "sources" | "wiki";

export function layerDir(layer: KbLayer): string {
  return layer === "sources" ? kbSourcesDir() : kbWikiDir();
}

/**
 * Filesystem path for an entry. The slug is run through assertSafeSlug (the
 * shared path-traversal gate) so a slug like "../../etc/x" throws rather than
 * escaping the KB dir — this is the single chokepoint jailing every KB write.
 */
export function entryFile(layer: KbLayer, slug: string): string {
  return path.join(layerDir(layer), `${assertSafeSlug(slug)}.md`);
}
