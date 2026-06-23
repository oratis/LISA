import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAIN_HTML } from "./lisa-html.js";

/**
 * Byte-exactness guard for the lisa-html.ts split.
 *
 * MAIN_HTML used to be one ~2300-line template literal. It now stitches its
 * <style> body and inline <script> body back together from lisa-css.ts
 * (MAIN_CSS) and lisa-client.ts (MAIN_CLIENT_JS). Because no test can render
 * the real GUI, the safety net for that refactor is "the served bytes did not
 * change": identical output ⇒ identical browser behavior.
 *
 * These constants track the current served MAIN_HTML. If you intentionally
 * change the GUI markup/CSS/JS, recompute them:
 *   node --import tsx -e 'import("./src/web/lisa-html.ts").then(async m=>{const {createHash}=await import("node:crypto");console.log(m.MAIN_HTML.length, createHash("sha256").update(m.MAIN_HTML).digest("hex"))})'
 *
 * Last updated: failed-turn error block — replaced the bare [error] line with
 * an .err-block (detail + retry button) in MAIN_CLIENT_JS plus its CSS.
 */
const EXPECTED_LENGTH = 95307;
const EXPECTED_SHA256 =
  "6bf5c0be96fab8907f6724df89c85b38b098f879abdfa2567c51db3a20040551";

test("MAIN_HTML length is byte-identical to the pre-split snapshot", () => {
  assert.equal(MAIN_HTML.length, EXPECTED_LENGTH);
});

test("MAIN_HTML sha256 is byte-identical to the pre-split snapshot", () => {
  const sha = createHash("sha256").update(MAIN_HTML).digest("hex");
  assert.equal(sha, EXPECTED_SHA256);
});
