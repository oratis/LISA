/**
 * Markdown → HTML renderer for Lisa's chat bubbles.
 *
 * Lisa emits standard Markdown (headings, bold, lists, fenced code, tables,
 * blockquotes, rules). The chat client used to drop her text in verbatim via
 * `textContent`, so every `###` / `**` / `-` / ``` showed up as a literal
 * symbol. This turns that Markdown into styled HTML.
 *
 * SOURCE-INJECTED, like agent-roster.ts → island.ts: lisa-html.ts embeds this
 * function's source into the page (`${renderMarkdown}`) so the browser runs
 * exactly this unit-tested code rather than a hand-escaped copy living inside
 * the no-interpolation MAIN_CLIENT_JS template literal (where a stray single
 * backslash silently corrupts a regex — see the `while you were away` sentinel).
 *
 * CONSTRAINT: keep `renderMarkdown` FULLY self-contained — every helper is a
 * nested function, every pattern a local literal, and it may reference only
 * browser globals (String/Array/RegExp). No imports, no module-scope refs, or
 * source-injection breaks. The injection-safety test in md-render.test.ts
 * rebuilds it from `.toString()` to guard this.
 *
 * SECURITY: escape-first. Lisa's output is model-generated and untrusted, so
 * every text run is HTML-escaped before any tag is introduced, and link hrefs
 * are restricted to http/https/mailto/relative (no `javascript:` / `data:`).
 * Nothing is ever passed through raw.
 */

interface MdListItem {
  indent: number;
  ordered: boolean;
  text: string;
}

/**
 * Styling for renderMarkdown() output, scoped to a `.md-render` wrapper, for
 * the standalone Room / Island pages (which carry their own <style> and don't
 * share MAIN_CSS). The main chat inlines an equivalent block scoped to
 * `:is(.msg, .idle-block)` in lisa-css.ts. Uses the same visual language;
 * kept token-light since those pages define their own palette vars.
 */
export const MD_RENDER_CSS = `
  .md-render > :first-child { margin-top: 0; }
  .md-render > :last-child { margin-bottom: 0; }
  .md-render p { margin: 0 0 0.6em; }
  .md-render :is(h1, h2, h3, h4, h5, h6) { margin: 0.9em 0 0.45em; line-height: 1.3; font-weight: 650; }
  .md-render h1 { font-size: 1.35em; }
  .md-render h2 { font-size: 1.18em; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.12); }
  .md-render h3 { font-size: 1.05em; }
  .md-render :is(h4, h5, h6) { font-size: 1em; opacity: 0.85; }
  .md-render strong { font-weight: 680; }
  .md-render em { font-style: italic; }
  .md-render a { color: var(--accent, #6ad4ff); text-decoration: none; border-bottom: 1px solid rgba(106,212,255,0.35); }
  .md-render a:hover { border-bottom-color: var(--accent, #6ad4ff); }
  .md-render :is(ul, ol) { margin: 0 0 0.6em; padding-left: 1.4em; }
  .md-render li { margin: 0.18em 0; }
  .md-render li::marker { color: var(--accent, #6ad4ff); }
  .md-render :is(ul, ol) :is(ul, ol) { margin: 0.18em 0 0; }
  .md-render blockquote { margin: 0 0 0.6em; padding: 0.35em 0 0.35em 0.9em; border-left: 3px solid var(--accent, #6ad4ff); border-radius: 0 8px 8px 0; opacity: 0.92; font-style: italic; }
  .md-render hr { border: 0; height: 1px; margin: 0.9em 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent); }
  .md-render :not(pre) > code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.86em; background: rgba(106,212,255,0.10); color: #a9e6ff; border: 1px solid rgba(106,212,255,0.16); border-radius: 5px; padding: 0.05em 0.36em; }
  .md-render .md-code { margin: 0 0 0.6em; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; overflow: hidden; background: rgba(3,5,18,0.5); }
  .md-render .md-code-head { display: flex; align-items: center; gap: 8px; padding: 5px 11px; border-bottom: 1px solid rgba(255,255,255,0.1); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10.5px; opacity: 0.7; }
  .md-render .md-code-head .md-lang { color: var(--accent, #6ad4ff); text-transform: lowercase; }
  .md-render .md-code .md-copy { margin-left: auto; font: inherit; color: inherit; background: transparent; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 2px 9px; cursor: pointer; }
  .md-render .md-code pre { margin: 0; padding: 11px 13px; overflow-x: auto; white-space: pre; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; line-height: 1.6; }
  .md-render .md-code pre code { font: inherit; background: none; border: 0; padding: 0; }
  .md-render .md-table { margin: 0 0 0.6em; overflow-x: auto; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; }
  .md-render .md-table table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
  .md-render .md-table :is(th, td) { text-align: left; padding: 7px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .md-render .md-table th { background: rgba(106,212,255,0.07); font-weight: 650; }
  .md-render .md-table tr:last-child td { border-bottom: 0; }
`;

export function renderMarkdown(src: string): string {
  // ── inline-level helpers ──────────────────────────────────────────────
  function esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
    );
  }

  // Allow only benign schemes; anything else (javascript:, data:, vbscript:)
  // loses its href and renders as plain text.
  function safeHref(url: string): string {
    const u = url.trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[/#]/.test(u)) return u; // in-page anchor or root-relative path
    return "";
  }

  // Apply bold / italic / links to text that is ALREADY html-escaped.
  function fmt(s: string): string {
    // links: [text](url) — url is already escaped, so don't re-escape it.
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, url: string) => {
      const href = safeHref(url);
      if (!href) return t;
      return (
        '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + t + "</a>"
      );
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // italic: a single * not adjacent to another * or whitespace
    s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, "$1<em>$2</em>");
    return s;
  }

  // Full inline pass: pull out `code` spans first so their contents are only
  // escaped (never bolded/linked), then format the surrounding text.
  function inline(text: string): string {
    const parts = text.split("`");
    // Even part-count ⇒ an odd number of backticks ⇒ the last one is unpaired;
    // fold it back as a literal so it doesn't open a phantom code span.
    if (parts.length % 2 === 0) {
      const last = parts.pop() as string;
      parts[parts.length - 1] += "`" + last;
    }
    let out = "";
    for (let k = 0; k < parts.length; k++) {
      if (k % 2 === 1) out += "<code>" + esc(parts[k] as string) + "</code>";
      else out += fmt(esc(parts[k] as string));
    }
    return out;
  }

  // ── block-level helpers ───────────────────────────────────────────────
  function splitRow(s: string): string[] {
    return s
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((x) => x.trim());
  }

  function buildList(items: MdListItem[]): string {
    let out = "";
    const stack: MdListItem[] = []; // one entry per open <ul>/<ol>
    for (const it of items) {
      const top = stack[stack.length - 1];
      if (!top || it.indent > top.indent) {
        out += it.ordered ? "<ol>" : "<ul>"; // deeper → open nested list inside current <li>
        stack.push(it);
      } else {
        // pop back out to this item's indent, closing each list + its <li>
        while (stack.length > 1 && it.indent < (stack[stack.length - 1] as MdListItem).indent) {
          out += "</li>" + ((stack.pop() as MdListItem).ordered ? "</ol>" : "</ul>");
        }
        // switching list kind at the same level → close and reopen
        const cur = stack[stack.length - 1] as MdListItem;
        if (it.indent === cur.indent && it.ordered !== cur.ordered) {
          out += "</li>" + (cur.ordered ? "</ol>" : "</ul>");
          out += it.ordered ? "<ol>" : "<ul>";
          stack[stack.length - 1] = it;
        } else {
          out += "</li>"; // close the previous sibling <li>
        }
      }
      out += "<li>" + inline(it.text.replace(/\n/g, " "));
    }
    while (stack.length) out += "</li>" + ((stack.pop() as MdListItem).ordered ? "</ol>" : "</ul>");
    return out;
  }

  // ── block scanner ─────────────────────────────────────────────────────
  // NB: these predicates are `function` declarations, not `const x = () =>`,
  // on purpose — esbuild's keepNames wraps named arrow/function *expressions*
  // in `__name(...)`, which would leak into this function's `.toString()` and
  // break source-injection (the helper isn't defined in the page). Plain
  // declarations keep their name intrinsically, so no wrapper is emitted.
  function blank(s: string): boolean {
    return /^\s*$/.test(s);
  }
  function isBullet(s: string): boolean {
    return /^\s*([-*+]|\d+\.)\s+/.test(s);
  }
  function isHeading(s: string): boolean {
    return /^#{1,6}\s+/.test(s);
  }
  function isQuote(s: string): boolean {
    return /^\s*>/.test(s);
  }
  function isFence(s: string): boolean {
    return /^\s*```/.test(s);
  }
  function isRule(s: string): boolean {
    return /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(s);
  }

  const lines = src.replace(/\r\n?/g, "\n").split("\n");

  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;

    if (blank(line)) {
      i++;
      continue;
    }

    // fenced code block ```lang … ```
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) {
        buf.push(lines[i] as string);
        i++;
      }
      i++; // consume the closing fence (if present)
      const lang = esc(fence[1] || "code");
      html +=
        '<div class="md-code"><div class="md-code-head"><span class="md-lang">' +
        lang +
        '</span><button class="md-copy" type="button">copy</button></div><pre><code>' +
        esc(buf.join("\n")) +
        "</code></pre></div>";
      continue;
    }

    // ATX heading  # … ######
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = (h[1] as string).length;
      html += "<h" + n + ">" + inline((h[2] as string).trim()) + "</h" + n + ">";
      i++;
      continue;
    }

    // horizontal rule
    if (isRule(line)) {
      html += "<hr>";
      i++;
      continue;
    }

    // blockquote (consecutive > lines)
    if (isQuote(line)) {
      const buf: string[] = [];
      while (i < lines.length && isQuote(lines[i] as string)) {
        buf.push((lines[i] as string).replace(/^\s*>\s?/, ""));
        i++;
      }
      html += "<blockquote>" + inline(buf.join("\n").trim()).replace(/\n/g, "<br>") + "</blockquote>";
      continue;
    }

    // table: a pipe row immediately followed by a |---|---| separator
    const sep = lines[i + 1];
    if (
      line.indexOf("|") >= 0 &&
      sep !== undefined &&
      /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(sep)
    ) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !blank(lines[i] as string) && (lines[i] as string).indexOf("|") >= 0) {
        rows.push(splitRow(lines[i] as string));
        i++;
      }
      let t = '<div class="md-table"><table><thead><tr>';
      for (const c of header) t += "<th>" + inline(c) + "</th>";
      t += "</tr></thead><tbody>";
      for (const r of rows) {
        t += "<tr>";
        for (let c = 0; c < header.length; c++) t += "<td>" + inline(r[c] || "") + "</td>";
        t += "</tr>";
      }
      html += t + "</tbody></table></div>";
      continue;
    }

    // list (ordered / unordered, with nesting + wrapped continuation lines)
    if (isBullet(line)) {
      const items: MdListItem[] = [];
      while (i < lines.length && isBullet(lines[i] as string)) {
        const m = (lines[i] as string).match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/) as RegExpMatchArray;
        items.push({
          indent: (m[1] as string).length,
          ordered: /\d/.test(m[2] as string),
          text: m[3] as string,
        });
        i++;
        while (
          i < lines.length &&
          !blank(lines[i] as string) &&
          !isBullet(lines[i] as string) &&
          /^\s+\S/.test(lines[i] as string)
        ) {
          (items[items.length - 1] as MdListItem).text += "\n" + (lines[i] as string).trim();
          i++;
        }
      }
      html += buildList(items);
      continue;
    }

    // paragraph: gather until a blank line or the start of another block
    const buf: string[] = [];
    while (
      i < lines.length &&
      !blank(lines[i] as string) &&
      !isFence(lines[i] as string) &&
      !isHeading(lines[i] as string) &&
      !isQuote(lines[i] as string) &&
      !isRule(lines[i] as string) &&
      !isBullet(lines[i] as string)
    ) {
      buf.push(lines[i] as string);
      i++;
    }
    html += "<p>" + inline(buf.join("\n")).replace(/\n/g, "<br>") + "</p>";
  }

  return html;
}
