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
 * Then: Sense social publishing host — discovered connector status, post-draft
 * list, linked-account labels, immutable approval snapshot, local approve,
 * cancel controls, and a publishing pause/resume kill switch.
 * Then: mail connect modal — the two accent action buttons (.mm-link "Open App
 * Passwords" and .dm-start "Connect") now share an identical hit area; .mm-link
 * matched to .dm-start's box and both pinned to line-height:1.2 for exact parity.
 * Then: 3-column session shell, phase 1 (PLAN_UI_SESSION_SHELL_v1.0) — the
 * sidebar lower half (currently-wanting / agents / mail / reflection, IDs
 * unchanged) moved into a new .rightbar status panel (uniform .rb-sec sections
 * + hairlines, no tinted cards); .frame grid grew a 320px "rightbar" column
 * with a new ≤1180px two-column fallback and display:none in the ≤720px +
 * force-compact stacks; a light "Calm" theme (body[data-theme="calm"] token
 * override + chrome patches) toggled by the new fnbar #fnTheme moon/sun button
 * (persisted as localStorage "lisa-theme") beside a new #fnMail button that
 * reopens the Mail view now that the mail card can be off-screen.
 * Then: session shell phase 2 — Lisa's own sessions become switchable: a
 * sidebar .sb-sessions tree (#sessionTree, LISA root group + leaves from
 * GET /api/sessions, ＋New button) and an fnbar #tabStrip of open-session
 * tabs (localStorage "lisaOpenSessions"), both driving the new
 * POST /api/sessions (create) and POST /api/sessions/{id}/activate (switch)
 * endpoints, which swap the ChatCtx session/history through the turn chain
 * and broadcast a session_switched SSE frame; lisaSetActiveSession converges
 * every switch path onto lisaResetChatLog (log wipe + history reload) and a
 * chatGeneration guard detaches an in-flight reply stream's DOM writes when
 * its session is switched away mid-turn.
 * Then: session shell phase 3 — the monitored agents join the sidebar tree as
 * root groups SIBLING to LISA (agent kind → project → session leaves with
 * state pips, collapse state kept across refreshes), and the right panel's
 * agents roster became a single INSPECTOR card (#sbClaudeRows repurposed as
 * its body) for the tree-selected session: head + state chip, stat triplet
 * (turns/tokens/files or msgs/started/project), aligned KV rows
 * (last cmd/tools/files/⚠pending/error), and the same control surface the
 * roster rows had (approve/deny/send/output/cancel/adopt) now scoped to the
 * selected session; auto-selects the top-ranked live agent, else the active
 * Lisa session, whose inspector offers "open" to switch.
 * Then: session shell v1.1 F2-F4 — sessions are auto-named by their FIRST
 * user message (SessionInfo.firstUserMessage, new in sessions/list.ts); a ⇄
 * button in the sessions head toggles the tree between agent view and a
 * project view (roots = projects, Lisa + agent leaves side by side with mini
 * source glyphs; localStorage "lisaTreeMode", per-mode collapse keys); and a
 * new fnbar #fnPanel button collapses the right panel (body.rb-collapsed +
 * localStorage "lisaRightbar"), independent of the ≤1180px auto-hide.
 * Then: v1.1 F1 — the read-only agent stream: an #agentStream surface inside
 * #viewChat (head card / pending-permission banner / turn-separated step
 * rows / control footer) that swaps in for the chat surface while an agent
 * tab is active (body.agent-tab-active); agent tabs join the tab strip
 * ({t:'agent',…} entries in "lisaOpenSessions", back-compat with the old
 * string-only payload); the inspector gains a "▤ stream" action. Steps come
 * from the new GET /api/agents/steps (parseSessionSteps — basenames/argv[0]
 * only, tier-gated), and PTY sessions render their live terminal tail from
 * the existing /api/agents/pty/{id}/stream SSE instead.
 * Then: v1.1 F5 — island deep link: a focus_session SSE case + a
 * lisaFocusAgent global (selects an agent session in the tree/inspector)
 * plus #agent=kind/id hash handling (on hashchange and once after the first
 * roster snapshot), driven by the island's new "⇱ Open in Lisa" row action
 * via POST /api/island/focus-session.
 * Then: v1.1 F6 (true concurrency) client half — /chat sends a sessionId so
 * the server routes the turn to that session's own ctx; /api/history reads
 * are pinned to the displayed session; a reply that finishes after its
 * session was switched away refreshes the log if the user is back on it,
 * else marks the session unread (lisaMarkUnread → ● dot on the tree leaf +
 * tab, cleared by lisaSetActiveSession).
 * Then: composer-button hit parity + a TOKENS rail section — #plusBtn gets
 * width:100% so its hit area matches #recordBtn's full 36px grid cell (it
 * used to shrink to its 19px icon inside .plus-wrap); and the right rail
 * gains a bottom #sbTokens section (model chip in the header, today
 * tokens/turns/cost stat triplet from /api/billing/usage, source row =
 * selected coding plan else API key from /api/plans, a 12h-window row, and
 * per-plan usage rows), refreshed on boot, every 5 minutes, and on the SSE
 * chat_end frame.
 * Then: 确认轮二 — the multi-tab strip became a single CONTEXT CHIP (the
 * active session's name/status, or the observed agent + "observing" + an ×
 * back to chat; creating/switching lives in the sidebar tree only, and the
 * lisaOpenSessions tab persistence is gone), and the right rail was
 * re-anchored on core value: a new NEEDS-YOU section on top (waiting/error/
 * pending-permission agents with inline approve/deny/open-stream), the
 * inspector defaults to the ACTIVE Lisa session instead of auto-picking an
 * agent, "currently wanting" compressed into the identity card (#sbDesire
 * moved, 2-line clamp + tooltip), the mail card hides entirely until a
 * mailbox is connected, and the reflection section is retitled "while you
 * were away".
 * Then: 确认轮三 — the stream pane loads the observed session's CHAT
 * TRANSCRIPT: it first fetches the new loopback-only
 * GET /api/agents/transcript (user/assistant message text as bubbles —
 * agent replies markdown-rendered, the md style scope widened to include
 * .as-text — with the structural tool markers interleaved as .srow rows)
 * and falls back to the structural steps when it's empty (remote access,
 * other agent kinds, quiet tail).
 * Then: clicking an agent session in the tree (or a needs-you row) opens its
 * conversation DIRECTLY — the leaf click now calls openStreamTab instead of
 * only selecting the inspector (the "▤ stream" button remains as a secondary
 * entry); and refreshSessionsBadge re-renders the inspector once the session
 * list lands, fixing the "(idle)" inspector on a fresh page load (the roster
 * used to win the race before /api/sessions and nothing re-rendered).
 */
const EXPECTED_LENGTH = 301378;
const EXPECTED_SHA256 =
  "e08761ff04a7cca87f2cc3f1f22749837a025fc222487df818781f6e43e93219";

test("MAIN_HTML length is byte-identical to the pre-split snapshot", () => {
  assert.equal(MAIN_HTML.length, EXPECTED_LENGTH);
});

test("MAIN_HTML sha256 is byte-identical to the pre-split snapshot", () => {
  const sha = createHash("sha256").update(MAIN_HTML).digest("hex");
  assert.equal(sha, EXPECTED_SHA256);
});
