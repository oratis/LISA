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
 * Last updated: Mail card (connect-mailbox modal + daily classified digest +
 * needs-you list + sweep-now) added to the sidebar.
 */
const EXPECTED_LENGTH = 102331;
const EXPECTED_SHA256 =
  "c14af5253ba023e34df61639ac35eaa449c1b70339d5c4ad1dcd944acd00a2d7";

test("MAIN_HTML length is byte-identical to the pre-split snapshot", () => {
  assert.equal(MAIN_HTML.length, EXPECTED_LENGTH);
});

test("MAIN_HTML sha256 is byte-identical to the pre-split snapshot", () => {
  const sha = createHash("sha256").update(MAIN_HTML).digest("hex");
  assert.equal(sha, EXPECTED_SHA256);
});
