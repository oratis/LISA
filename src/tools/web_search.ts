import type { ToolDefinition } from "../types.js";
import { htmlToText } from "./web_fetch.js";

interface WebSearchInput {
  query: string;
  limit?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const webSearchTool: ToolDefinition<WebSearchInput, string> = {
  name: "web_search",
  description:
    "Search the web via DuckDuckGo (no API key needed). " +
    "Returns the top matches with title, URL, and a short snippet. " +
    "For pulling content from a specific URL use web_fetch.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query"],
  },
  async execute(input, ctx) {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 20));
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
    const res = await fetch(url, {
      signal: ctx.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 Lisa/0.1",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      throw new Error(`duckduckgo HTTP ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    const results = parseDuckDuckGo(html, limit);
    if (results.length === 0) {
      return `(no results for "${input.query}" — DDG may have throttled or changed layout)`;
    }
    return results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
      )
      .join("\n\n");
  },
};

function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  const blockRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*\bresult\b|<div[^>]*class="[^"]*nav-link)/g;
  // Fallback: if the above doesn't bracket cleanly, just iterate result__a
  const linkRe =
    /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe =
    /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && links.length < limit * 2) {
    links.push({ url: unwrapDdgUrl(m[1]!), title: htmlToText(m[2]!) });
  }
  const snippets: string[] = [];
  while ((m = snipRe.exec(html)) && snippets.length < limit * 2) {
    snippets.push(htmlToText(m[1]!));
  }
  for (let i = 0; i < links.length && out.length < limit; i++) {
    const link = links[i]!;
    if (!/^https?:\/\//.test(link.url)) continue;
    out.push({
      title: link.title,
      url: link.url,
      snippet: snippets[i] ?? "",
    });
  }
  // Suppress unused-variable warning for blockRe (kept for future use)
  void blockRe;
  return out;
}

function unwrapDdgUrl(href: string): string {
  // DuckDuckGo wraps result URLs in /l/?uddg=<encoded>
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      // fall through
    }
  }
  if (href.startsWith("//")) return "https:" + href;
  return href;
}
