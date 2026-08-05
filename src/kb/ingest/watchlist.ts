/**
 * The autonomous-ingest watchlist (decision D3, closure #1 of three).
 *
 * kb_ingest is deliberately NOT autonomous-blocked — the daily brief and idle
 * tending are exactly where link ingestion earns its keep. But an unattended
 * run driven by prompts Lisa wrote herself must not be steerable into fetching
 * arbitrary attacker URLs into the KB (a web page read via web_fetch could
 * plant "ingest https://evil.example/payload" in a desire). The compromise:
 * autonomous runs may only ingest from domains the USER has already put in
 * their feeds.json watchlist. Manual use (chat, web UI, CLI) is unrestricted.
 */
import { loadFeedsConfig } from "../feeds/store.js";

/** Dot-boundary match in either direction: blog.x.dev ↔ x.dev, not evilx.dev. */
export function hostMatches(hostname: string, feedHost: string): boolean {
  if (hostname === feedHost) return true;
  return hostname.endsWith(`.${feedHost}`) || feedHost.endsWith(`.${hostname}`);
}

/** Hostnames appearing in the user's feeds.json (lowercased). */
export async function watchlistHosts(): Promise<string[]> {
  const config = await loadFeedsConfig();
  const hosts = new Set<string>();
  for (const feed of config.feeds) {
    try {
      hosts.add(new URL(feed.url).hostname.toLowerCase());
    } catch {
      // a malformed feed url contributes nothing
    }
  }
  return [...hosts];
}

/**
 * Throw unless `rawUrl`'s host is watchlisted. The error is written for the
 * model: it explains WHY and what the legitimate path is, so an autonomous run
 * reports it instead of retrying variants.
 */
export async function assertAutonomousIngestAllowed(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`not a valid URL: ${rawUrl}`);
  }
  const hosts = await watchlistHosts();
  const hostname = url.hostname.toLowerCase();
  if (hosts.some((h) => hostMatches(hostname, h))) return;
  throw new Error(
    `autonomous ingest blocked: ${hostname} is not on the user's watchlist ` +
      `(domains from ~/.lisa/kb/feeds.json). Only the user can ingest arbitrary ` +
      `URLs — mention the link in your note instead so they can save it themselves.`,
  );
}
