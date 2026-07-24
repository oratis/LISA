import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { MAIN_HTML } from "./lisa-html.js";
import { ISLAND_HTML } from "./island.js";
import { ROOM_HTML } from "./room.js";
import { LOGIN_HTML } from "./login.js";

/**
 * Regression guard: the whole GUI/island is one big inline <script>. A single
 * syntax error there (e.g. a raw newline inside a JS string literal — which is
 * exactly what a `\n` written inside the outer TS template literal expands to)
 * makes the browser discard the ENTIRE script, silently killing all page JS:
 * chat send, SSE mood/idle, the Claude monitor, vision, voice. typecheck can't
 * see inside a template-literal string, so we compile the emitted scripts here.
 *
 * vm.Script compiles (parses) without running, so missing browser globals
 * (document/window/fetch/EventSource) don't matter — only syntax is checked.
 */
function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]!);
  return out;
}

describe("inline page <script> blocks are syntactically valid JS", () => {
  for (const [name, html] of [
    ["MAIN_HTML", MAIN_HTML],
    ["ISLAND_HTML", ISLAND_HTML],
    ["ROOM_HTML", ROOM_HTML],
    ["LOGIN_HTML", LOGIN_HTML],
  ] as const) {
    test(`${name} parses`, () => {
      const blocks = inlineScripts(html);
      assert.ok(blocks.length > 0, `${name} should contain an inline <script>`);
      blocks.forEach((code, i) => {
        assert.doesNotThrow(
          () => new vm.Script(code),
          `${name} inline script #${i} has a syntax error`,
        );
      });
    });
  }
});
