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
 * Then: personal knowledge base (docs/PLAN_KNOWLEDGE_BASE_v1.0.md) — a
 * "Knowledge" nav item + #viewKb (a live-search list/reader over /api/kb*), a
 * KB select-toggle in the function bar driving a floating capture bar (chat
 * messages → md source), and the kbCapture client block, all with their CSS.
 * Then: guided mail connect — the connect-mailbox modal gained a provider
 * picker (Gmail/iCloud/QQ/163/Outlook/Other) with per-provider setup steps and
 * an "open app-passwords" link, adaptive labels/placeholders, and email-domain
 * auto-detect; plus its .mm-providers/.mm-chip/.mm-help/.mm-steps/.mm-link CSS.
 * Then: Markdown rendering for Lisa's chat bubbles — a source-injected
 * renderMarkdown() (md-render.ts, preceded by a `__name` shim) added to the
 * page <script> before MAIN_CLIENT_JS, its styled-element CSS in lisa-css.ts,
 * and the streaming + history paths now feeding her text through it instead of
 * textContent. NB: the injected bytes are this function's `.toString()`, so
 * they track the test transpiler (tsx/esbuild); recompute after an esbuild bump.
 * Then: idle "★" reflection cards now render Markdown too — the chat CSS scope
 * widened to :is(.msg, .idle-block) and buildIdleBlock feeds renderMarkdown.
 * Then: fixed a renderMarkdown infinite loop on fenced code with a non-\w info
 * string (```c# / ```c++ / ```js title="x") — the fence opener now matches any
 * info string (first token = lang); links split out of the emphasis pass so a
 * `*`/`_` in a URL no longer mangles the href.
 * Then: nav → 九宫格 tile grid (unified line-SVG icons) with two new rail
 * views, Mail + Settings (#viewMail/#viewSettings, loadMail/loadSettings).
 * Mail reuses /api/mail/* and adds per-account enable/disable/remove + a nav
 * "needs-you" badge; Settings hosts API-key management (/api/config/*), the
 * Proactive autonomy switch, and the Compact-mode switch (both relocated out
 * of the sidebar footer). The Knowledge (kb) tile is retained, so the grid
 * holds 10 tiles (3×3 + 1).
 * Then: locked the launcher to a clean 3×3 — the Mail tile was removed (9
 * tiles: Chat/Dashboard/Control/Rêve/Room/Sense/Memory/Knowledge/Settings);
 * Mail's entry moved to the sidebar Mail card, whose header now opens #viewMail.
 * Then: Control view overhaul — polished clickable session rows (.ctrl-row,
 * status chips, error/pending accents, problems-first sort), a per-session
 * inspector modal (openSessionDetail: metadata + surfaced error/pending banner +
 * approve/deny/send/cancel/adopt/view-output actions), and inline quick
 * approve/deny on pending rows. Sidebar .session-row styling left untouched.
 * Then: KB link ingest (PLAN_KNOWLEDGE_BASE_v2.0 K-G) — a paste-a-link bar
 * (.kb-ingestbar: url input + Save + status) atop the Knowledge view calling
 * POST /api/kb/ingest and opening the saved entry; a 存入知识库 chip
 * (maybeOfferKbIngest) under chat bubbles whose message contains a bare URL;
 * window.lisaKbToast shared from the capture block; and their CSS.
 */
const EXPECTED_LENGTH = 224728;
const EXPECTED_SHA256 =
  "95356791a521378fe62c76bb7ad393f76f8332b2d0eaf281257e2c9912c47d76";

test("MAIN_HTML length is byte-identical to the pre-split snapshot", () => {
  assert.equal(MAIN_HTML.length, EXPECTED_LENGTH);
});

test("MAIN_HTML sha256 is byte-identical to the pre-split snapshot", () => {
  const sha = createHash("sha256").update(MAIN_HTML).digest("hex");
  assert.equal(sha, EXPECTED_SHA256);
});
