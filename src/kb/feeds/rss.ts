/**
 * Zero-dependency RSS 2.0 / Atom parsing — just enough for the daily brief:
 * item id, title, link, published time, and a text summary. Feed XML in the
 * wild is reliably messy, so this is regex-per-item with CDATA/entity
 * handling and graceful blanks, not a validating parser: an item we can't
 * fully read still surfaces with whatever fields it had.
 */
import { decodeEntities } from "../ingest/html-to-md.js";

export interface FeedItem {
  /** guid/id, else the link, else a title+date composite — stable enough to dedupe. */
  id: string;
  title: string;
  link?: string;
  /** ISO-ish date string as found (RFC822 or ISO); Date.parse-able in practice. */
  published?: string;
  /** Plain text, tags stripped, capped. */
  summary?: string;
}

export interface ParsedFeed {
  title?: string;
  items: FeedItem[];
}

const SUMMARY_MAX = 500;

function unwrapCdata(raw: string): string {
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** First match of any of the tag names, innerXML. */
function tagText(block: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
    const m = re.exec(block);
    if (m?.[1] != null) {
      const text = decodeEntities(unwrapCdata(m[1]).trim());
      if (text) return text;
    }
  }
  return undefined;
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** Atom links live in attributes; prefer rel="alternate", else the first href. */
function atomLink(block: string): string | undefined {
  let fallback: string | undefined;
  for (const m of block.matchAll(/<link\b([^>]*)\/?>(?:<\/link>)?/gi)) {
    const attrs = m[1] ?? "";
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!rel || rel === "alternate") return decodeEntities(href);
    fallback ??= decodeEntities(href);
  }
  return fallback;
}

function parseBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  for (const m of xml.matchAll(re)) out.push(m[1]!);
  return out;
}

export function parseFeed(xml: string): ParsedFeed {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = isAtom ? parseBlocks(xml, "entry") : parseBlocks(xml, "item");

  // Feed title = the first <title> before any item/entry block.
  const head = xml.slice(0, blocks.length ? xml.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i) : xml.length);
  const feedTitle = tagText(head, "title");

  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = tagText(block, "title") ?? "(untitled)";
    const link = isAtom
      ? atomLink(block)
      : tagText(block, "link") ?? /<link\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(block)?.[1];
    const published = tagText(block, "pubDate", "published", "updated", "dc:date");
    const rawSummary =
      tagText(block, "content:encoded", "description", "summary", "content") ?? "";
    const id = tagText(block, "guid", "id") ?? link ?? `${title}#${published ?? ""}`;
    items.push({
      id,
      title: stripTags(title),
      link,
      published,
      summary: rawSummary ? stripTags(rawSummary).slice(0, SUMMARY_MAX) : undefined,
    });
  }
  return { title: feedTitle ? stripTags(feedTitle) : undefined, items };
}
