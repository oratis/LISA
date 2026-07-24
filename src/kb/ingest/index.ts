/**
 * `ingestUrl` — the orchestration for "save this link into the KB":
 *
 *   adapter routing → fetch (SSRF-guarded) → main-content extraction →
 *   markdown conversion → provenance frontmatter → dedupe → addSource
 *
 * Adapters (K-F: WeChat, Bilibili, YouTube) take over fetch+extract for hosts
 * whose content isn't reachable as plain article HTML; everything else goes
 * through the generic readability path. All fetching funnels through
 * web_fetch's fetchFollowingSafeRedirects — the per-hop private-host check
 * lives there, and a second fetch path would mean a second SSRF surface
 * (handoff hard rule).
 */
import { fetchFollowingSafeRedirects, assertAllowedUrl } from "../../tools/web_fetch.js";
import { canonicalUrl, shortHash } from "../slug.js";
import { addSource, readEntry, type KbEntry } from "../store.js";
import { elementToMarkdown } from "./html-to-md.js";
import { extractContent } from "./readability.js";
import { extractProvenance } from "./provenance.js";
import { lookupIngested, recordIngested } from "./dedupe.js";

/** What a fetch (generic or adapter) must deliver for the write step. */
export interface IngestedContent {
  /** Markdown body. */
  body: string;
  title?: string;
  /** Extra provenance frontmatter beyond url/hash/via (site/author/published/lang…). */
  extra?: Record<string, string>;
}

export interface IngestContext {
  fetchImpl: (url: string) => Promise<Response>;
  signal?: AbortSignal;
}

/**
 * A site adapter. `match` is consulted in order; the first hit owns the URL.
 * Adapters may fetch multiple resources (APIs, subtitle tracks) but must use
 * ctx.fetchImpl for every request — see the SSRF note above.
 */
export interface IngestAdapter {
  name: string;
  match(url: URL): boolean;
  fetch(url: URL, ctx: IngestContext): Promise<IngestedContent>;
}

/** Populated in K-F (wechat / bilibili / youtube). Order matters. */
export const ADAPTERS: IngestAdapter[] = [];

export interface IngestOptions {
  title?: string;
  tags?: string[];
  /** Re-ingest even if this URL was captured before (new entry + supersedes). */
  force?: boolean;
  signal?: AbortSignal;
  /** Test seam; defaults to the SSRF-guarded fetch. */
  fetchImpl?: (url: string) => Promise<Response>;
}

export interface IngestResult {
  entry: KbEntry;
  /** True when an existing capture was returned instead of a new fetch. */
  deduped: boolean;
  /** Adapter that handled the URL, or "generic". */
  via: string;
}

const MAX_HTML_BYTES = 2_000_000;
/** Below this many characters of markdown, an extraction "worked" but captured nothing. */
const MIN_BODY_CHARS = 80;

export async function ingestUrl(rawUrl: string, opts: IngestOptions = {}): Promise<IngestResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`not a valid URL: ${rawUrl}`);
  }
  // Reject private/loopback targets up front — before dedupe, before adapters,
  // and independently of the per-hop check inside the fetcher.
  assertAllowedUrl(url);

  const canonical = canonicalUrl(url.toString());
  const hash = shortHash(canonical);

  if (!opts.force) {
    const existingSlug = await lookupIngested(hash);
    if (existingSlug) {
      const existing = await readEntry("sources", existingSlug);
      // A stale ledger entry (source deleted by the user) falls through to a
      // fresh ingest rather than erroring.
      if (existing) return { entry: existing, deduped: true, via: "ledger" };
    }
  }

  const ctx: IngestContext = {
    fetchImpl:
      opts.fetchImpl ?? ((u: string) => fetchFollowingSafeRedirects(u, opts.signal)),
    signal: opts.signal,
  };

  const adapter = ADAPTERS.find((a) => a.match(url));
  const content = adapter ? await adapter.fetch(url, ctx) : await genericFetch(url, ctx);
  const via = adapter?.name ?? "generic";

  const body = content.body.trim();
  if (body.length < MIN_BODY_CHARS) {
    throw new Error(
      `could not extract readable content from ${url.hostname} — ` +
        `the page may be login-walled or script-rendered. ` +
        `You can paste the text directly with kb_add instead.`,
    );
  }

  const supersedes = opts.force ? await lookupIngested(hash) : null;
  const extra: Record<string, string> = {
    url: canonical,
    hash,
    via,
    ...(content.extra ?? {}),
    ...(supersedes ? { supersedes } : {}),
  };

  const entry = await addSource({
    title: (opts.title ?? content.title ?? url.hostname).trim() || url.hostname,
    body,
    tags: opts.tags,
    origin: "web",
    extra,
  });
  await recordIngested(hash, entry.slug);
  return { entry, deduped: false, via };
}

/** Read a response body as UTF-8, stopping once `cap` bytes have been buffered. */
async function readBodyCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, cap);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = cap - total;
      chunks.push(value.length > room ? value.subarray(0, room) : value);
      total += value.length;
      if (total >= cap) break; // stop pulling — a hostile server can't grow the buffer past cap
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(buf);
}

/** The default path: fetch HTML, pick the content subtree, convert, annotate. */
async function genericFetch(url: URL, ctx: IngestContext): Promise<IngestedContent> {
  const res = await ctx.fetchImpl(url.toString());
  if (!res.ok) {
    throw new Error(`fetch failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const type = res.headers.get("content-type") ?? "";
  // Reject unsupported types from the header before buffering — no point pulling
  // down a video/PDF just to reject it. Empty type is allowed (treated as HTML).
  if (type && !/html|xml|text\/(?:plain|markdown)/i.test(type)) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`unsupported content-type "${type}" — only HTML and text pages can be ingested`);
  }
  // Reject an oversized body up front when the server declares its length, and
  // cap the actual read so a chunked/undeclared response can't exhaust memory
  // (ingest runs unattended once the daily brief lands).
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`page too large: ${declared} bytes exceeds the ${MAX_HTML_BYTES}-byte cap`);
  }
  const raw = await readBodyCapped(res, MAX_HTML_BYTES);

  // Plain text / markdown responses skip the HTML pipeline entirely.
  if (/text\/(?:plain|markdown)/i.test(type)) {
    return { body: raw.trim() };
  }

  const prov = extractProvenance(raw);
  const { content } = extractContent(raw);
  const body = elementToMarkdown(content);

  const extra: Record<string, string> = {};
  if (prov.site) extra.site = prov.site;
  if (prov.author) extra.author = prov.author;
  if (prov.published) extra.published = prov.published;
  if (prov.lang) extra.lang = prov.lang;

  return { body, title: prov.title, extra };
}
