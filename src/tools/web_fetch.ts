import type { ToolDefinition } from "../types.js";

interface WebFetchInput {
  url: string;
  format?: "text" | "raw";
  max_chars?: number;
}

const DEFAULT_MAX = 32_000;
const HARD_MAX = 200_000;

export const webFetchTool: ToolDefinition<WebFetchInput, string> = {
  name: "web_fetch",
  description:
    "Fetch a URL via HTTP(S) GET. Returns status, content-type, and body. " +
    "By default HTML is converted to readable text (scripts, styles, tags stripped). " +
    "Pass format='raw' to keep the original markup. Default 32KB cap, max 200KB. " +
    "Refuses loopback and private/internal IP ranges to avoid SSRF.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL" },
      format: { type: "string", enum: ["text", "raw"] },
      max_chars: { type: "integer", minimum: 100, maximum: HARD_MAX },
    },
    required: ["url"],
  },
  async execute(input, ctx) {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new Error(`bad URL: ${input.url}`);
    }
    assertAllowedUrl(parsed);

    const max = Math.min(input.max_chars ?? DEFAULT_MAX, HARD_MAX);
    // Follow redirects MANUALLY so every hop's host is re-validated. With
    // redirect:"follow" a public URL could 301 → http://127.0.0.1:8000 and
    // the fetch would reach the internal service (SSRF). We re-run the
    // private-host + protocol check on each Location before following.
    const res = await fetchFollowingSafeRedirects(input.url, ctx?.signal);
    const ct = res.headers.get("content-type") ?? "";
    let body = await res.text();
    if (input.format !== "raw" && /html|xml/i.test(ct)) {
      body = htmlToText(body);
    }
    if (body.length > max) {
      body = body.slice(0, max) + `\n\n[truncated at ${max} chars]`;
    }
    return `HTTP ${res.status} ${res.statusText}  ${input.url}\ncontent-type: ${ct}\n\n${body}`;
  },
};

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Throw if the URL isn't http(s) or resolves to a private/loopback host. */
export function assertAllowedUrl(u: URL): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`only http(s) URLs allowed (got ${u.protocol})`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isPrivateHost(host)) {
    throw new Error(`refusing to fetch private/loopback host: ${host}`);
  }
}

/** Request options callers (kb ingest adapters) may add — still SSRF-guarded. */
export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * fetch() with manual redirect handling. Validates the host of EACH hop
 * (initial + every Location) against the private-IP blocklist before
 * issuing the request — closing the SSRF redirect bypass. Caps at
 * MAX_REDIRECTS to avoid loops.
 *
 * `init` lets KB ingest adapters send API POSTs / cookie headers through the
 * SAME guarded path instead of growing a second fetch (and a second SSRF
 * surface). Caller headers win over the defaults.
 */
export async function fetchFollowingSafeRedirects(
  startUrl: string,
  signal: AbortSignal | undefined,
  init?: SafeFetchInit,
): Promise<Response> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedUrl(new URL(current));
    const res = await fetch(current, {
      signal,
      redirect: "manual",
      method: init?.method ?? "GET",
      body: init?.body,
      headers: {
        "user-agent": "Lisa/0.1 (web_fetch)",
        accept:
          "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8",
        ...(init?.headers ?? {}),
      },
    });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get("location");
    if (!location) return res; // redirect with no target — return as-is
    // Resolve relative Location against the current URL, then loop to
    // re-validate the new host before following.
    current = new URL(location, current).toString();
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS}) starting from ${startUrl}`);
}

export function isPrivateHost(host: string): boolean {
  if (host === "localhost") return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true;
  if (/^0\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // IPv6 ULA
  if (/^fe80:/.test(host)) return true; // IPv6 link-local
  return false;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<\/?(?:p|div|br|li|tr|h[1-6]|section|article|header|footer|nav|hr)[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/[\t ]+/g, " ")
    .replace(/\n[\t ]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
