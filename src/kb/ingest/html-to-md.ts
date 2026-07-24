/**
 * HTML → Markdown, zero-dependency (ingest decision D1: everything the user
 * reads stays local — no remote reader service, no npm HTML pipeline with its
 * own supply chain). A small lenient tree parser + a serializer covering the
 * structures that actually occur in articles: headings, paragraphs, lists
 * (nested), code (fenced + inline), blockquotes, tables, links, images,
 * emphasis, rules.
 *
 * Ordering rule that keeps the output safe: TEXT IS ESCAPED FIRST, markdown
 * syntax is added around it after — so a page whose prose contains `*` or
 * `[[` cannot forge emphasis, links, or (worse) wikilinks into the KB entry.
 */

// ── lenient HTML tree ─────────────────────────────────────────────────

export interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}
export type HtmlNode = HtmlElement | string;

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);
/** Contents dropped entirely — never useful in an article body. */
const DROP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "head"]);

const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\/?>|[^<]+/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    const val = m[3] ?? m[4] ?? (m[2] && !/^["']/.test(m[2]) ? m[2] : "");
    attrs[m[1]!.toLowerCase()] = decodeEntities(val);
  }
  return attrs;
}

/**
 * Parse HTML into a forgiving tree. Mismatched closes pop to the nearest open
 * ancestor of that tag (or are ignored); unclosed tags close at EOF. Raw text
 * (incl. markup-looking text) inside script/style/… is skipped via a raw-text
 * scan so `<script>if (a < b)…</script>` can't derail the tokenizer.
 */
export function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = (): HtmlElement => stack[stack.length - 1]!;

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html))) {
    const token = m[0];
    if (token.startsWith("<!") || token.startsWith("<![")) continue;
    const tag = m[1]?.toLowerCase();
    if (!tag) {
      top().children.push(token);
      continue;
    }
    if (token.startsWith("</")) {
      const idx = stack.findLastIndex((el) => el.tag === tag);
      if (idx > 0) stack.length = idx; // pop through unclosed children
      continue;
    }
    if (DROP_TAGS.has(tag)) {
      // A self-closing drop tag (<svg/>, <iframe/>) has no matching close and no
      // content — skip just the tag. Previously these fell into the no-close
      // branch below and jumped to EOF, silently discarding the rest of the doc.
      if (token.endsWith("/>")) continue;
      // Otherwise skip to this tag's real close without tokenizing its contents.
      // A genuinely unclosed drop tag (malformed page) still drops to EOF rather
      // than leak raw script/style source into the output.
      const close = new RegExp(`</${tag}\\s*>`, "gi");
      close.lastIndex = TAG_RE.lastIndex;
      const c = close.exec(html);
      TAG_RE.lastIndex = c ? close.lastIndex : html.length;
      continue;
    }
    const el: HtmlElement = { tag, attrs: parseAttrs(m[2] ?? ""), children: [] };
    // HTML5 implied closes — bounded by the enclosing container so a nested
    // <ul> inside an <li> doesn't get its parent popped out from under it.
    const implyClose = (targets: string[], stops: string[]): void => {
      for (let i = stack.length - 1; i > 0; i--) {
        const t = stack[i]!.tag;
        if (targets.includes(t)) {
          stack.length = i;
          return;
        }
        if (stops.includes(t)) return;
      }
    };
    if (tag === "li") implyClose(["li"], ["ul", "ol"]);
    else if (tag === "tr") implyClose(["tr"], ["table", "thead", "tbody", "tfoot"]);
    else if (tag === "td" || tag === "th") implyClose(["td", "th"], ["tr", "table"]);
    else if (tag === "p")
      implyClose(["p"], ["blockquote", "li", "td", "th", "section", "article", "div", "body"]);
    top().children.push(el);
    if (!VOID_TAGS.has(tag) && !token.endsWith("/>")) stack.push(el);
  }
  return root;
}

// ── entities + escaping ───────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", ldquo: "“", rdquo: "”",
  lsquo: "‘", rsquo: "’", middot: "·", times: "×", laquo: "«", raquo: "»",
  copy: "©", reg: "®", trade: "™", deg: "°", sect: "§", para: "¶", bull: "•",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Escape characters that would read as markdown syntax in prose. */
function escapeMd(text: string): string {
  return text
    .replace(/([\\`*_[\]])/g, "\\$1")
    // `[[` is already dead via `[` escaping, but pipes forge table cells.
    .replace(/\|/g, "\\|");
}

// ── serialization ─────────────────────────────────────────────────────

const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "font",
  "i", "img", "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strike",
  "strong", "sub", "sup", "time", "u", "var", "wbr", "br", "del",
]);

function isElement(n: HtmlNode): n is HtmlElement {
  return typeof n !== "string";
}

/** Inline content of a node: text + inline markup, whitespace collapsed. */
function inline(nodes: HtmlNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (!isElement(n)) {
      out += escapeMd(decodeEntities(n)).replace(/\s+/g, " ");
      continue;
    }
    switch (n.tag) {
      case "br":
        out += "\n";
        break;
      case "img": {
        const alt = escapeMd(n.attrs.alt ?? "");
        // WeChat and other lazy-loaders park the real URL in data-src.
        const src = n.attrs.src || n.attrs["data-src"] || "";
        if (src) out += `![${alt}](${src})`;
        break;
      }
      case "a": {
        const text = inline(n.children).trim() || n.attrs.href || "";
        const href = n.attrs.href ?? "";
        out += href && !href.startsWith("javascript:") ? `[${text}](${href})` : text;
        break;
      }
      case "strong":
      case "b": {
        const t = inline(n.children).trim();
        out += t ? `**${t}**` : "";
        break;
      }
      case "em":
      case "i": {
        const t = inline(n.children).trim();
        out += t ? `*${t}*` : "";
        break;
      }
      case "del":
      case "s":
      case "strike": {
        const t = inline(n.children).trim();
        out += t ? `~~${t}~~` : "";
        break;
      }
      case "code":
      case "kbd":
      case "samp": {
        const raw = textOf(n).trim();
        if (raw) {
          // A backtick inside inline code needs a longer fence and padding.
          const fence = raw.includes("`") ? "``" : "`";
          out += `${fence}${raw}${fence}`;
        }
        break;
      }
      default:
        out += inline(n.children);
    }
  }
  return out;
}

/** Raw text content (entities decoded, no markdown escaping) — for code. */
function textOf(node: HtmlElement): string {
  let out = "";
  for (const n of node.children) {
    out += isElement(n) ? (n.tag === "br" ? "\n" : textOf(n)) : decodeEntities(n);
  }
  return out;
}

function listItems(el: HtmlElement, ordered: boolean, depth: number): string[] {
  const items: string[] = [];
  let i = 1;
  for (const child of el.children) {
    if (!isElement(child) || child.tag !== "li") continue;
    const marker = ordered ? `${i++}.` : "-";
    // Split the li into its own inline content and nested blocks (sub-lists…).
    const inlineNodes: HtmlNode[] = [];
    const blockNodes: HtmlElement[] = [];
    for (const n of child.children) {
      if (isElement(n) && !INLINE_TAGS.has(n.tag)) blockNodes.push(n);
      else inlineNodes.push(n);
    }
    const head = inline(inlineNodes).trim();
    const indent = "  ".repeat(depth);
    let item = `${indent}${marker} ${head}`;
    for (const b of blockNodes) {
      const sub = serializeBlock(b, depth + 1).trimEnd();
      if (sub) item += `\n${sub}`;
    }
    items.push(item);
  }
  return items;
}

function tableToMd(el: HtmlElement): string {
  const rows: string[][] = [];
  const walkRows = (node: HtmlElement): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (child.tag === "tr") {
        const cells = child.children
          .filter(isElement)
          .filter((c) => c.tag === "td" || c.tag === "th")
          .map((c) => inline(c.children).trim().replace(/\n/g, " "));
        if (cells.length) rows.push(cells);
      } else {
        walkRows(child);
      }
    }
  };
  walkRows(el);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]): string => `| ${pad(r).join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head!), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n");
}

function codeBlock(el: HtmlElement): string {
  // <pre><code class="language-ts"> is the common convention.
  const code = el.children.find((n): n is HtmlElement => isElement(n) && n.tag === "code");
  const cls = (code ?? el).attrs.class ?? "";
  const lang = /(?:language|lang)-([\w+-]+)/.exec(cls)?.[1] ?? "";
  const raw = textOf(code ?? el).replace(/^\n/, "").trimEnd();
  // The body must not be able to terminate its own fence.
  const fence = /^```/m.test(raw) ? "````" : "```";
  return `${fence}${lang}\n${raw}\n${fence}`;
}

function serializeBlock(el: HtmlElement, listDepth: number): string {
  switch (el.tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const level = Number(el.tag[1]);
      const t = inline(el.children).trim().replace(/\n/g, " ");
      return t ? `${"#".repeat(level)} ${t}\n\n` : "";
    }
    case "p": {
      const t = inline(el.children).trim();
      return t ? `${t}\n\n` : "";
    }
    case "ul":
    case "ol": {
      const items = listItems(el, el.tag === "ol", listDepth);
      return items.length ? items.join("\n") + "\n\n" : "";
    }
    case "pre":
      return codeBlock(el) + "\n\n";
    case "blockquote": {
      const innerMd = serializeChildren(el.children, 0).trim();
      if (!innerMd) return "";
      return innerMd.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") + "\n\n";
    }
    case "table": {
      const t = tableToMd(el);
      return t ? t + "\n\n" : "";
    }
    case "hr":
      return "---\n\n";
    case "figure": {
      const body = serializeChildren(el.children, listDepth).trim();
      return body ? body + "\n\n" : "";
    }
    case "figcaption": {
      const t = inline(el.children).trim();
      return t ? `*${t}*\n\n` : "";
    }
    case "br":
      return "";
    default: {
      // Unknown / container block (div, section, article, main, …): recurse.
      return serializeChildren(el.children, listDepth);
    }
  }
}

function serializeChildren(nodes: HtmlNode[], listDepth: number): string {
  let out = "";
  let inlineRun: HtmlNode[] = [];
  const flush = (): void => {
    const t = inline(inlineRun).trim();
    if (t) out += `${t}\n\n`;
    inlineRun = [];
  };
  for (const n of nodes) {
    if (!isElement(n) || INLINE_TAGS.has(n.tag)) {
      inlineRun.push(n);
    } else {
      flush();
      out += serializeBlock(n, listDepth);
    }
  }
  flush();
  return out;
}

/** Serialize a parsed element's contents (readability hands us a subtree). */
export function elementToMarkdown(el: HtmlElement): string {
  return serializeChildren(el.children, 0)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Convert an HTML fragment (or document) to markdown. */
export function htmlToMarkdown(html: string): string {
  const root = parseHtml(html);
  // If there's a <body>, serialize from there; else from the root.
  const findBody = (el: HtmlElement): HtmlElement | null => {
    for (const n of el.children) {
      if (!isElement(n)) continue;
      if (n.tag === "body") return n;
      const found = findBody(n);
      if (found) return found;
    }
    return null;
  };
  const start = findBody(root) ?? root;
  return serializeChildren(start.children, 0)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
