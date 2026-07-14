import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./md-render.js";

describe("renderMarkdown — structure", () => {
  test("ATX headings h1–h6", () => {
    assert.equal(renderMarkdown("# Title"), "<h1>Title</h1>");
    assert.equal(renderMarkdown("### Sub"), "<h3>Sub</h3>");
    assert.equal(renderMarkdown("###### Deep"), "<h6>Deep</h6>");
    // not a heading without the space
    assert.equal(renderMarkdown("#nope"), "<p>#nope</p>");
  });

  test("bold, italic, inline code", () => {
    assert.equal(renderMarkdown("a **b** c"), "<p>a <strong>b</strong> c</p>");
    assert.equal(renderMarkdown("a __b__ c"), "<p>a <strong>b</strong> c</p>");
    assert.equal(renderMarkdown("a *b* c"), "<p>a <em>b</em> c</p>");
    assert.equal(renderMarkdown("use `x = 1` here"), "<p>use <code>x = 1</code> here</p>");
  });

  test("inline code is not further formatted", () => {
    // ** inside code must stay literal, not become <strong>
    assert.equal(renderMarkdown("`a**b**c`"), "<p><code>a**b**c</code></p>");
  });

  test("unbalanced backtick folds back as literal", () => {
    assert.equal(renderMarkdown("a `b c"), "<p>a `b c</p>");
  });

  test("unordered + nested list", () => {
    const md = "- a\n  - child\n- b";
    assert.equal(renderMarkdown(md), "<ul><li>a<ul><li>child</li></ul></li><li>b</li></ul>");
  });

  test("ordered list", () => {
    assert.equal(renderMarkdown("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
  });

  test("horizontal rule vs bold-only paragraph", () => {
    assert.equal(renderMarkdown("---"), "<hr>");
    assert.equal(renderMarkdown("***"), "<hr>");
  });

  test("blockquote", () => {
    assert.equal(renderMarkdown("> hi\n> there"), "<blockquote>hi<br>there</blockquote>");
  });

  test("fenced code with language keeps content literal", () => {
    const md = "```python\nx = 1 < 2\n```";
    const html = renderMarkdown(md);
    assert.ok(html.includes('<span class="md-lang">python</span>'));
    assert.ok(html.includes("<pre><code>x = 1 &lt; 2</code></pre>"));
    assert.ok(html.includes('<button class="md-copy" type="button">copy</button>'));
  });

  test("table with header + rows", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const html = renderMarkdown(md);
    assert.ok(html.startsWith('<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr>'));
    assert.ok(html.includes("<tbody><tr><td>1</td><td>2</td></tr></tbody>"));
  });

  test("paragraph keeps single newlines as <br>", () => {
    assert.equal(renderMarkdown("line one\nline two"), "<p>line one<br>line two</p>");
  });

  test("safe link", () => {
    assert.equal(
      renderMarkdown("[docs](https://example.com)"),
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a></p>',
    );
  });
});

describe("renderMarkdown — security (untrusted model output)", () => {
  test("raw HTML is escaped, never passed through", () => {
    assert.equal(
      renderMarkdown("<img src=x onerror=alert(1)>"),
      "<p>&lt;img src=x onerror=alert(1)&gt;</p>",
    );
    assert.equal(
      renderMarkdown("<script>alert(1)</script>"),
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  test("javascript: link never becomes an href", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    assert.ok(!/href/i.test(html), "must not emit an href");
    assert.ok(!/<a\b/i.test(html), "must not emit an anchor");
    assert.ok(!/javascript/i.test(html), "javascript scheme must not survive in markup");
  });

  test("data: link never becomes an href", () => {
    const html = renderMarkdown("[x](data:text/html,<script>1</script>)");
    assert.ok(!/href/i.test(html), "must not emit an href");
    assert.ok(!/<script>/i.test(html), "no live script tag");
  });

  test("quotes inside code cannot break an attribute", () => {
    const html = renderMarkdown('`"><script>`');
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&quot;&gt;&lt;script&gt;"));
  });

  test("heading text is escaped", () => {
    assert.equal(renderMarkdown("# <b>x</b>"), "<h1>&lt;b&gt;x&lt;/b&gt;</h1>");
  });
});

describe("renderMarkdown — source-injection safety (browser runs .toString())", () => {
  // lisa-html.ts injects `${renderMarkdown}` into the page, preceded by an
  // identity `__name` shim. That shim absorbs esbuild's keepNames wrappers
  // (`__name(esc,"esc")`) that appear when the server runs under tsx; the tsc
  // build emits no such calls, so the shim is a harmless no-op there. Rebuild
  // the function from its own source under exactly those conditions.
  function rebuild(): (s: string) => string {
    const src = renderMarkdown.toString();
    return new Function("__name", "return (" + src + ")")((t: unknown) => t) as (
      s: string,
    ) => string;
  }

  test("renderMarkdown source stands alone and runs", () => {
    const md = rebuild();
    assert.equal(md("# hi"), "<h1>hi</h1>");
    assert.equal(md("- a\n  - b"), "<ul><li>a<ul><li>b</li></ul></li></ul>");
    assert.equal(md("`x`"), "<p><code>x</code></p>");
  });

  test("source pulls in nothing from module scope", () => {
    const s = renderMarkdown.toString();
    // A stray import/require would mean it can't be injected verbatim.
    assert.ok(!/\brequire\(/.test(s));
    assert.ok(!/\bimport\b/.test(s));
  });
});

describe("renderMarkdown — fenced code info strings (no infinite loop)", () => {
  // Each has a 2s cap: the pre-fix opener regex /```(\w*)\s*$/ rejected these
  // info strings while isFence() accepted them, wedging the block loop forever.
  test("```c# renders a code block (does not hang)", { timeout: 2000 }, () => {
    const html = renderMarkdown("```c#\nvar x = 1;\n```");
    assert.ok(html.includes('<span class="md-lang">c#</span>'));
    assert.ok(html.includes("<pre><code>var x = 1;</code></pre>"));
  });

  test("```objective-c / ```c++ render (do not hang)", { timeout: 2000 }, () => {
    assert.ok(renderMarkdown("```objective-c\ncode\n```").includes('<span class="md-lang">objective-c</span>'));
    assert.ok(renderMarkdown("```c++\ncode\n```").includes('<span class="md-lang">c++</span>'));
  });

  test("only the first info-string token is kept as the lang", { timeout: 2000 }, () => {
    const html = renderMarkdown('```js title="app.js"\nx\n```');
    assert.ok(html.includes('<span class="md-lang">js</span>'));
    assert.ok(html.includes("<pre><code>x</code></pre>"));
  });

  test("an unclosed fence with an odd lang terminates", { timeout: 2000 }, () => {
    const html = renderMarkdown("intro\n\n```c#\ndangling");
    assert.ok(html.includes('<span class="md-lang">c#</span>'));
    assert.ok(html.includes("<p>intro</p>"));
  });

  test("a bare fence still labels as code", { timeout: 2000 }, () => {
    assert.ok(renderMarkdown("```\nplain\n```").includes('<span class="md-lang">code</span>'));
  });
});

describe("renderMarkdown — links keep emphasis out of the href", () => {
  test("markdown chars inside a URL are not rewritten into the href", () => {
    assert.equal(
      renderMarkdown("[x](https://e.com/a**b**c)"),
      '<p><a href="https://e.com/a**b**c" target="_blank" rel="noopener noreferrer">x</a></p>',
    );
  });

  test("emphasis inside link text still renders", () => {
    const html = renderMarkdown("[**bold** and _em_](https://e.com)");
    assert.ok(html.includes('<a href="https://e.com"'));
    assert.ok(html.includes("<strong>bold</strong>"));
  });

  test("emphasis in surrounding text still renders alongside a link", () => {
    const html = renderMarkdown("**before** [x](https://e.com) after");
    assert.ok(html.startsWith("<p><strong>before</strong> <a href="));
  });

  test("a quote in a URL stays escaped and cannot break the href attribute", () => {
    assert.equal(
      renderMarkdown('[x](https://e.com/a"onmouseover=y)'),
      '<p><a href="https://e.com/a&quot;onmouseover=y" target="_blank" rel="noopener noreferrer">x</a></p>',
    );
  });
});
