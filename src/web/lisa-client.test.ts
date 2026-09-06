import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { MAIN_CLIENT_JS } from "./lisa-client.js";

// Regression guard for the idle "while you were away" sentinel regex.
//
// The client source lives inside MAIN_CLIENT_JS, a plain (untagged) template
// literal, so backslashes are consumed once when the literal is evaluated. A
// regex written with SINGLE backslashes cooks down to a character class plus a
// literal "s*" instead of the intended literal "[while you were away]" prefix.
// Because the persisted sentinel starts with "[", and "[" is not inside that
// character class, `.test()` returns false and history-loaded idle notes fall
// through to a plain Lisa bubble showing the raw sentinel text instead of the
// distinct idle card. The fix is to DOUBLE-escape in source so it cooks to the
// correct regex. `npm run typecheck` can't see this — the template literal is
// valid TypeScript either way — so we assert on the cooked bytes here.
// MAIN_CLIENT_JS is imported already-cooked, i.e. exactly what the browser gets.
//
// See lisa-client.ts:~718 (detection + strip) and the correct `\\s+` precedent
// at lisa-client.ts:~1061.
//
// (This test file deliberately keeps the regex out of any block comment: the
// pattern contains the `*` + `/` pair that would prematurely close one — the
// very same "one layer of escaping/quoting eats your metacharacters" trap.)

const CORRECT_LITERAL = "/^\\[while you were away\\]\\s*/i"; // cooked: caret, \[ , text, \] , \s star, /i
const BROKEN_LITERAL = "/^[while you were away]s*/i"; // what single-escaping cooks down to

describe("idle-note sentinel regex survives template-literal cooking", () => {
  test("cooked source carries the correct regex, not the mangled one", () => {
    const hits = MAIN_CLIENT_JS.split(CORRECT_LITERAL).length - 1;
    // Two uses: the `.test()` detection and the `.replace()` that strips the prefix.
    assert.ok(
      hits >= 2,
      `expected the correctly-escaped sentinel regex at least twice, found ${hits}`,
    );
    assert.ok(
      !MAIN_CLIENT_JS.includes(BROKEN_LITERAL),
      "MAIN_CLIENT_JS contains the mangled sentinel regex — a single-backslash " +
        "escape was eaten by the template literal",
    );
  });

  test("the served regex actually detects and strips a persisted idle note", () => {
    // Pull the regex literal straight out of the cooked source and run it, so we
    // exercise the exact bytes the browser gets rather than a hand-copied regex.
    const m = MAIN_CLIENT_JS.match(/\/\^[^/\n]*while you were away[^/\n]*\/i/);
    assert.ok(m, "could not locate the idle-note regex literal in MAIN_CLIENT_JS");
    const lit = m[0];
    const lastSlash = lit.lastIndexOf("/");
    const sentinel = new RegExp(lit.slice(1, lastSlash), lit.slice(lastSlash + 1));

    const note = "[while you were away] I tidied your notes while you were out.";
    assert.ok(
      sentinel.test(note),
      `served regex ${sentinel} failed to match a real idle note`,
    );
    assert.equal(
      note.replace(sentinel, ""),
      "I tidied your notes while you were out.",
      "served regex did not strip the [while you were away] prefix cleanly",
    );

    // A normal Lisa reply must not be mistaken for an idle note.
    assert.ok(
      !sentinel.test("Welcome back! Here's what I found."),
      "served regex wrongly flagged a normal reply as an idle note",
    );
  });
});

/**
 * Behavioural tests for individual client functions.
 *
 * The client is one big template literal, so there is no module to import
 * and no DOM in `npm test`. These pull a named function's exact served text
 * out of MAIN_CLIENT_JS and run it in a `vm` sandbox with hand-made stubs —
 * so what is tested is literally what the browser executes.
 */
function extractFunction(src: string, name: string): string {
  const head = `function ${name}(`;
  const start = src.indexOf(head);
  assert.ok(start >= 0, `function ${name} not found in MAIN_CLIENT_JS`);
  let depth = 0;
  let i = src.indexOf("{", start);
  assert.ok(i >= 0, `function ${name} has no body`);
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe("sessionLabel names an empty session instead of showing its raw id (UX-4)", () => {
  const src = extractFunction(MAIN_CLIENT_JS, "sessionLabel");
  const ctx = createContext({ relativeTime: (iso: string) => (iso ? "2m" : "") });
  runInContext(`${src}; globalThis.__label = sessionLabel;`, ctx);
  const label = (ctx as { __label: (s: unknown) => string }).__label;
  const ID = "20260905-220846-9f7d58";

  test("a session with no messages reads as a new session, not the id", () => {
    assert.equal(label({ id: ID, messageCount: 0, startedAt: "2026-09-05T22:08:46Z" }), "New session · 2m");
  });
  test("the first user message still wins once there is one", () => {
    assert.equal(label({ id: ID, messageCount: 1, firstUserMessage: "fix the mail sweep" }), "fix the mail sweep");
  });
  test("long names are ellipsised to 30 chars", () => {
    const long = "a".repeat(80);
    assert.equal(label({ id: ID, messageCount: 3, firstUserMessage: long }), "a".repeat(30) + "…");
  });
  test("a session with messages but no captured text falls back to the id", () => {
    assert.equal(label({ id: ID, messageCount: 4 }), ID);
  });
});
