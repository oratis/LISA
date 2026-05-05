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
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`only http(s) URLs allowed (got ${parsed.protocol})`);
    }
    const host = parsed.hostname.toLowerCase();
    if (isPrivateHost(host)) {
      throw new Error(`refusing to fetch private/loopback host: ${host}`);
    }

    const max = Math.min(input.max_chars ?? DEFAULT_MAX, HARD_MAX);
    const res = await fetch(input.url, {
      signal: ctx.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Lisa/0.1 (web_fetch)",
        accept:
          "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8",
      },
    });
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

function isPrivateHost(host: string): boolean {
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
