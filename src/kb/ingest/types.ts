/**
 * Shared shapes for the ingest pipeline. Split from index.ts so site adapters
 * can import them without creating an import cycle (index.ts imports the
 * adapters to register them).
 */
import type { SafeFetchInit } from "../../tools/web_fetch.js";

/** What a fetch (generic or adapter) must deliver for the write step. */
export interface IngestedContent {
  /** Markdown body. */
  body: string;
  title?: string;
  /** Extra provenance frontmatter beyond url/hash/via (site/author/published/lang…). */
  extra?: Record<string, string>;
}

export interface IngestContext {
  /** SSRF-guarded fetch — the ONLY way adapters may touch the network. */
  fetchImpl: (url: string, init?: SafeFetchInit) => Promise<Response>;
  /**
   * yt-dlp escape hatch (subtitle fallback layer 2): dump the info JSON for a
   * video URL, or null when the binary isn't installed / fails. Injected so
   * tests never spawn a process, and so the default impl lives in one place.
   */
  ytDlpDumpJson?: (url: string) => Promise<Record<string, unknown> | null>;
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
