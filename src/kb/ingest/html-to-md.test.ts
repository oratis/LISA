import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, decodeEntities } from "./html-to-md.js";

describe("htmlToMarkdown", () => {
  test("headings and paragraphs", () => {
    assert.equal(
      htmlToMarkdown("<h1>Title</h1><p>One.</p><h2>Sub</h2><p>Two.</p>"),
      "# Title\n\nOne.\n\n## Sub\n\nTwo.",
    );
  });

  test("nested and ordered lists", () => {
    const md = htmlToMarkdown(
      "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul><ol><li>x</li><li>y</li></ol>",
    );
    assert.equal(md, "- a\n  - a1\n  - a2\n- b\n\n1. x\n2. y");
  });

  test("unclosed <li> (the real-world common case)", () => {
    assert.equal(htmlToMarkdown("<ul><li>one<li>two</ul>"), "- one\n- two");
  });

  test("fenced code with language, fence-proof body", () => {
    const md = htmlToMarkdown(
      `<pre><code class="language-ts">const a = 1;\nif (a &lt; 2) {}</code></pre>`,
    );
    assert.equal(md, "```ts\nconst a = 1;\nif (a < 2) {}\n```");
    // A body containing ``` must get a longer fence.
    const evil = htmlToMarkdown("<pre><code>```\ninjection\n```</code></pre>");
    assert.match(evil, /^````\n/);
  });

  test("inline code keeps backticks safe", () => {
    assert.equal(htmlToMarkdown("<p>run <code>a`b</code> now</p>"), "run ``a`b`` now");
  });

  test("blockquote wraps nested markdown", () => {
    assert.equal(
      htmlToMarkdown("<blockquote><p>quoted</p><p>lines</p></blockquote>"),
      "> quoted\n>\n> lines",
    );
  });

  test("tables become pipe tables", () => {
    const md = htmlToMarkdown(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
    assert.equal(md, "| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  test("links, images (incl. data-src lazy-loading), emphasis, hr", () => {
    const md = htmlToMarkdown(
      `<p><a href="https://x.dev">site</a> <strong>bold</strong> <em>it</em></p><hr><p><img data-src="https://img/x.png" alt="pic"></p>`,
    );
    assert.equal(md, "[site](https://x.dev) **bold** *it*\n\n---\n\n![pic](https://img/x.png)");
  });

  test("markdown special characters in prose are escaped — no syntax forgery", () => {
    const md = htmlToMarkdown("<p>weight *not bold* and [[oauth]] and a|b</p>");
    assert.equal(md, "weight \\*not bold\\* and \\[\\[oauth\\]\\] and a\\|b");
  });

  test("javascript: links render as plain text", () => {
    assert.equal(htmlToMarkdown(`<p><a href="javascript:alert(1)">hi</a></p>`), "hi");
  });

  test("script/style/iframe contents are dropped, even with tricky bodies", () => {
    const md = htmlToMarkdown(
      `<p>keep</p><script>if (a < b) document.write("<p>evil</p>")</script><style>p{color:red}</style><p>also</p>`,
    );
    assert.equal(md, "keep\n\nalso");
  });

  test("serializes from <body> when a full document is given", () => {
    const md = htmlToMarkdown(
      "<html><head><title>t</title></head><body><p>content</p></body></html>",
    );
    assert.equal(md, "content");
  });

  test("entities: named, decimal, hex", () => {
    assert.equal(decodeEntities("a &amp; b &#65; &#x4e2d; &nbsp;"), "a & b A 中  ");
  });
});
