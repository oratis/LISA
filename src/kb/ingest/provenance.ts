/**
 * Provenance metadata for an ingested page — the frontmatter that makes a
 * Layer-1 capture citeable later ("where did this come from, who wrote it,
 * when"). Sources checked in rough order of reliability: OpenGraph /
 * article:* meta, JSON-LD (Article types), then plain <title> / <html lang> /
 * rel=canonical. All fields optional; absence is recorded by omission.
 */
import { decodeEntities } from "./html-to-md.js";

export interface Provenance {
  title?: string;
  site?: string;
  author?: string;
  /** ISO date (as found; not re-validated beyond a sanity parse). */
  published?: string;
  lang?: string;
  canonical?: string;
}

/** All <meta> name/property → content pairs, lowercased keys. */
function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\s+((?:"[^"]*"|'[^']*'|[^"'>])*)>/gi)) {
    const attrs = m[1]!;
    const key =
      /(?:name|property|itemprop)\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const val = content?.[1] ?? content?.[2];
    if (key && val && !out.has(key)) out.set(key, decodeEntities(val).trim());
  }
  return out;
}

/** First JSON-LD block of an Article-ish @type, parsed leniently. */
function articleJsonLd(html: string): Record<string, unknown> | null {
  const ARTICLE_TYPES = /"@type"\s*:\s*"(?:News|Blog|Scholarly|Tech|Report(?:age)?)?(?:Article|Posting)"/;
  for (const m of html.matchAll(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = m[1]!.trim();
    if (!ARTICLE_TYPES.test(raw)) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : [parsed, ...(((parsed as Record<string, unknown>)["@graph"] as unknown[]) ?? [])];
      for (const item of list) {
        const obj = item as Record<string, unknown>;
        if (typeof obj?.["@type"] === "string" && /Article|Posting/.test(obj["@type"])) {
          return obj;
        }
      }
    } catch {
      // malformed JSON-LD is routine — ignore the block
    }
  }
  return null;
}

function jsonLdAuthor(obj: Record<string, unknown>): string | undefined {
  const a = obj.author;
  if (typeof a === "string") return a;
  if (Array.isArray(a)) {
    const names = a
      .map((x) => (typeof x === "string" ? x : (x as Record<string, unknown>)?.name))
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    if (names.length) return names.join(", ");
  }
  if (a && typeof a === "object") {
    const name = (a as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

function sane(val: string | undefined, max = 300): string | undefined {
  const v = val?.trim();
  return v ? v.slice(0, max) : undefined;
}

/** A published date is only kept if it parses to a plausible time. */
function saneDate(val: string | undefined): string | undefined {
  const v = sane(val, 40);
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > Date.parse("1990-01-01") ? v : undefined;
}

export function extractProvenance(html: string): Provenance {
  const meta = metaTags(html);
  const ld = articleJsonLd(html);

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const canonical =
    /<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ??
    /<link\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']canonical["']/i.exec(html)?.[1];
  const lang = /<html[^>]*\slang\s*=\s*["']?([a-zA-Z-]+)/i.exec(html)?.[1];

  return {
    title: sane(
      meta.get("og:title") ??
        (typeof ld?.headline === "string" ? ld.headline : undefined) ??
        meta.get("twitter:title") ??
        (titleTag ? decodeEntities(titleTag).trim() : undefined),
    ),
    site: sane(meta.get("og:site_name")),
    author: sane(
      (ld ? jsonLdAuthor(ld) : undefined) ??
        meta.get("article:author") ??
        meta.get("author"),
    ),
    published: saneDate(
      meta.get("article:published_time") ??
        (typeof ld?.datePublished === "string" ? ld.datePublished : undefined) ??
        meta.get("og:article:published_time"),
    ),
    lang: sane(lang, 20),
    canonical: sane(canonical, 2000),
  };
}
