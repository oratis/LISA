import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { colorEnabled, makePalette, PLAIN, setColorOverride, visibleLength } from "./ansi.js";

afterEach(() => setColorOverride(null));

describe("colorEnabled", () => {
  test("a TTY with a normal env gets colour", () => {
    assert.equal(colorEnabled({ isTTY: true, env: { TERM: "xterm-256color" } }), true);
  });

  test("a pipe never gets colour", () => {
    assert.equal(colorEnabled({ isTTY: false, env: {} }), false);
    assert.equal(colorEnabled({ env: {} }), false);
  });

  test("NO_COLOR (any non-empty value) wins over a TTY", () => {
    assert.equal(colorEnabled({ isTTY: true, env: { NO_COLOR: "1" } }), false);
    assert.equal(colorEnabled({ isTTY: true, env: { NO_COLOR: "0" } }), false);
    assert.equal(colorEnabled({ isTTY: true, env: { NO_COLOR: "" } }), true);
  });

  test("TERM=dumb disables colour", () => {
    assert.equal(colorEnabled({ isTTY: true, env: { TERM: "dumb" } }), false);
  });

  test("--no-color beats everything, including the override", () => {
    setColorOverride(true);
    assert.equal(colorEnabled({ isTTY: false, env: {}, noColorFlag: true }), false);
  });

  test("the process-wide override decides when set", () => {
    setColorOverride(false);
    assert.equal(colorEnabled({ isTTY: true, env: {} }), false);
    setColorOverride(true);
    assert.equal(colorEnabled({ isTTY: false, env: { NO_COLOR: "1" } }), true);
    setColorOverride(null);
    assert.equal(colorEnabled({ isTTY: true, env: {} }), true);
  });
});

describe("makePalette", () => {
  test("enabled wraps in SGR pairs", () => {
    const p = makePalette(true);
    assert.equal(p.red("x"), "\x1b[31mx\x1b[39m");
    assert.equal(p.dim("x"), "\x1b[2mx\x1b[22m");
    assert.equal(p.enabled, true);
  });

  test("disabled is the identity, and PLAIN is that palette", () => {
    const p = makePalette(false);
    for (const f of [p.red, p.dim, p.bold, p.green, p.yellow, p.cyan, p.grey]) {
      assert.equal(f("x"), "x");
    }
    assert.equal(PLAIN.enabled, false);
    assert.equal(PLAIN.green("x"), "x");
  });
});

describe("visibleLength", () => {
  test("ignores escape sequences", () => {
    const p = makePalette(true);
    assert.equal(visibleLength(p.green("done")), 4);
    assert.equal(visibleLength("plain"), 5);
  });
});
