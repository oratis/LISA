/**
 * Main-content extraction — a deliberately small Readability: score candidate
 * container elements on text mass, paragraph count, link density, and
 * class/id hints, then keep the best subtree. The full Readability algorithm
 * earns its complexity on the long tail of weird pages; an ingest pipeline
 * that FALLS BACK TO <body> when unsure doesn't need the tail — a slightly
 * noisy capture is still searchable and distillable, a wrongly-clipped one
 * loses content.
 *
 * Works on the html-to-md.ts tree so there is exactly one HTML parser in the
 * pipeline.
 */
import { parseHtml, type HtmlElement, type HtmlNode } from "./html-to-md.js";

const CANDIDATE_TAGS = new Set(["article", "main", "section", "div", "td", "body"]);

const POSITIVE_HINT = /article|content|post|entry|main|body|text|story|blog/i;
const NEGATIVE_HINT =
  /\bnav\b|navbar|footer|comment|sidebar|side-bar|menu|share|social|related|promo|banner|breadcrumb|masthead|advert|\bad\b|ad-|sponsor|widget|meta|pager|pagination/i;

function isElement(n: HtmlNode): n is HtmlElement {
  return typeof n !== "string";
}

function textLength(el: HtmlElement): number {
  let len = 0;
  for (const n of el.children) {
    len += isElement(n) ? textLength(n) : n.replace(/\s+/g, " ").trim().length;
  }
  return len;
}

function countTag(el: HtmlElement, tag: string): number {
  let count = 0;
  for (const n of el.children) {
    if (!isElement(n)) continue;
    if (n.tag === tag) count++;
    count += countTag(n, tag);
  }
  return count;
}

function linkTextLength(el: HtmlElement): number {
  let len = 0;
  for (const n of el.children) {
    if (!isElement(n)) continue;
    len += n.tag === "a" ? textLength(n) : linkTextLength(n);
  }
  return len;
}

function hintOf(el: HtmlElement): string {
  return `${el.attrs.class ?? ""} ${el.attrs.id ?? ""}`;
}

interface Candidate {
  el: HtmlElement;
  score: number;
}

function collectCandidates(el: HtmlElement, out: Candidate[]): void {
  for (const n of el.children) {
    if (!isElement(n)) continue;
    if (CANDIDATE_TAGS.has(n.tag)) {
      const text = textLength(n);
      if (text >= 140) {
        const links = linkTextLength(n);
        const linkDensity = text > 0 ? links / text : 1;
        const hint = hintOf(n);
        let score = Math.min(text, 8_000) / 40 + countTag(n, "p") * 25;
        if (n.tag === "article" || n.tag === "main") score += 120;
        if (POSITIVE_HINT.test(hint)) score += 100;
        if (NEGATIVE_HINT.test(hint)) score -= 220;
        // Link farms (navs, "related posts") are mostly anchor text.
        score *= 1 - Math.min(linkDensity, 0.9);
        out.push({ el: n, score });
      }
    }
    collectCandidates(n, out);
  }
}

/**
 * The element to hand to the markdown serializer. Falls back to <body> (or
 * the whole tree) when nothing scores clearly.
 */
export function extractContentRoot(root: HtmlElement): HtmlElement {
  const candidates: Candidate[] = [];
  collectCandidates(root, candidates);
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const body = findTag(root, "body");
  // "Clearly better than just taking everything": beat a floor AND carry a
  // meaningful share of the page's text (clipping to a tiny subtree loses the
  // article; noise is recoverable, missing text is not).
  if (best && best.score >= 60 && body) {
    const share = textLength(best.el) / Math.max(1, textLength(body));
    if (share >= 0.2) return best.el;
  }
  if (best && best.score >= 60 && !body) return best.el;
  return body ?? root;
}

export function findTag(el: HtmlElement, tag: string): HtmlElement | null {
  for (const n of el.children) {
    if (!isElement(n)) continue;
    if (n.tag === tag) return n;
    const found = findTag(n, tag);
    if (found) return found;
  }
  return null;
}

/** Convenience: parse + pick in one step (used by ingest and tests). */
export function extractContent(html: string): { root: HtmlElement; content: HtmlElement } {
  const root = parseHtml(html);
  return { root, content: extractContentRoot(root) };
}
