/**
 * Conservative title → [[link]] autolinker.
 *
 * When Lisa distills a new wiki page, prose that names an existing page should
 * become a link — links are what the whole graph layer feeds on (backlinks,
 * hub ranking, index ordering). But a WRONG link is worse than a missing one:
 * index.md sorts by (backlinks × recency), so spurious edges corrupt exactly
 * the signal the always-on prompt is ordered by. Hence deliberately
 * conservative — "宁可漏不可错":
 *
 *   - whole-word matches of existing page TITLES only (no tags, no fuzzy,
 *     case-sensitive)
 *   - first occurrence per title only; longer titles claim first so
 *     "OAuth PKCE" wins over "OAuth"
 *   - never inside fenced/inline/indented code, existing [[wikilinks]], or
 *     markdown [text](url) links
 *   - too-short titles are skipped entirely (short ASCII words and single CJK
 *     chars match half of any document)
 *
 * Pure over its inputs; the caller (kb_write) does the I/O and excludes the
 * page being written from `nodes`.
 */

export interface AutolinkNode {
  slug: string;
  title: string;
}

type Range = [start: number, end: number];

const ASCII_WORD = /[A-Za-z0-9_]/;
const HAS_CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

/** Titles below these lengths are noise, not concepts. */
function linkableTitle(title: string): boolean {
  return HAS_CJK.test(title) ? title.length >= 2 : title.length >= 3;
}

/**
 * Spans of `body` that must never be rewritten: code (fenced, inline, and
 * blank-line-preceded indented blocks), existing wikilinks (with an optional
 * `(…)` annotation), and markdown links.
 */
function protectedRanges(body: string): Range[] {
  const ranges: Range[] = [];
  const collect = (re: RegExp): void => {
    for (const m of body.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  };
  collect(/```[\s\S]*?(?:```|$)/g); // unterminated fence protects to the end
  collect(/`[^`\n]+`/g);
  collect(/\[\[[^\]\n]*\]\](?:\([^)\n]*\))?/g);
  collect(/\[[^\]\n]*\]\([^)\n]*\)/g);

  // Indented code blocks: runs of 4-space/tab lines preceded by a blank line,
  // excluding ones that read as list continuations (start with a list marker).
  const lines = body.split("\n");
  let offset = 0;
  let prevBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (prevBlank && /^(?: {4}|\t)/.test(line) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) {
      let end = offset + line.length;
      while (i + 1 < lines.length && /^(?: {4}|\t)|^\s*$/.test(lines[i + 1]!)) {
        i++;
        end += 1 + lines[i]!.length;
      }
      ranges.push([offset, end]);
      offset = end + 1;
      prevBlank = true;
      continue;
    }
    prevBlank = line.trim() === "";
    offset += line.length + 1;
  }
  return ranges;
}

function overlaps(start: number, end: number, ranges: Range[]): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

/** ASCII edges must sit on word boundaries; CJK has none, so any edge is fine. */
function boundaryOk(body: string, start: number, end: number, title: string): boolean {
  if (ASCII_WORD.test(title[0]!) && start > 0 && ASCII_WORD.test(body[start - 1]!)) return false;
  const last = title[title.length - 1]!;
  if (ASCII_WORD.test(last) && end < body.length && ASCII_WORD.test(body[end]!)) return false;
  return true;
}

/**
 * Link the first whole-word occurrence of each node's title to its page.
 * Emits `[[slug]]` when the title IS the slug, `[[slug|Title]]` otherwise
 * (CJK titles have hash-based ASCII slugs — the prose must keep reading as
 * prose).
 */
export function autolink(body: string, nodes: AutolinkNode[]): string {
  if (!body || nodes.length === 0) return body;
  const protectedSpans = protectedRanges(body);
  const claimed: Range[] = [];
  const edits: { start: number; end: number; text: string }[] = [];

  const candidates = nodes
    .filter((n) => n.slug && linkableTitle(n.title))
    .sort((a, b) => b.title.length - a.title.length);

  for (const node of candidates) {
    let from = 0;
    while (true) {
      const idx = body.indexOf(node.title, from);
      if (idx < 0) break;
      const end = idx + node.title.length;
      from = idx + 1;
      if (overlaps(idx, end, protectedSpans) || overlaps(idx, end, claimed)) continue;
      if (!boundaryOk(body, idx, end, node.title)) continue;
      claimed.push([idx, end]);
      edits.push({
        start: idx,
        end,
        text: node.title === node.slug ? `[[${node.slug}]]` : `[[${node.slug}|${node.title}]]`,
      });
      break; // first occurrence only
    }
  }

  edits.sort((a, b) => b.start - a.start);
  let out = body;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
