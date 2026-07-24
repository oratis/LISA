/**
 * memory ⇄ KB linking: inline titles for `[[kb:slug]]` pointers.
 *
 * Memory (MEMORY.md / USER.md) is capped at a few KB (memory/store.ts), so the
 * intended shape is: knowledge lives in the KB, memory holds `[[kb:slug]]`
 * pointers. But a bare pointer is opaque in the prompt — `[[kb:2026-07-21-
 * 9f3ac1de]]` tells Lisa nothing about whether it's worth a kb_read. So at
 * prompt-assembly time each resolvable link gets its title appended in place:
 *
 *     [[kb:oauth]]  →  [[kb:oauth]](OAuth 与 PKCE)
 *
 * Links that resolve to nothing are left EXACTLY as written — a link to a page
 * that doesn't exist yet is a "this page should be written" signal for the idle
 * tending pass, not garbage to clean up.
 *
 * Titles come from kb/index.json (regenerated on every KB mutation by the
 * store), guarded by a stat fingerprint — NOT from a full-KB read.
 * buildSystemPromptSnapshot runs every turn, so this path must cost one stat()
 * in the common case.
 */
import fs from "node:fs/promises";
import { kbGraphFile } from "./paths.js";

/**
 * A plain wikilink: `[[slug]]` or `[[kb:slug]]`, with no display text (`|`)
 * and not already followed by a `(…)` annotation — matching links.ts's grammar
 * minus the forms that already carry their own label.
 */
const PLAIN_WIKILINK = /\[\[\s*(?:kb:)?([^\]|#\n]+?)\s*\]\](?!\()/g;

/**
 * Pure annotator: append `(title)` to each plain wikilink `titleFor` can
 * resolve. Unresolvable links, links with display text, and links already
 * annotated pass through untouched.
 */
export function annotateKbLinks(
  text: string,
  titleFor: (ref: string) => string | undefined,
): string {
  return text.replace(PLAIN_WIKILINK, (match, target: string) => {
    const title = titleFor(target.trim());
    // title === slug adds no information — leave the link bare.
    if (!title || title === target.trim()) return match;
    return `${match}(${title})`;
  });
}

// ── cached title lookup over kb/index.json ────────────────────────────

let cache: { fp: string; titles: Map<string, string> } | null = null;

/** Test hook / explicit invalidation. */
export function clearKbTitleCache(): void {
  cache = null;
}

/**
 * slug → title map from kb/index.json. Bare slugs resolve wiki-first (same tie
 * rule as links.ts: `[[oauth]]` in prose means the concept page); `layer/slug`
 * keys are also mapped so qualified refs resolve too. Missing or unparseable
 * index.json → empty map (no annotations, never an error).
 */
export async function kbLinkTitles(): Promise<Map<string, string>> {
  const file = kbGraphFile();
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return new Map();
  }
  const fp = `${file}:${Math.floor(st.mtimeMs)}:${st.size}`;
  if (cache && cache.fp === fp) return cache.titles;

  const titles = new Map<string, string>();
  try {
    const json = JSON.parse(await fs.readFile(file, "utf8")) as {
      nodes?: { key?: string; layer?: string; slug?: string; title?: string }[];
    };
    for (const n of json.nodes ?? []) {
      if (!n.slug || !n.title) continue;
      if (n.key) titles.set(n.key, n.title);
      if (n.layer === "wiki" || !titles.has(n.slug)) titles.set(n.slug, n.title);
    }
  } catch {
    // Corrupt / mid-write index.json: skip annotations this turn rather than
    // failing the whole prompt build. Not cached — retry next turn.
    return titles;
  }
  cache = { fp, titles };
  return titles;
}

/**
 * The composed form prompt.ts uses: annotate `text` against the current KB.
 * Fast-exits without touching disk when the text has no `[[` at all — the
 * common case for users who haven't adopted link-style memory.
 */
export async function annotateMemoryKbLinks(text: string): Promise<string> {
  if (!text.includes("[[")) return text;
  const titles = await kbLinkTitles();
  if (titles.size === 0) return text;
  return annotateKbLinks(text, (ref) => titles.get(ref));
}
