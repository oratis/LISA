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
 * Last updated: "agent console" redesign (left-rail nav — Chat / Dashboard /
 * Control / Reve / Sense / Memory — switching a main view-stack, a workspace
 * pill, and a Proactive autonomy toggle, all additive beside the untouched chat
 * pipeline) merged on top of the sidebar Mail card (connect-mailbox modal +
 * daily classified digest + needs-you list + sweep-now). Plus review cleanups:
 * the 60s refresh tick resolves the wrapped refreshClaudeSessions at call time,
 * and an unused .pp-tag.you rule was dropped.
 * Then: composer ＋ menu (merged attach+screenshot) + a top icon function bar
 * (功能区: soul/skills/tools/plans + find) in #viewChat; bottom badges removed.
 * Then: removed the "LISA workspace" pill (markup + .ws-pill CSS) from the top
 * of the sidebar — redundant chrome; the identity card is now the first block.
 * Then: failed-turn error block — replaced the bare [error] line with an
 * .err-block (detail + ↻ retry) in MAIN_CLIENT_JS plus its CSS (#135), in front
 * of provider-level auto-retry for transient empty-stream failures.
 * Then: a "Pair phone" function-bar button → showPair() modal that mints a
 * device token via /api/pair/start and shows copyable link + host/port/token
 * (browser counterpart to `lisa pair`), with its .pair-row CSS.
 * Then: a scannable QR (server-rendered SVG from /api/pair/start) at the top of
 * that modal, with .pair-qr CSS.
 * Then: composer ＋ / 🎙 glyphs → line-style SVG icons matching the .fbtn
 * function bar (+ #plusBtn/#recordBtn svg sizing; resting color → --fg-2).
 * Then: Lisa Room (#214) — a ⌂ Room nav item + #viewRoom with a lazily-loaded
 * /room iframe, its loadView branch, and a window "message" listener so the
 * Room iframe's "Talk to her" switches back to the chat view in place.
 * Then: Room v2 — the room→parent bridge moved to a richer, same-origin-guarded
 * {type:'lisa-room', action, prefill} protocol (open-chat / switch-view) at
 * module scope; the old room_open_chat listener was removed as superseded.
 * Then: Markdown rendering for Lisa's chat bubbles — a source-injected
 * renderMarkdown() (md-render.ts, preceded by a `__name` shim) added to the
 * page <script> before MAIN_CLIENT_JS, its styled-element CSS in lisa-css.ts,
 * and the streaming + history paths now feeding her text through it instead of
 * textContent. NB: the injected bytes are this function's `.toString()`, so
 * they track the test transpiler (tsx/esbuild); recompute after an esbuild bump.
 * Then: idle "★" reflection cards now render Markdown too — the chat CSS scope
 * widened to :is(.msg, .idle-block) and buildIdleBlock feeds renderMarkdown.
 */
const EXPECTED_LENGTH = 165212;
const EXPECTED_SHA256 =
  "6f93f27b1256e916d30b21349acfbd6cf715c5f868f43d991f7345d0115a097f";

test("MAIN_HTML length is byte-identical to the pre-split snapshot", () => {
  assert.equal(MAIN_HTML.length, EXPECTED_LENGTH);
});

test("MAIN_HTML sha256 is byte-identical to the pre-split snapshot", () => {
  const sha = createHash("sha256").update(MAIN_HTML).digest("hex");
  assert.equal(sha, EXPECTED_SHA256);
});
