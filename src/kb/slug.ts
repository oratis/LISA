/**
 * Slug minting for KB entries.
 *
 * The shared `normalizeSlug` (soul/slug.ts) does `replace(/[^a-z0-9]+/g, "-")`,
 * which is right for soul entries (Lisa names those herself, in English) and
 * wrong the moment a title is Chinese: the whole string is stripped, the slug
 * comes back empty, and the caller falls back to `entry-<Date.now()>`. Every
 * Chinese source in the KB therefore got an opaque, unstable, un-dedupable id.
 *
 * `kbSlug` keeps the latin path exactly as it was and gives non-latin titles a
 * stable, meaningful id instead: `<date>-<8 hex of sha256(url ?? title)>`.
 *
 * Why the slug stays ASCII rather than just using the Chinese title:
 *   - macOS stores filenames as NFD, Linux/git as NFC. A CJK filename written
 *     on one and read on the other is a different byte string — the file "does
 *     not exist" on the other machine, which is a miserable bug to chase in a
 *     dir that syncs.
 *   - slugs land in URLs (/api/kb/entry?slug=…) and git paths.
 *   - readability is the `title:` frontmatter's job, and every surface (index,
 *     search, kb_list, the web UI) shows the title, not the slug.
 *
 * Hashing the URL (when there is one) also makes the slug the natural dedupe
 * key: re-ingesting the same link mints the same slug.
 */
import { createHash } from "node:crypto";
import { normalizeSlug } from "../soul/slug.js";

/** Shortest latin slug we'll accept before falling back to the hashed form. */
const MIN_LATIN_LEN = 3;

export interface KbSlugInput {
  title: string;
  /** Canonical URL, when the entry came from one — makes the slug dedupe-stable. */
  url?: string;
  /** ISO timestamp or YYYY-MM-DD; defaults to now. Only the date part is used. */
  date?: string;
}

/**
 * Mint a slug for a new KB entry. Latin titles slug as before; anything that
 * normalizes to less than 3 usable characters (CJK, emoji, punctuation-only)
 * gets `YYYY-MM-DD-<hash8>`.
 */
export function kbSlug(input: KbSlugInput): string {
  const latin = normalizeSlug(input.title);
  if (latin.length >= MIN_LATIN_LEN) return latin;
  const date = (input.date ?? new Date().toISOString()).slice(0, 10);
  return `${date}-${shortHash(input.url || input.title)}`;
}

/** First 8 hex chars of sha256 — the KB's short, stable content id. */
export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Canonical form of a URL for dedupe: lowercase host, no fragment, no trailing
 * slash on the path, and the usual tracking params dropped so the same article
 * shared from two places hashes the same.
 *
 * Returns the input unchanged if it isn't parseable — the caller still gets a
 * deterministic dedupe key, just a less forgiving one.
 */
export function canonicalUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const p of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase()) || p.toLowerCase().startsWith("utm_")) {
      u.searchParams.delete(p);
    }
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  return u.toString();
}

/**
 * Only unambiguous tracking params. Deliberately NOT here: `from`, `t`,
 * `timestamp` — those carry real meaning on some sites (a video seek position,
 * a real query filter), and this canonical URL is also what we store as the
 * entry's `url:`, so stripping a meaningful param would hand the user a broken
 * link back.
 */
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "ref_src",
  "spm", "spm_id_from", "vd_source", // bilibili
  "share_source", "share_medium", "share_plat", "share_tag", "unique_k",
  "srcid", "isappinstalled", "scene", "clicktime", // wechat app appendages
  "si", "feature", "pp", // youtube share links
]);
