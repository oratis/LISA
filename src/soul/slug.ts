/**
 * Slug safety for soul file paths.
 *
 * Soul state lives one-file-per-entry under ~/.lisa/soul/{values,opinions,
 * desires,relationships}/<slug>.md. The slug comes from the LLM (via
 * soul_patch / desire tools) or from reflect operations, so it is untrusted
 * input that gets joined into a filesystem path. Without validation, a slug
 * like "../../../etc/something" or "foo/bar" would let a write escape the
 * soul directory (path traversal) or silently nest into subdirectories.
 *
 * Two functions, two jobs:
 *   - assertSafeSlug — a HARD GATE applied in every path helper (read AND
 *     write). Throws on anything that could traverse or escape. Deliberately
 *     permissive about case/style so it never breaks reads of slugs written
 *     by older versions; it only blocks genuinely dangerous shapes.
 *   - normalizeSlug — a SOFT CLEANER applied when a NEW slug is first minted
 *     from free-form input. Lowercases, strips to [a-z0-9-], collapses dashes,
 *     caps length — produces a tidy, collision-resistant slug.
 */

export const MAX_SLUG_LEN = 64;

export class UnsafeSlugError extends Error {
  constructor(slug: string, reason: string) {
    super(`unsafe soul slug ${JSON.stringify(slug)}: ${reason}`);
    this.name = "UnsafeSlugError";
  }
}

// Control characters (codepoints 0x00–0x1f): newlines, tabs, null, etc.
// Checked via codepoint so the source stays plain-ASCII.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/**
 * Throw if `slug` could escape its soul subdirectory or corrupt the path.
 * This is the security boundary — applied in paths.ts so no code path can
 * construct a soul file path from a dangerous slug.
 */
export function assertSafeSlug(slug: string): string {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new UnsafeSlugError(String(slug), "empty");
  }
  if (slug.length > MAX_SLUG_LEN) {
    throw new UnsafeSlugError(slug, `longer than ${MAX_SLUG_LEN} chars`);
  }
  if (hasControlChar(slug)) {
    throw new UnsafeSlugError(slug, "contains control characters");
  }
  if (slug.includes("/") || slug.includes("\\")) {
    throw new UnsafeSlugError(slug, "contains a path separator");
  }
  // Block "." / ".." and any leading-dot form — path-traversal primitives
  // and dotfiles that would hide from directory listings.
  if (slug.startsWith(".")) {
    throw new UnsafeSlugError(slug, "starts with a dot");
  }
  return slug;
}

/**
 * Produce a tidy slug from free-form text. Use when minting a NEW slug.
 * - lowercases
 * - replaces any run of non [a-z0-9] with a single dash
 * - trims leading/trailing dashes
 * - caps length
 * Returns "" only if the input had no usable characters; callers should
 * treat "" as "generate a fallback" (e.g. a timestamp-based slug).
 */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, ""); // re-trim in case slice landed mid-dash-run
}
