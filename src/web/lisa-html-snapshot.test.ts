import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { MAIN_HTML } from "./lisa-html.js";
import { MAIN_CSS } from "./lisa-css.js";
import { MAIN_CLIENT_JS } from "./lisa-client.js";
import { ROOM_HTML } from "./room.js";

/**
 * Composition guard for the single-file HTML shell.
 *
 * History: MAIN_HTML was one ~2300-line template literal, then a template
 * literal stitched from two more (lisa-css.ts + lisa-client.ts), and the guard
 * for those refactors was a byte pin — a length plus a sha256 of the served
 * page. That pin did its job while the split was in flight, but once the
 * client moved into real files (assets/client/main.css and main.js) it became
 * pure churn: every one-word copy change failed two tests and rewrote a hash
 * that proves nothing about behaviour.
 *
 * What actually matters is the property the pin was standing in for: the page
 * the browser gets still CONTAINS each source file verbatim, in one document,
 * with nothing lost or re-escaped on the way in. Single-file delivery is a
 * product promise — one GET, no secondary requests, a saved copy still runs —
 * so "inlined verbatim" is the invariant, not "these exact bytes".
 *
 * Syntax validity of the inlined script is covered separately by
 * html-syntax.test.ts, which compiles every inline <script> with vm.Script.
 */

// Discover the shared client directory instead of maintaining a second asset
// manifest. Some sources (such as room effects) belong only to /room; every
// source must be embedded intact in at least one actual served document.
const clientDir = new URL("./assets/client/", import.meta.url);
const CLIENT_FILES = readdirSync(clientDir).sort();
const servedPages = { main: MAIN_HTML, room: ROOM_HTML };

function assertEmbeddedSource(name: string, source: string, pages: Record<string, string>): void {
  assert.match(name, /\.(css|js)$/, `${name} is not a client stylesheet or script`);
  const consumers = Object.entries(pages).filter(([, html]) => html.includes(source));
  assert.ok(consumers.length, `${name} is not embedded in any served page`);
  const tag = name.endsWith(".css") ? "style" : "script";
  for (const [page, html] of consumers) {
    assert.equal(html.split(source).length - 1, 1, `${name} is duplicated in ${page}`);
    const at = html.indexOf(source);
    const open = html.lastIndexOf(`<${tag}`, at);
    const openEnd = html.indexOf(">", open);
    const close = html.indexOf(`</${tag}>`, openEnd);
    assert.ok(
      open >= 0 && openEnd < at && close >= at + source.length,
      `${name} is outside a ${tag} element in ${page}`,
    );
  }
}

describe("the client sources are real files, not template literals", () => {
  for (const name of CLIENT_FILES) {
    test(`${name} is embedded intact in its consuming pages`, () => {
      assertEmbeddedSource(name, readFileSync(new URL(name, clientDir), "utf8"), servedPages);
    });
    test(`${name} is non-trivial and free of the sequences that would break inlining`, () => {
      const body = readFileSync(new URL(name, clientDir), "utf8");
      assert.ok(body.length > 1000, `${name} is only ${body.length} bytes`);
      // These would terminate the host <style>/<script> element early. The
      // template-literal era could not contain them either; keep it true now
      // that an editor will happily let someone type one.
      assert.ok(!body.includes("</script"), `${name} contains a </script sequence`);
      assert.ok(!body.includes("</style"), `${name} contains a </style sequence`);
    });
  }

  test("the exported constants are exactly the file contents", () => {
    const contents = (names: string[]) =>
      names.map((name) => readFileSync(new URL(name, clientDir), "utf8")).join("\n");
    assert.equal(MAIN_CSS, contents(["main.css", "connectors.css"]));
    assert.equal(MAIN_CLIENT_JS, contents(["main.js", "connectors.js"]));
  });
});

describe("the served page inlines every client source verbatim", () => {
  test("the shared artwork renderer is inlined before its consumers", () => {
    const renderer = readFileSync(new URL("soft-ink.js", clientDir), "utf8");
    assert.equal(MAIN_HTML.split(renderer).length - 1, 1);
    assert.ok(MAIN_HTML.indexOf(renderer) < MAIN_HTML.indexOf(MAIN_CLIENT_JS));
  });
  test("MAIN_HTML contains the stylesheet, once, inside <style>", () => {
    assert.ok(MAIN_HTML.includes(MAIN_CSS), "MAIN_CSS is not present verbatim");
    assert.equal(MAIN_HTML.split(MAIN_CSS).length - 1, 1, "MAIN_CSS appears more than once");
    const styleOpen = MAIN_HTML.indexOf("<style>");
    const styleClose = MAIN_HTML.indexOf("</style>");
    const at = MAIN_HTML.indexOf(MAIN_CSS);
    assert.ok(styleOpen >= 0 && styleClose > styleOpen, "no <style> block");
    assert.ok(at > styleOpen && at + MAIN_CSS.length <= styleClose, "MAIN_CSS is outside <style>");
  });

  test("MAIN_HTML contains the client script, once, inside a <script>", () => {
    assert.ok(MAIN_HTML.includes(MAIN_CLIENT_JS), "MAIN_CLIENT_JS is not present verbatim");
    assert.equal(MAIN_HTML.split(MAIN_CLIENT_JS).length - 1, 1);
    const at = MAIN_HTML.indexOf(MAIN_CLIENT_JS);
    const scriptOpen = MAIN_HTML.lastIndexOf("<script", at);
    const scriptClose = MAIN_HTML.indexOf("</script>", at);
    assert.ok(scriptOpen >= 0 && scriptClose > at, "client JS is not inside a <script> element");
  });

  test("nothing is fetched at runtime: no external script or stylesheet links", () => {
    // A <link rel=stylesheet> or a <script src> would break the promise that
    // the page works as a single saved document.
    assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(MAIN_HTML), "external stylesheet link");
    assert.ok(!/<script[^>]+\ssrc=/i.test(MAIN_HTML), "external script src");
  });

  test("the shell is one complete document", () => {
    assert.ok(MAIN_HTML.startsWith("<!doctype html>"));
    assert.ok(MAIN_HTML.trimEnd().endsWith("</html>"));
    // Balanced style/script elements — a stray opener would silently swallow
    // the rest of the page.
    assert.equal(
      (MAIN_HTML.match(/<style>/g) || []).length,
      (MAIN_HTML.match(/<\/style>/g) || []).length,
    );
    assert.equal(
      (MAIN_HTML.match(/<script>/g) || []).length,
      (MAIN_HTML.match(/<\/script>/g) || []).length,
    );
  });
});

// Exercise the guard itself: adding a page-specific asset is valid, while an
// orphan, duplicate or misplaced source must still fail the composition gate.
describe("client asset ownership guard", () => {
  const source = "window.roomEffect = true;";
  test("allows a source used only by the room document", () => {
    assertEmbeddedSource("room-effects.js", source, {
      main: "<html></html>",
      room: `<script>${source}</script>`,
    });
  });
  test("rejects an unreferenced client asset", () => {
    assert.throws(
      () => assertEmbeddedSource("orphan.js", source, { main: "<html></html>" }),
      /not embedded/,
    );
  });
  test("rejects duplicate or misplaced sources", () => {
    assert.throws(
      () =>
        assertEmbeddedSource("room-effects.js", source, {
          room: `<script>${source}${source}</script>`,
        }),
      /duplicated/,
    );
    assert.throws(
      () => assertEmbeddedSource("room-effects.js", source, { room: `<div>${source}</div>` }),
      /outside a script/,
    );
  });
});
