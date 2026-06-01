import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { MAIN_HTML } from "./lisa-html.js";

// Pull every inline <script>…</script> body, skipping <script src=…> (external
// scripts have no inline code to check). This is the exact source the browser
// hands to V8.
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const inlineScripts = [...MAIN_HTML.matchAll(INLINE_SCRIPT_RE)].map((m) => m[1]);

test("MAIN_HTML has inline <script> blocks to validate", () => {
  assert.ok(
    inlineScripts.length > 0,
    "no inline <script> found — did the regex or the template change?",
  );
});

// Why this guard exists: MAIN_HTML is one big template literal, so a `\n`
// (single backslash) written inside a client-side JS string literal becomes a
// REAL newline in the served script. That breaks the quoted string and throws
// `SyntaxError: Invalid or unexpected token` at page load — a white screen.
// `npm run typecheck` can't catch it (the template is valid TypeScript); only
// V8 fails when it parses the emitted script. vm.Script compiles the code the
// same way the browser parses a classic <script> — without executing it — so
// the broken syntax surfaces here instead of in production.
inlineScripts.forEach((code, i) => {
  test(`inline <script> #${i} parses as valid JS`, () => {
    assert.doesNotThrow(() => new vm.Script(code));
  });
});
