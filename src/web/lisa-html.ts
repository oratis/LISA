/**
 * Lisa.app chat HTML — the main /web shell.
 *
 * Extracted out of server.ts so the visual layer (CSS + body markup +
 * client JS) can evolve as one piece without bloating the server module.
 *
 * Design language follows reference/mockups/lisa-app-redesign.html:
 *   - Glass-morphism dark UI with cyan (#6ad4ff) brand accent
 *   - 280px sidebar (identity card · currently wanting · Claude monitor ·
 *     last reflection · SOUL/SKILLS/MEMORY/TOOLS row · session badge)
 *   - Right pane: chat log + composer
 *
 * IDs preserved from the previous pixel-art shell so the existing
 * client-side JS (history loading, mood updates, modal panels, birth
 * ritual, cfg gate, attachments, send + SSE streaming) keeps working
 * unchanged:
 *   log, input, form, sendBtn, sessionId, fileInput, attachPreview,
 *   mascot, mascotTag, modalBg, modalTitle, modalBody, modalClose,
 *   cfgOverlay, cfgForm, cfgAnthropic, cfgOpenai, cfgSave, cfgError,
 *   birthOverlay, birthSteps, birthFinal, birthEnter, birthError,
 *   attachBtn
 *
 * New IDs for the sidebar live blocks (wired in the trailing
 * "sidebar live wiring" script section):
 *   identitySub, sbDesire, sbClaudeCard, sbClaudeCount, sbClaudeRows,
 *   sbReflection, sbReflectionBody, sbSessionBadge
 */

export const MAIN_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>LISA</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#07091a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="LISA">
<link rel="apple-touch-icon" href="/assets/lisa-mascot.png">
<link rel="icon" type="image/png" href="/assets/lisa-mascot.png">
<style>
  :root {
    color-scheme: dark;

    /* New design tokens (mockup) */
    --accent: #6ad4ff;
    --accent-soft: rgba(106, 212, 255, 0.13);
    --accent-glow: rgba(106, 212, 255, 0.27);
    --warm: #ffd066;
    --dream: #b487ff;
    --claude: #ff8c42;
    --err-color: #ff5577;

    --bg-deep: #07091a;
    --bg-1: #0b1024;
    --bg-2: #11163a;
    --bg-3: #1a1f4a;
    --bg-card: rgba(20, 26, 64, 0.65);
    --bg-card-strong: rgba(20, 26, 64, 0.88);
    --border-new: rgba(255, 255, 255, 0.07);
    --border-strong: rgba(255, 255, 255, 0.14);

    --fg: #e8eaff;
    --fg-2: #aeb5d3;
    --fg-3: #6c7398;
    --fg-faint: #444a6e;

    /* Legacy tokens — kept so the unchanged modal / cfg / birth
       overlay styles below still resolve. The new shell + chat use
       the modern tokens above. */
    --bg: #0a0d2b;
    --panel: #1a1f4d;
    --panel-light: #2a3270;
    --border: #6a7ad9;
    --border-light: #a4b2ff;
    --text: #e7ecff;
    --text-dim: #8090c0;
    --you: #6cf6e1;
    --lisa: #ffd167;
    --tool: #ff7eb6;
    --error: #ff5577;
  }
  * { box-sizing: border-box; }
  html, body {
    height: 100%;
    margin: 0;
    background: #000;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    color: var(--fg);
    overflow: hidden;
  }

  /* ── App shell ─────────────────────────────────────────────── */
  .frame {
    height: 100vh;
    width: 100vw;
    display: grid;
    grid-template-columns: 280px 1fr;
    grid-template-rows: 36px 1fr;
    grid-template-areas:
      "titlebar titlebar"
      "sidebar  main";
    background:
      radial-gradient(ellipse at 30% 20%, #1a1238 0%, transparent 50%),
      radial-gradient(ellipse at 80% 70%, #0a1f3a 0%, transparent 60%),
      linear-gradient(180deg, var(--bg-1) 0%, var(--bg-deep) 100%);
    overflow: hidden;
  }

  /* Title bar — visually shows "Lisa · session-id". The actual drag
     behavior is handled Swift-side by a transparent NSView overlay
     (DragHandleView) placed on top of the WKWebView for the same 36pt
     strip — WebKit ignores the CSS -webkit-app-region: drag property,
     so the cosmetic HTML and the functional drag region are two
     separate things.
     Padding-left reserves the ~78pt that the macOS traffic-light
     buttons occupy at top-left. */
  .titlebar {
    grid-area: titlebar;
    background: rgba(7, 9, 26, 0.55);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border-new);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 14px 0 78px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--fg-2);
    /* nothing here should ever capture pointer events — the NSView
       overlay above handles dragging, and there are no interactive
       elements in the HTML titlebar. */
    user-select: none;
    pointer-events: none;
  }
  .titlebar .session-tag {
    color: var(--fg-3);
    font-weight: 400;
    margin-left: 6px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    letter-spacing: 0;
  }

  /* ── Sidebar ───────────────────────────────────────────────── */
  .sidebar {
    grid-area: sidebar;
    background: rgba(7, 9, 26, 0.4);
    backdrop-filter: blur(30px);
    -webkit-backdrop-filter: blur(30px);
    border-right: 1px solid var(--border-new);
    overflow-y: auto;
    padding: 20px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  /* Identity card */
  .identity {
    display: grid;
    grid-template-columns: 56px 1fr;
    gap: 12px;
    align-items: center;
    padding: 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    border-radius: 14px;
  }
  .identity .avatar-wrap {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    position: relative;
    border: 1px solid var(--border-strong);
    box-shadow: 0 0 0 3px var(--accent-soft);
    background: #15192a;
  }
  .identity .avatar-wrap img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    object-position: 50% 22%;
    image-rendering: pixelated;
    display: block;
    transition: opacity 250ms ease;
    user-select: none;
    -webkit-user-drag: none;
  }
  .identity .avatar-wrap img.fading { opacity: 0; }
  .identity .avatar-wrap::after {
    content: "";
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #4ade80;
    border: 2px solid var(--bg-1);
  }
  .identity h1 {
    margin: 0 0 2px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--fg);
  }
  .identity .sub {
    margin: 0;
    font-size: 11px;
    color: var(--fg-3);
  }
  .identity .mood {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 4px;
    font-size: 10.5px;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }
  .identity .mood::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent-glow);
  }

  /* Sidebar plain text section ("currently wanting") */
  .sb-section { display: flex; flex-direction: column; gap: 6px; }
  .sb-section h2 {
    margin: 0 0 2px;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    color: var(--fg-3);
    padding-left: 4px;
  }
  .sb-section .body-text {
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
    color: var(--fg-2);
    padding: 0 4px;
  }

  /* Live mini-cards (Claude monitor / last reflection) */
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    border-radius: 12px;
    padding: 10px 12px;
    font-size: 12px;
    color: var(--fg-2);
    line-height: 1.5;
  }
  .card.tint-claude {
    border-color: rgba(255, 140, 66, 0.20);
    background: linear-gradient(180deg, rgba(255, 140, 66, 0.06), rgba(255, 140, 66, 0.02));
  }
  .card.tint-idle {
    border-color: rgba(255, 208, 102, 0.22);
    background: linear-gradient(180deg, rgba(255, 208, 102, 0.07), rgba(255, 208, 102, 0.02));
  }
  .card .h {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }
  .card .h .left {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    color: var(--claude);
  }
  .card.tint-idle .h .left { color: var(--warm); }
  .card .h .count {
    background: rgba(255, 140, 66, 0.16);
    color: var(--claude);
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 8px;
  }
  .card.tint-idle .h .count {
    background: rgba(255, 208, 102, 0.16);
    color: var(--warm);
  }
  .session-row {
    display: grid;
    grid-template-columns: 7px 1fr auto;
    align-items: center;
    gap: 7px;
    padding: 5px 0;
    font-size: 11.5px;
    border-top: 1px dashed rgba(255, 140, 66, 0.10);
    cursor: default;
  }
  .session-row:first-of-type { border-top: 0; }
  .session-row .pip {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fg-faint);
  }
  .session-row .pip.working { background: var(--claude); animation: pulse 1.8s ease-in-out infinite; }
  .session-row .pip.waiting { background: var(--claude); }
  .session-row .pip.error   { background: var(--err-color); }
  .session-row .name {
    color: var(--fg);
    font-weight: 600;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .session-row .when {
    color: var(--fg-3);
    font-variant-numeric: tabular-nums;
    font-size: 10.5px;
  }
  .session-empty {
    color: var(--fg-faint);
    font-size: 11.5px;
    font-style: italic;
    padding: 4px 0 2px;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.35; }
    50%      { opacity: 1; }
  }

  /* Compact SOUL / SKILLS / MEMORY / TOOLS row */
  .badges {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
  }
  .badge {
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    color: var(--fg-2);
    font-family: inherit;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 7px 8px;
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .badge:hover {
    background: var(--bg-card-strong);
    color: var(--fg);
    border-color: var(--border-strong);
  }
  .badge img {
    width: 14px;
    height: 14px;
    image-rendering: pixelated;
    opacity: 0.8;
  }

  /* Sidebar footer — session id + sessions count */
  .sb-footer {
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid var(--border-new);
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--fg-3);
    font-size: 11px;
  }
  .sb-footer .session-id {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10px;
    color: var(--fg-3);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .sb-footer .badge-count {
    background: var(--bg-3);
    color: var(--fg-2);
    border-radius: 6px;
    padding: 1px 6px;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  /* ── Main pane ─────────────────────────────────────────────── */
  .main {
    grid-area: main;
    display: grid;
    grid-template-rows: 1fr auto auto;
    overflow: hidden;
    background:
      radial-gradient(ellipse at 50% -30%, rgba(106, 212, 255, 0.06) 0%, transparent 60%),
      linear-gradient(180deg, transparent, rgba(106, 212, 255, 0.015));
  }

  #log {
    overflow-y: auto;
    padding: 22px 28px 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    scroll-behavior: smooth;
  }

  /* Chat author label (.role .you/.lisa) */
  .role {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 6px 2px 0;
    margin-top: 6px;
  }
  .role.you  { color: var(--accent); text-align: right; }
  .role.lisa { color: var(--warm); }

  /* Message bubble */
  .msg {
    display: block;
    max-width: 88%;
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    border-radius: 14px;
    padding: 9px 13px;
    font-size: 13px;
    line-height: 1.55;
    color: var(--fg);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  /* "you" bubbles sit on the right with cyan tint */
  .role.you + .msg {
    margin-left: auto;
    background: linear-gradient(160deg, rgba(106, 212, 255, 0.12), rgba(106, 212, 255, 0.06));
    border-color: rgba(106, 212, 255, 0.25);
  }
  /* attachment label sits compactly under the user bubble */
  .msg.attach-label {
    margin-top: 2px;
    background: transparent;
    border: 0;
    padding: 0 2px;
    font-size: 10.5px;
    color: var(--fg-3);
    max-width: 88%;
    margin-left: auto;
  }

  /* Thinking indicator */
  .thinking {
    font-size: 12px;
    color: var(--fg-3);
    font-style: italic;
    padding: 4px 2px;
    letter-spacing: 0.03em;
  }

  /* Tool call card */
  .tool-block {
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    border-radius: 10px;
    padding: 8px 12px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    color: var(--fg-2);
    margin: 4px 0;
    max-width: 92%;
  }
  .tool-block.tool-error {
    border-color: rgba(255, 85, 119, 0.30);
    background: rgba(255, 85, 119, 0.05);
  }
  .tool-head {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--accent);
    font-weight: 600;
  }
  .tool-block.tool-error .tool-head { color: var(--err-color); }
  .tool-icon { font-size: 12px; }
  .tool-spinner { color: var(--fg-3); font-weight: 400; margin-left: auto; font-size: 12px; }
  .tool-input {
    color: var(--fg-3);
    margin-top: 4px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tool-result {
    color: var(--fg-2);
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px dashed var(--border-new);
    white-space: pre-wrap;
    max-height: 160px;
    overflow-y: auto;
  }

  .err {
    color: var(--err-color);
    font-size: 12px;
    padding: 6px 2px;
  }

  /* Idle pulse + while-you-were-away banner injected into #log */
  .idle-pulse {
    color: var(--dream);
    font-size: 12px;
    font-style: italic;
    padding: 4px 2px;
    letter-spacing: 0.03em;
  }
  .idle-block {
    background: linear-gradient(180deg, rgba(180, 135, 255, 0.10), rgba(180, 135, 255, 0.02));
    border: 1px solid rgba(180, 135, 255, 0.30);
    border-radius: 14px;
    padding: 12px 14px;
    margin: 6px 0;
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--fg);
  }
  .idle-head {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    color: var(--dream);
    font-weight: 700;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .idle-time {
    margin-left: auto;
    font-weight: 400;
    letter-spacing: 0.05em;
    color: var(--fg-3);
    font-size: 10px;
  }

  /* Composer */
  #attachPreview {
    padding: 4px 22px 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 0;
  }
  #attachPreview:empty { padding: 0; }
  .attach-chip {
    background: var(--bg-card-strong);
    border: 1px solid var(--border-strong);
    color: var(--fg-2);
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .attach-rm {
    background: transparent;
    border: 0;
    color: var(--fg-3);
    cursor: pointer;
    font-size: 13px;
    padding: 0;
    line-height: 1;
  }
  .attach-rm:hover { color: var(--err-color); }

  #form {
    padding: 14px 20px 18px;
    background: rgba(7, 9, 26, 0.6);
    backdrop-filter: blur(30px);
    -webkit-backdrop-filter: blur(30px);
    border-top: 1px solid var(--border-new);
    display: grid;
    grid-template-columns: 36px 36px 1fr 96px;
    gap: 10px;
    align-items: end;
  }

  #attachBtn, #captureBtn {
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    color: var(--fg-3);
    font-size: 17px;
    cursor: pointer;
    border-radius: 10px;
    transition: background 120ms ease, color 120ms ease;
    min-height: 44px;
    padding: 0;
  }
  #attachBtn:hover, #captureBtn:hover { background: var(--bg-card); color: var(--fg); }
  #captureBtn.flash { background: var(--accent); color: var(--bg-deep); }
  /* Off-screen the file input instead of display:none. WKWebView's
     implicit <label>→<input type=file> click forward doesn't fire on a
     fully display:none input — the OS file picker silently no-ops.
     Off-screening keeps the input "live" while invisible. */
  #fileInput {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
  }

  #input {
    background: var(--bg-card-strong);
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    color: var(--fg);
    font-family: inherit;
    font-size: 13.5px;
    line-height: 1.45;
    padding: 11px 13px;
    resize: none;
    outline: none;
    width: 100%;
    min-height: 44px;
    max-height: 200px;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  #input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  #input::placeholder { color: var(--fg-3); }

  #sendBtn {
    background: linear-gradient(180deg, var(--accent) 0%, #4eb8e5 100%);
    color: #0a1024;
    border: 0;
    border-radius: 14px;
    height: 100%;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 14px;
    transition: transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
    box-shadow: 0 4px 14px rgba(106, 212, 255, 0.25);
  }
  #sendBtn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 6px 18px rgba(106, 212, 255, 0.35);
  }
  #sendBtn:active:not(:disabled) { transform: translateY(0); }
  #sendBtn:disabled { opacity: 0.5; cursor: wait; }
  /* Hide the legacy pixel send icon; the text label is enough in the new theme. */
  #sendBtn img { display: none; }

  /* ── Mobile / narrow ───────────────────────────────────────── */
  @media (max-width: 720px) {
    body {
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    .frame {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr auto;
    }
    .sidebar {
      max-height: 38vh;
      padding: 14px 14px 12px;
      gap: 14px;
    }
    #form {
      grid-template-columns: 36px 36px 1fr 84px;
      padding: 10px 14px 14px;
    }
    #input { font-size: 16px; /* prevents iOS Safari auto-zoom */ }
  }

  /* ===================================================================
     Modal panel (skills / memory / tools / soul) — unchanged from the
     legacy pixel-art shell. Uses the legacy CSS vars declared above.
     =================================================================== */
  .modal-bg {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: none;
    align-items: center; justify-content: center;
    z-index: 100;
  }
  .modal-bg.open { display: flex; }
  .modal {
    background: var(--bg-card-strong);
    border: 1px solid var(--border-strong);
    border-radius: 16px;
    backdrop-filter: blur(30px);
    -webkit-backdrop-filter: blur(30px);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
    max-width: 720px;
    width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
  }
  .modal-head {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-new);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .modal-title {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .modal-close {
    background: transparent;
    border: 1px solid var(--border-new);
    color: var(--fg-2);
    font-family: inherit;
    font-size: 11px;
    letter-spacing: 0.06em;
    padding: 5px 10px;
    border-radius: 8px;
    cursor: pointer;
  }
  .modal-close:hover { color: var(--err-color); border-color: rgba(255, 85, 119, 0.40); }
  .modal-body {
    padding: 16px 18px;
    overflow-y: auto;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--fg-2);
  }
  .modal-body h3 {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 14px 0 6px 0;
    border-bottom: 1px dashed var(--border-new);
    padding-bottom: 5px;
  }
  .modal-body h3:first-child { margin-top: 0; }
  .modal-body .item {
    padding: 7px 0;
    border-bottom: 1px dotted var(--border-new);
  }
  .modal-body .item:last-child { border: none; }
  .modal-body .name {
    color: var(--warm);
    font-weight: 600;
    font-size: 12px;
  }
  .modal-body .desc { color: var(--fg-3); margin-top: 2px; }
  .modal-body pre {
    background: rgba(0, 0, 0, 0.30);
    padding: 10px 12px;
    border-left: 2px solid var(--accent);
    border-radius: 4px;
    white-space: pre-wrap;
    margin: 6px 0;
    color: var(--fg);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    line-height: 1.5;
  }
  .modal-body .empty { color: var(--fg-faint); font-style: italic; }

  /* ===================================================================
     Birth ritual overlay — full-screen, one-time. Uses legacy palette
     intentionally (it's a separate ceremonial moment).
     =================================================================== */
  .birth-overlay {
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(40, 30, 80, 0.95) 0%, rgba(5, 5, 20, 1) 70%);
    z-index: 9999;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }
  .birth-overlay.open { display: flex; }
  .birth-content {
    position: relative;
    z-index: 2;
    width: min(800px, 95vw);
    max-height: 90vh;
    overflow-y: auto;
  }
  .birth-stars {
    text-align: center;
    color: var(--accent);
    font-size: 14px;
    letter-spacing: 8px;
    text-shadow: 0 0 8px var(--accent-glow);
    animation: starBlink 1.5s steps(3) infinite;
  }
  @keyframes starBlink {
    0%, 30%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .birth-title {
    text-align: center;
    color: var(--warm);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 6px;
    margin: 24px 0 32px;
    text-shadow: 0 0 12px rgba(255, 208, 102, 0.45);
  }
  .birth-step {
    margin: 14px 0;
    padding: 10px 16px;
    border-left: 3px solid var(--border-new);
    background: rgba(20, 26, 64, 0.55);
    border-radius: 0 8px 8px 0;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.4s ease-out, transform 0.4s ease-out;
  }
  .birth-step.shown { opacity: 1; transform: translateY(0); }
  .birth-step.active {
    border-left-color: var(--warm);
    background: rgba(255, 208, 102, 0.08);
  }
  .birth-step.done { border-left-color: var(--accent); }
  .birth-step .step-name {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.10em;
    color: var(--fg-3);
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .birth-step.active .step-name { color: var(--warm); }
  .birth-step.done .step-name { color: var(--accent); }
  .birth-step .step-detail {
    color: var(--fg);
    font-size: 13px;
    line-height: 1.55;
    word-break: break-word;
  }
  .birth-step .step-cursor {
    display: inline-block;
    width: 6px;
    background: var(--warm);
    height: 0.9em;
    vertical-align: middle;
    animation: blink 0.8s steps(2) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .birth-final {
    margin-top: 36px;
    text-align: center;
    color: var(--warm);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.10em;
    text-shadow: 0 0 10px rgba(255, 208, 102, 0.4);
    opacity: 0;
    transition: opacity 0.6s ease-in;
  }
  .birth-final.shown { opacity: 1; }
  .birth-enter {
    margin: 24px auto 0;
    display: block;
    background: linear-gradient(180deg, var(--accent) 0%, #4eb8e5 100%);
    border: 0;
    color: #0a1024;
    font-family: inherit;
    font-weight: 700;
    font-size: 13px;
    padding: 12px 32px;
    border-radius: 12px;
    cursor: pointer;
    letter-spacing: 0.10em;
    opacity: 0;
    transition: opacity 0.6s ease-in, transform 120ms ease;
    box-shadow: 0 6px 18px rgba(106, 212, 255, 0.35);
  }
  .birth-enter.shown { opacity: 1; }
  .birth-enter:hover { transform: translateY(-1px); }
  .birth-error {
    color: var(--err-color);
    text-align: center;
    margin-top: 24px;
    font-size: 11.5px;
    letter-spacing: 0.05em;
  }

  /* ===================================================================
     API-key config overlay — same modernized treatment.
     =================================================================== */
  .cfg-overlay {
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(40, 30, 80, 0.95) 0%, rgba(5, 5, 20, 1) 70%);
    z-index: 9998;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }
  .cfg-overlay.open { display: flex; }
  .cfg-card {
    position: relative;
    z-index: 2;
    width: min(520px, 95vw);
    background: var(--bg-card-strong);
    border: 1px solid var(--border-strong);
    border-radius: 16px;
    backdrop-filter: blur(30px);
    -webkit-backdrop-filter: blur(30px);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
    padding: 28px 32px;
  }
  .cfg-stars {
    text-align: center;
    color: var(--accent);
    font-size: 12px;
    letter-spacing: 6px;
    text-shadow: 0 0 8px var(--accent-glow);
    animation: starBlink 1.5s steps(3) infinite;
  }
  .cfg-title {
    text-align: center;
    color: var(--warm);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 6px;
    margin: 16px 0 6px;
  }
  .cfg-sub {
    text-align: center;
    color: var(--fg-3);
    font-size: 12.5px;
    margin-bottom: 22px;
    line-height: 1.5;
  }
  .cfg-sub a { color: var(--accent); text-decoration: underline; }
  .cfg-field { display: block; margin: 14px 0; }
  .cfg-label {
    display: block;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .cfg-label .opt {
    color: var(--fg-3);
    font-size: 9.5px;
    margin-left: 6px;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  .cfg-input {
    width: 100%;
    background: var(--bg-card);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    color: var(--fg);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px;
    padding: 10px 12px;
  }
  .cfg-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .cfg-help {
    color: var(--fg-3);
    font-size: 11px;
    margin-top: 6px;
  }
  .cfg-help code {
    color: var(--fg-2);
    background: rgba(0, 0, 0, 0.3);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
  }
  .cfg-actions {
    margin-top: 22px;
    display: flex;
    justify-content: center;
  }
  .cfg-save {
    background: linear-gradient(180deg, var(--accent) 0%, #4eb8e5 100%);
    border: 0;
    color: #0a1024;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 700;
    padding: 11px 28px;
    border-radius: 12px;
    cursor: pointer;
    letter-spacing: 0.10em;
    box-shadow: 0 4px 14px rgba(106, 212, 255, 0.25);
    transition: transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
  }
  .cfg-save:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(106, 212, 255, 0.35); }
  .cfg-save:active { transform: translateY(0); }
  .cfg-save:disabled { opacity: 0.55; cursor: wait; }
  .cfg-error {
    color: var(--err-color);
    font-size: 11px;
    text-align: center;
    margin-top: 14px;
    min-height: 14px;
  }
</style>
</head><body>

<div class="frame">

  <!-- ╔════════════════ Title bar (drag zone) ════════════════╗ -->
  <div class="titlebar">
    <span>Lisa</span><span class="session-tag" id="titlebarSession"></span>
  </div>

  <!-- ╔════════════════ Sidebar ════════════════╗ -->
  <aside class="sidebar">

    <!-- Identity card -->
    <div class="identity">
      <div class="avatar-wrap">
        <img id="mascot" src="/assets/lisa-mascot.png" alt="Lisa" draggable="false">
      </div>
      <div>
        <h1>Lisa</h1>
        <p class="sub" id="identitySub">—</p>
        <div class="mood" id="mascotTag">neutral</div>
      </div>
    </div>

    <!-- Currently wanting -->
    <div class="sb-section">
      <h2>currently wanting</h2>
      <p class="body-text" id="sbDesire">—</p>
    </div>

    <!-- Claude Code monitor -->
    <div class="card tint-claude" id="sbClaudeCard">
      <div class="h">
        <div class="left">claude code</div>
        <div class="count">▶︎ <span id="sbClaudeCount">0</span></div>
      </div>
      <div id="sbClaudeRows">
        <div class="session-empty">(idle)</div>
      </div>
    </div>

    <!-- Last reflection (collapsed pointer to the most recent ★) -->
    <div class="card tint-idle" id="sbReflection" style="display:none;">
      <div class="h">
        <div class="left">★ last reflection</div>
      </div>
      <p style="margin:0; font-size:11.5px; color:var(--fg-2); line-height:1.5;" id="sbReflectionBody"></p>
    </div>

    <!-- SOUL / SKILLS / MEMORY / TOOLS row -->
    <div class="badges">
      <button class="badge" type="button" data-panel="soul"><img src="/assets/icon-soul.png" alt="">SOUL</button>
      <button class="badge" type="button" data-panel="skills"><img src="/assets/icon-skill.png" alt="">SKILLS</button>
      <button class="badge" type="button" data-panel="memory"><img src="/assets/icon-memory.png" alt="">MEMORY</button>
      <button class="badge" type="button" data-panel="tools"><img src="/assets/icon-tool.png" alt="">TOOLS</button>
    </div>

    <!-- Footer: current session id -->
    <div class="sb-footer">
      <span class="session-id" id="sessionId">—</span>
      <span class="badge-count" id="sbSessionBadge" title="total sessions">·</span>
    </div>
  </aside>

  <!-- ╔════════════════ Main pane ════════════════╗ -->
  <div class="main">

    <!-- Chat log (messages, tool blocks, idle blocks injected here) -->
    <div id="log"></div>

    <!-- Attachment chip strip (above composer) -->
    <div id="attachPreview"></div>

    <!-- Composer -->
    <form id="form">
      <label id="attachBtn" title="Attach file (or paste images directly into the textarea)">
        <input type="file" id="fileInput" accept="image/*,.pdf,.txt,.md,.csv,.json" multiple>
        📎
      </label>
      <button type="button" id="captureBtn" title="Screenshot for Lisa (⌃⌥S anywhere)">📷</button>
      <textarea id="input" placeholder="Talk to Lisa…  (Enter to send · Shift+Enter for newline)" autofocus></textarea>
      <button type="submit" id="sendBtn">
        <img src="/assets/icon-send.png" alt="">
        SEND →
      </button>
    </form>
  </div>
</div>

<!-- ╔════════════════ Overlays ════════════════╗ -->

<div class="modal-bg" id="modalBg">
  <div class="modal">
    <div class="modal-head">
      <div class="modal-title" id="modalTitle">…</div>
      <button class="modal-close" id="modalClose">Close · esc</button>
    </div>
    <div class="modal-body" id="modalBody">…</div>
  </div>
</div>

<!-- API key config overlay (shown if no key configured yet) -->
<div class="cfg-overlay" id="cfgOverlay">
  <div class="cfg-card">
    <div class="cfg-stars">✦  ✦  ✦  ✦  ✦</div>
    <div class="cfg-title">SET · API · KEY</div>
    <div class="cfg-sub">
      Lisa needs an Anthropic API key to wake up.<br>
      <a href="https://console.anthropic.com/" target="_blank" rel="noopener">Get one at console.anthropic.com</a>
    </div>
    <form id="cfgForm">
      <label class="cfg-field">
        <span class="cfg-label">ANTHROPIC_API_KEY</span>
        <input class="cfg-input" id="cfgAnthropic" type="password" autocomplete="off"
               spellcheck="false" placeholder="sk-ant-..." required>
      </label>
      <label class="cfg-field">
        <span class="cfg-label">OPENAI_API_KEY <span class="opt">(optional · for gpt-* models)</span></span>
        <input class="cfg-input" id="cfgOpenai" type="password" autocomplete="off"
               spellcheck="false" placeholder="sk-...">
      </label>
      <div class="cfg-help">
        Saved to <code>~/.lisa/config.env</code> with mode 0600. Stays on this machine.
      </div>
      <div class="cfg-actions">
        <button class="cfg-save" id="cfgSave" type="submit">SAVE &amp; CONTINUE</button>
      </div>
      <div class="cfg-error" id="cfgError"></div>
    </form>
  </div>
</div>

<!-- Birth ritual full-screen overlay -->
<div class="birth-overlay" id="birthOverlay">
  <div class="birth-content">
    <div class="birth-stars">✦  ✦  ✦  ✦  ✦</div>
    <div class="birth-title">B I R T H · R I T U A L</div>
    <div id="birthSteps"></div>
    <div class="birth-final" id="birthFinal"></div>
    <button class="birth-enter" id="birthEnter">ENTER</button>
    <div class="birth-error" id="birthError"></div>
    <div class="birth-stars" style="margin-top: 24px;">✦  ✦  ✦  ✦  ✦</div>
  </div>
</div>

<script>
const log = document.getElementById('log');
const input = document.getElementById('input');
const form = document.getElementById('form');
const sendBtn = document.getElementById('sendBtn');
const sessionEl = document.getElementById('sessionId');
const fileInput = document.getElementById('fileInput');
const attachPreview = document.getElementById('attachPreview');

// ── Attached files state ──────────────────────────────────────────
let pendingFiles = []; // Array of {name, mediaType, data (base64)}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function inferMediaType(file) {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop().toLowerCase();
  const map = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', csv: 'text/csv', json: 'application/json' };
  return map[ext] || 'application/octet-stream';
}

// ── Vision: screenshot → composer ──────────────────────────────────
// lisaAttachImage adds an already-encoded {name,mediaType,data} object to
// the pending attachments — used by both the in-page 📷 button and the
// native global hotkey (Lisa.app calls lisaCaptureAndAttach via JS bridge).
window.lisaAttachImage = function (file) {
  if (!file || !file.data) return;
  pendingFiles.push({
    name: file.name || 'screenshot.png',
    mediaType: file.mediaType || 'image/png',
    data: file.data,
  });
  renderAttachPreview();
  try { input.focus(); } catch (_) {}
};

// lisaCaptureAndAttach asks the server to run a screen capture, then
// attaches the result. mode: 'interactive' (crosshair, default) | 'full'.
// Returns true if an image was attached, false if cancelled/failed.
// Exposed on window so the native app's global hotkey can invoke it.
let capturing = false;
window.lisaCaptureAndAttach = async function (mode) {
  if (capturing) return false;
  capturing = true;
  const btn = document.getElementById('captureBtn');
  if (btn) btn.classList.add('flash');
  try {
    const res = await fetch('/api/vision/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: mode || 'interactive' }),
    });
    if (!res.ok) {
      console.warn('[vision] capture failed: HTTP ' + res.status);
      return false;
    }
    const data = await res.json();
    if (data.cancelled || !data.file) return false;
    window.lisaAttachImage(data.file);
    return true;
  } catch (err) {
    console.warn('[vision] capture error:', err);
    return false;
  } finally {
    capturing = false;
    if (btn) setTimeout(() => btn.classList.remove('flash'), 200);
  }
};

function renderAttachPreview() {
  attachPreview.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.textContent = f.name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-rm';
    rm.textContent = '×';
    rm.onclick = () => { pendingFiles.splice(i, 1); renderAttachPreview(); };
    chip.appendChild(rm);
    attachPreview.appendChild(chip);
  });
}

fileInput.addEventListener('change', async () => {
  for (const file of fileInput.files) {
    const data = await readFileAsBase64(file);
    pendingFiles.push({ name: file.name, mediaType: inferMediaType(file), data });
  }
  fileInput.value = '';
  renderAttachPreview();
});

// The natural <label>→<input type=file> click-forwarding is supposed
// to open the picker without any JS. But in WKWebView under our
// layout it never reaches runOpenPanel. We add an explicit click
// listener that forwards the click synchronously (preserving the
// user-gesture context) and logs to console so we can verify in the
// inspector if it ever silently no-ops again.
// 📷 capture button → interactive crosshair screenshot into the composer.
const captureBtnEl = document.getElementById('captureBtn');
if (captureBtnEl) {
  captureBtnEl.addEventListener('click', () => { void window.lisaCaptureAndAttach('interactive'); });
}

const attachBtnEl = document.getElementById('attachBtn');
if (attachBtnEl) {
  attachBtnEl.addEventListener('click', (ev) => {
    // Don't preventDefault — that cancels the implicit label-forward
    // and removes the redundant gesture path. Letting both fire is
    // fine because <input type=file>.click() fires the picker only
    // once per user gesture.
    console.log('[attach] click forwarded to fileInput');
    try {
      fileInput.click();
    } catch (err) {
      console.error('[attach] fileInput.click failed:', err);
    }
  });
}

// Paste-to-attach: when the user has copied an image (screenshot,
// image from a webpage, etc.) and presses ⌘V, pull the image off the
// clipboard and add it to pendingFiles — same path the file picker
// uses. Plain-text paste falls through to default behavior.
//
// We listen at the DOCUMENT level so paste works whether the textarea
// is focused, the chat log is focused, or focus is on a tool-block.
// (Some users press ⌘V right after launching the app, before clicking
// anywhere — element-scoped handlers miss that.)
//
// For text paste we MUST NOT preventDefault — let the browser route
// it to the focused element. Only intercept when we detect image
// items.
async function handlePastedClipboard(ev) {
  const cb = ev.clipboardData;
  if (!cb) return;

  // Two clipboard surfaces — items (modern, exposes pasteboard files)
  // and files (older, doesn't include MIME type for some types). We
  // dedupe via the underlying File reference.
  const fileMap = new Map();  // File → mediaType (string)
  if (cb.items && cb.items.length) {
    for (const item of cb.items) {
      if (item.kind !== 'file') continue;
      if (!item.type || !item.type.startsWith('image/')) continue;
      const f = item.getAsFile();
      if (f) fileMap.set(f, item.type);
    }
  }
  if (cb.files && cb.files.length) {
    for (const f of cb.files) {
      if (f.type && f.type.startsWith('image/')) {
        if (!fileMap.has(f)) fileMap.set(f, f.type || 'image/png');
      }
    }
  }

  if (fileMap.size === 0) return; // text paste — leave default behavior alone

  ev.preventDefault();
  // Keep focus on the textarea so the user can keep typing right after.
  try { input.focus(); } catch (_) {}

  for (const [file, mediaType] of fileMap) {
    try {
      const data = await readFileAsBase64(file);
      const ext = (mediaType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = file.name && file.name !== 'image.png'
        ? file.name
        : 'pasted-' + ts + '.' + ext;
      pendingFiles.push({ name, mediaType, data });
    } catch (err) {
      console.warn('[paste] failed to read image:', err);
    }
  }
  renderAttachPreview();
}

input.addEventListener('paste',  (ev) => { void handlePastedClipboard(ev); });
// Document-level fallback. If focus is somewhere other than the
// textarea (e.g. just-launched, no focus yet), the textarea-level
// paste listener never fires; this one catches it.
document.addEventListener('paste', (ev) => {
  // Avoid double-firing when the textarea ALREADY handled it: if
  // ev.defaultPrevented is set, the textarea listener already
  // consumed the paste and added the file.
  if (ev.defaultPrevented) return;
  void handlePastedClipboard(ev);
});

// Surface session id from server header on first request. The titlebar
// shows the same id with a leading "·" separator after the "Lisa" label.
fetch('/session').then(r => r.json()).then(s => {
  sessionEl.textContent = s.id;
  const titlebarSession = document.getElementById('titlebarSession');
  if (titlebarSession) titlebarSession.textContent = '· ' + s.id;
});

// ── Persistent /events SSE: mood updates + idle messages + Claude
// activity, lifetime of page.
function connectEvents() {
  const es = new EventSource('/events');
  let idlePulseEl = null;
  es.addEventListener('message', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'mood') {
      setMood(ev.slug);
    } else if (ev.type === 'idle_start') {
      if (!idlePulseEl) {
        idlePulseEl = document.createElement('div');
        idlePulseEl.className = 'idle-pulse';
        idlePulseEl.textContent = '⋯ Lisa is thinking on her own time ⋯';
        log.appendChild(idlePulseEl);
        log.scrollTop = log.scrollHeight;
      }
    } else if (ev.type === 'idle_message') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
      const block = document.createElement('div');
      block.className = 'idle-block';
      const head = document.createElement('div');
      head.className = 'idle-head';
      head.textContent = '★ WHILE YOU WERE AWAY';
      const time = document.createElement('span');
      time.className = 'idle-time';
      try { time.textContent = new Date(ev.at).toLocaleTimeString(); } catch {}
      head.appendChild(time);
      block.appendChild(head);
      const bodyEl = document.createElement('div');
      bodyEl.textContent = ev.text;
      block.appendChild(bodyEl);
      log.appendChild(block);
      log.scrollTop = log.scrollHeight;
      // sidebar reflection card mirrors the latest while-you-were-away
      if (typeof updateReflection === 'function') updateReflection(ev.text);
    } else if (ev.type === 'idle_done') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
    } else if (ev.type === 'idle_error') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
      const e2 = document.createElement('div');
      e2.className = 'err';
      e2.textContent = '[idle error] ' + ev.message;
      log.appendChild(e2);
    } else if (ev.type === 'claude_session_update') {
      // Sidebar Claude monitor card refresh — defined later in the
      // "sidebar live wiring" block.
      if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions();
    }
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 3000); // reconnect
  };
}
connectEvents();

// ── API key config gate: show overlay if no key is configured ─────
const cfgOverlay = document.getElementById('cfgOverlay');
const cfgForm = document.getElementById('cfgForm');
const cfgAnthropic = document.getElementById('cfgAnthropic');
const cfgOpenai = document.getElementById('cfgOpenai');
const cfgSaveBtn = document.getElementById('cfgSave');
const cfgError = document.getElementById('cfgError');

cfgForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  cfgError.textContent = '';
  const anthropic = cfgAnthropic.value.trim();
  const openai = cfgOpenai.value.trim();
  if (!anthropic) {
    cfgError.textContent = 'ANTHROPIC_API_KEY is required.';
    return;
  }
  cfgSaveBtn.disabled = true;
  try {
    const res = await fetch('/api/config/save', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ anthropicKey: anthropic, openaiKey: openai || undefined }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      cfgError.textContent = 'Save failed: HTTP ' + res.status + (txt ? ' — ' + txt.slice(0, 120) : '');
      cfgSaveBtn.disabled = false;
      return;
    }
    cfgAnthropic.value = '';
    cfgOpenai.value = '';
    cfgOverlay.classList.remove('open');
    maybeBirth();
  } catch (err) {
    cfgError.textContent = 'Save failed: ' + err.message;
    cfgSaveBtn.disabled = false;
  }
});

// ── Birth ritual: show overlay if Lisa hasn't been born yet ───────
const birthOverlay = document.getElementById('birthOverlay');
const birthStepsEl = document.getElementById('birthSteps');
const birthFinalEl = document.getElementById('birthFinal');
const birthEnterBtn = document.getElementById('birthEnter');
const birthErrorEl = document.getElementById('birthError');

birthEnterBtn.addEventListener('click', () => {
  birthOverlay.classList.remove('open');
  setTimeout(() => location.reload(), 300);
});

async function maybeBirth() {
  const status = await fetch('/api/soul').then(r => r.json());
  if (status.born) return;
  birthOverlay.classList.add('open');
  startBirthStream();
}

function appendBirthStep(step) {
  const prevActive = birthStepsEl.querySelector('.birth-step.active');
  if (prevActive) {
    prevActive.classList.remove('active');
    prevActive.classList.add('done');
  }
  const div = document.createElement('div');
  div.className = 'birth-step active';
  const name = document.createElement('div');
  name.className = 'step-name';
  name.textContent = step;
  div.appendChild(name);
  const detail = document.createElement('div');
  detail.className = 'step-detail';
  const cursor = document.createElement('span');
  cursor.className = 'step-cursor';
  detail.appendChild(cursor);
  div.appendChild(detail);
  birthStepsEl.appendChild(div);
  setTimeout(() => div.classList.add('shown'), 50);
  return detail;
}

function typewriter(el, text, done) {
  const cursor = el.querySelector('.step-cursor');
  if (cursor) cursor.remove();
  let i = 0;
  const speed = Math.max(8, Math.min(28, 600 / text.length));
  function tick() {
    if (i >= text.length) {
      const c = document.createElement('span');
      c.className = 'step-cursor';
      el.appendChild(c);
      done && done();
      return;
    }
    el.appendChild(document.createTextNode(text[i]));
    i++;
    el.parentElement.parentElement.scrollTop = el.parentElement.parentElement.scrollHeight;
    setTimeout(tick, speed);
  }
  tick();
}

async function startBirthStream() {
  birthErrorEl.textContent = '';
  let currentDetail = null;
  let queue = [];
  let processing = false;

  function processQueue() {
    if (processing) return;
    if (queue.length === 0) return;
    processing = true;
    const ev = queue.shift();
    if (ev.kind === 'step') {
      currentDetail = appendBirthStep(ev.name);
      typewriter(currentDetail, ev.detail || '', () => {
        processing = false;
        processQueue();
      });
    } else if (ev.kind === 'done') {
      const last = birthStepsEl.querySelector('.birth-step.active');
      if (last) { last.classList.remove('active'); last.classList.add('done'); }
      birthFinalEl.textContent = ev.message;
      birthFinalEl.classList.add('shown');
      birthEnterBtn.classList.add('shown');
      processing = false;
    } else if (ev.kind === 'error') {
      birthErrorEl.textContent = ev.message;
      processing = false;
    }
  }

  try {
    const res = await fetch('/api/birth', { method: 'POST' });
    if (!res.ok) {
      birthErrorEl.textContent = 'Birth failed: HTTP ' + res.status + '. Check ANTHROPIC_API_KEY.';
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\\n\\n')) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = event.match(/^data: (.*)$/m);
        if (!m) continue;
        const ev = JSON.parse(m[1]);
        queue.push(ev);
        processQueue();
      }
    }
  } catch (err) {
    birthErrorEl.textContent = 'Birth failed: ' + err.message;
  }
}

async function startupGate() {
  let cfg;
  try {
    cfg = await fetch('/api/config/status').then(r => r.json());
  } catch {
    return;
  }
  if (!cfg.configured) {
    cfgOverlay.classList.add('open');
    setTimeout(() => cfgAnthropic.focus(), 50);
    return;
  }
  maybeBirth();
}
startupGate();

// ── history load & infinite-scroll ──────────────────────────────────
let historyPage = 0;
let historyLoading = false;
let historyExhausted = false;

function textOfMessage(msg) {
  if (typeof msg.content === 'string') return msg.content.trim();
  if (!Array.isArray(msg.content)) return '';
  return msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

function prependHistoryMessages(messages) {
  const fragment = document.createDocumentFragment();
  for (const msg of messages) {
    const text = textOfMessage(msg);
    if (!text) continue;
    const roleDiv = document.createElement('div');
    roleDiv.className = 'role ' + (msg.role === 'user' ? 'you' : 'lisa');
    roleDiv.textContent = msg.role === 'user' ? 'YOU' : 'LISA';
    const span = document.createElement('span');
    span.className = 'msg';
    span.textContent = text;
    fragment.appendChild(roleDiv);
    fragment.appendChild(span);
  }
  log.insertBefore(fragment, log.firstChild);
}

async function loadHistoryPage() {
  if (historyLoading || historyExhausted) return;
  historyLoading = true;
  const prevScrollHeight = log.scrollHeight;
  try {
    const res = await fetch('/api/history?page=' + historyPage);
    const data = await res.json();
    if (data.messages && data.messages.length) {
      prependHistoryMessages(data.messages);
      log.scrollTop = log.scrollHeight - prevScrollHeight;
      historyPage++;
    }
    if (!data.hasMore) {
      historyExhausted = true;
      if (historyPage > 1) {
        const marker = document.createElement('div');
        marker.style.cssText = 'text-align:center;color:var(--fg-3);font-size:11px;padding:8px 0;letter-spacing:0.06em;';
        marker.textContent = '— end of history —';
        log.insertBefore(marker, log.firstChild);
      }
    }
  } finally {
    historyLoading = false;
  }
}

loadHistoryPage();
log.addEventListener('scroll', () => {
  if (log.scrollTop < 80) loadHistoryPage();
});

// ── mascot crossfade on mood event ──────────────────────────────────
const mascotEl = document.getElementById('mascot');
const mascotTagEl = document.getElementById('mascotTag');
let currentMood = 'neutral';
function setMood(slug) {
  if (!slug || slug === currentMood) return;
  const url = '/assets/lisa/' + encodeURIComponent(slug) + '.png';
  const probe = new Image();
  probe.onload = () => {
    mascotEl.classList.add('fading');
    setTimeout(() => {
      mascotEl.src = url;
      mascotTagEl.textContent = 'mood: ' + slug;
      mascotEl.classList.remove('fading');
      currentMood = slug;
    }, 250);
  };
  probe.onerror = () => { /* asset not generated yet — keep current */ };
  probe.src = url;
}

// ── modal panel: SOUL / SKILLS / MEMORY / TOOLS ──────────────────────
const modalBg = document.getElementById('modalBg');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalClose = document.getElementById('modalClose');

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function openModal(title, html) {
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBg.classList.add('open');
}
function closeModal() { modalBg.classList.remove('open'); }
modalClose.addEventListener('click', closeModal);
modalBg.addEventListener('click', (e) => { if (e.target === modalBg) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

async function showSkills() {
  openModal('SKILLS', '<div class="empty">loading…</div>');
  const data = await fetch('/api/skills').then(r => r.json());
  if (!data.skills.length) {
    modalBody.innerHTML = '<div class="empty">No skills saved yet. Lisa will start saving useful workflows as you use her.</div>';
    return;
  }
  modalBody.innerHTML = data.skills.map(s =>
    '<div class="item"><div class="name">' + escapeHtml(s.name) + '</div><div class="desc">' + escapeHtml(s.description) + '</div></div>'
  ).join('');
}

async function showMemory() {
  openModal('MEMORY', '<div class="empty">loading…</div>');
  const data = await fetch('/api/memory').then(r => r.json());
  modalBody.innerHTML =
    '<h3>USER.md — what Lisa remembers about you</h3>' +
    '<pre>' + escapeHtml(data.user || '(empty)') + '</pre>' +
    '<h3>MEMORY.md — Lisa\\'s working notes</h3>' +
    '<pre>' + escapeHtml(data.memory || '(empty)') + '</pre>';
}

async function showTools() {
  openModal('TOOLS', '<div class="empty">loading…</div>');
  const data = await fetch('/api/tools').then(r => r.json());
  modalBody.innerHTML = data.tools.map(t =>
    '<div class="item"><div class="name">' + escapeHtml(t.name) + '</div><div class="desc">' + escapeHtml(t.description) + '</div></div>'
  ).join('');
}

async function showSoul() {
  openModal('★ SOUL', '<div class="empty">loading…</div>');
  const data = await fetch('/api/soul').then(r => r.json());
  if (!data.born) {
    modalBody.innerHTML = '<div class="empty">Lisa hasn\\'t been born yet. Restart the CLI without --no-birth and the birth ritual will run.</div>';
    return;
  }
  const s = data.summary;
  let html = '';
  html += '<h3>name</h3><div>' + escapeHtml(s.name) + '</div>';
  html += '<h3>born</h3><div>' + escapeHtml(s.seed.bornAt) + ' · big5(O' + Math.round(s.seed.bigFive.openness*100) + ' C' + Math.round(s.seed.bigFive.conscientiousness*100) + ' E' + Math.round(s.seed.bigFive.extraversion*100) + ' A' + Math.round(s.seed.bigFive.agreeableness*100) + ' N' + Math.round(s.seed.bigFive.neuroticism*100) + ')</div>';
  html += '<h3>identity</h3><pre>' + escapeHtml(s.identity) + '</pre>';
  html += '<h3>purpose</h3><pre>' + escapeHtml(s.purpose) + '</pre>';
  html += '<h3>constitution</h3><pre>' + escapeHtml(s.constitution) + '</pre>';
  if (s.values?.length) {
    html += '<h3>values</h3>' + s.values.map(v =>
      '<div class="item"><div class="name">' + escapeHtml(v.title) + '</div><div class="desc">' + escapeHtml(v.body) + '</div></div>'
    ).join('');
  }
  if (s.opinions?.length) {
    html += '<h3>opinions</h3>' + s.opinions.map(o =>
      '<div class="item"><div class="name">' + escapeHtml(o.stance) + ' (conf ' + o.confidence.toFixed(2) + ')</div></div>'
    ).join('');
  }
  if (s.desires?.length) {
    html += '<h3>desires</h3>' + s.desires.map(d =>
      '<div class="item"><div class="name">' + escapeHtml(d.what) + (d.actionable ? ' [heartbeat-active]' : '') + '</div><div class="desc">' + escapeHtml(d.why) + '</div></div>'
    ).join('');
  }
  html += '<h3>emotions</h3>' + Object.entries(s.emotions.values).map(([k, v]) => {
    const len = 12;
    const filled = Math.round(Math.abs(v) * len);
    const bar = '█'.repeat(filled) + '░'.repeat(len - filled);
    return '<div class="item"><div class="name">' + escapeHtml(k) + '</div><div class="desc">' + (v < 0 ? '-' : ' ') + bar + '  ' + v.toFixed(2) + '</div></div>';
  }).join('');
  if (s.tampered?.length) {
    html += '<h3>⚠ tampered</h3><div>External edits detected on: ' + s.tampered.map(escapeHtml).join(', ') + '</div>';
  }
  html += '<h3 style="color: var(--fg-3); font-size: 10px;">privacy note</h3><div class="empty">Her journal lives at ~/.lisa/soul/journal/ but is intentionally not shown here — that is hers to keep.</div>';
  modalBody.innerHTML = html;
}

document.querySelectorAll('.badge').forEach(b => {
  b.addEventListener('click', () => {
    const which = b.dataset.panel;
    if (which === 'soul') showSoul();
    else if (which === 'skills') showSkills();
    else if (which === 'memory') showMemory();
    else if (which === 'tools') showTools();
  });
});

let currentLisaSpan = null;
let pendingTools = new Map();
let thinkingEl = null;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  log.appendChild(node);
  log.scrollTop = log.scrollHeight;
  return node;
}

function ensureLisaSpan() {
  if (currentLisaSpan) return currentLisaSpan;
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  el('div', 'role lisa', 'LISA');
  currentLisaSpan = el('span', 'msg', '');
  return currentLisaSpan;
}

function previewInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const order = ['command', 'pattern', 'query', 'path', 'description', 'audio_path', 'text', 'name', 'action', 'entry'];
  for (const k of order) {
    if (typeof input[k] === 'string' && input[k]) {
      let v = input[k].replace(/\\s+/g, ' ').trim();
      if (v.length > 120) v = v.slice(0, 117) + '...';
      return v;
    }
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  } catch { return ''; }
}

async function send(message) {
  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;
  el('div', 'role you', 'YOU');
  el('span', 'msg', message || '(attachment)');
  if (pendingFiles.length) {
    const names = pendingFiles.map(f => f.name).join(', ');
    el('span', 'msg attach-label', '📎 ' + names);
  }
  const filesToSend = [...pendingFiles];
  pendingFiles = [];
  renderAttachPreview();
  currentLisaSpan = null;
  pendingTools.clear();
  thinkingEl = el('div', 'thinking', '⋯ thinking');
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({message, files: filesToSend}),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += decoder.decode(value, {stream: true});
      let idx;
      while ((idx = buf.indexOf('\\n\\n')) >= 0) {
        const evRaw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = evRaw.match(/^data: (.*)$/m);
        if (!m) continue;
        const ev = JSON.parse(m[1]);
        if (ev.type === 'text') {
          ensureLisaSpan().textContent += ev.text;
        } else if (ev.type === 'tool_start') {
          if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
          currentLisaSpan = null;
          const block = el('div', 'tool-block', null);
          const head = document.createElement('div');
          head.className = 'tool-head';
          head.innerHTML = '<span class="tool-icon">⚙</span> <span class="tool-name"></span> <span class="tool-spinner">...</span>';
          head.querySelector('.tool-name').textContent = ev.name;
          block.appendChild(head);
          const preview = previewInput(ev.name, ev.input);
          if (preview) {
            const p = document.createElement('div');
            p.className = 'tool-input';
            p.textContent = preview;
            block.appendChild(p);
          }
          pendingTools.set(ev.name, block);
        } else if (ev.type === 'tool_end') {
          const block = pendingTools.get(ev.name);
          if (block) {
            const spinner = block.querySelector('.tool-spinner');
            if (spinner) spinner.textContent = ev.isError ? '✗' : '✓';
            if (ev.isError) block.classList.add('tool-error');
            if (ev.resultPreview) {
              const r = document.createElement('div');
              r.className = 'tool-result';
              r.textContent = ev.resultPreview;
              block.appendChild(r);
            }
            pendingTools.delete(ev.name);
          }
        } else if (ev.type === 'mood') {
          setMood(ev.slug);
        } else if (ev.type === 'error') {
          el('div', 'err', '[error] ' + ev.message);
        } else if (ev.type === 'done') {
          if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
        }
      }
    }
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  } catch (err) {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
    el('div', 'err', '[error] ' + err.message);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const msg = input.value.trim();
  if (msg || pendingFiles.length) send(msg);
});

input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    form.dispatchEvent(new Event('submit'));
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});

// ── PWA: register service worker + iOS install hint ─────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('[pwa] sw register failed:', err);
  });
}
(function() {
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator).standalone === true;
  if (!isiOS || isStandalone) return;
  if (localStorage.getItem('lisa.pwa.dismissed') === '1') return;
  setTimeout(() => {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;bottom:8px;left:8px;right:8px;background:var(--bg-card-strong);border:1px solid var(--border-strong);border-radius:12px;padding:10px 12px;color:var(--fg);font-size:12px;z-index:9999;display:flex;gap:8px;align-items:center;';
    banner.innerHTML = '✦ Add Lisa to Home Screen: Share button → "Add to Home Screen"';
    const dismiss = document.createElement('button');
    dismiss.textContent = '✕';
    dismiss.style.cssText = 'background:transparent;border:none;color:var(--fg-2);cursor:pointer;font-size:14px;margin-left:auto;';
    dismiss.onclick = () => {
      localStorage.setItem('lisa.pwa.dismissed', '1');
      banner.remove();
    };
    banner.appendChild(dismiss);
    document.body.appendChild(banner);
  }, 5000);
})();

// ════════════════════════════════════════════════════════════════════
// ── Sidebar live wiring ─────────────────────────────────────────────
//
// Populates the new sidebar blocks introduced by the redesign:
//   - identity card sub-line (born YYYY-MM-DD · NN days)
//   - "currently wanting" paragraph (top actionable desire)
//   - Claude Code monitor card (active sessions)
//   - "last reflection" mini-card (most recent ★ idle message)
// Wires to /api/island/ping + /api/claude/sessions + /api/soul, and
// piggy-backs on the connectEvents() SSE listener above for live
// claude_session_update + idle_message refreshes.
// ════════════════════════════════════════════════════════════════════
(function setupSidebarLive() {
  const sbDesire = document.getElementById('sbDesire');
  const sbClaudeCount = document.getElementById('sbClaudeCount');
  const sbClaudeRows = document.getElementById('sbClaudeRows');
  const sbReflection = document.getElementById('sbReflection');
  const sbReflectionBody = document.getElementById('sbReflectionBody');
  const sbSessionBadge = document.getElementById('sbSessionBadge');
  const identitySub = document.getElementById('identitySub');

  // Active session window matches the watcher's ACTIVE_WINDOW_MS.
  const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

  function relativeTime(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 30_000)   return 'just now';
    if (ms < 60_000)   return Math.round(ms / 1000) + 's';
    if (ms < 3600_000) return Math.round(ms / 60_000) + 'm';
    return Math.round(ms / 3600_000) + 'h';
  }

  function setDesire(text) {
    sbDesire.textContent = text || '(nothing actively pursued)';
  }

  window.updateReflection = function (text) {
    if (!text) { sbReflection.style.display = 'none'; return; }
    sbReflection.style.display = '';
    sbReflectionBody.textContent = '"' + text.replace(/^["“”]+|["“”]+$/g, '').trim() + '"';
  };

  function setClaudeSessions(sessions) {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    const recent = sessions.filter(s => new Date(s.lastMtime).getTime() >= cutoff);
    sbClaudeCount.textContent = String(recent.length);
    // sort: errors first, then waiting, then working, then by mtime
    const rank = { error: 0, waiting: 1, working: 2, unknown: 3 };
    const rows = recent.slice().sort((a, b) => {
      const ra = rank[a.state] ?? 9;
      const rb = rank[b.state] ?? 9;
      if (ra !== rb) return ra - rb;
      return new Date(b.lastMtime).getTime() - new Date(a.lastMtime).getTime();
    }).slice(0, 5);
    while (sbClaudeRows.firstChild) sbClaudeRows.removeChild(sbClaudeRows.firstChild);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = '(idle)';
      sbClaudeRows.appendChild(empty);
      return;
    }
    for (const s of rows) {
      const row = document.createElement('div');
      row.className = 'session-row';
      const pip = document.createElement('div');
      pip.className = 'pip ' + (s.state || 'unknown');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = s.project;
      const when = document.createElement('div');
      when.className = 'when';
      when.textContent = relativeTime(s.lastMtime);
      row.appendChild(pip);
      row.appendChild(name);
      row.appendChild(when);
      row.title = (s.stateReason ? s.state + ' · ' + s.stateReason : s.state) + ' · ' + s.sessionId;
      sbClaudeRows.appendChild(row);
    }
  }

  async function refreshPing() {
    try {
      const r = await fetch('/api/island/ping');
      if (!r.ok) return;
      const data = await r.json();
      setDesire(data.current_desire);
      if (data.last_idle_message_text) {
        window.updateReflection(data.last_idle_message_text);
      }
    } catch {}
  }

  // Exposed so the SSE handler above can call this on
  // claude_session_update events without redeclaring the helper.
  window.refreshClaudeSessions = async function () {
    try {
      const r = await fetch('/api/claude/sessions');
      if (!r.ok) return;
      const data = await r.json();
      setClaudeSessions(data.sessions || []);
    } catch {}
  };

  async function refreshIdentity() {
    try {
      const r = await fetch('/api/soul');
      if (!r.ok) return;
      const data = await r.json();
      if (!data.born) return;
      const bornAt = data.summary?.seed?.bornAt;
      if (!bornAt) return;
      const born = new Date(bornAt);
      if (Number.isNaN(born.getTime())) return;
      const days = Math.max(0, Math.floor((Date.now() - born.getTime()) / 86400000));
      const ymd = born.toISOString().slice(0, 10);
      identitySub.textContent = 'born ' + ymd + ' · ' + days + ' day' + (days === 1 ? '' : 's');
    } catch {}
  }

  async function refreshSessionsBadge() {
    try {
      const r = await fetch('/api/sessions');
      if (!r.ok) return;
      const data = await r.json();
      const n = Array.isArray(data.sessions) ? data.sessions.length : 0;
      sbSessionBadge.textContent = String(n);
    } catch {
      // /api/sessions is optional — leave the badge as-is on failure
    }
  }

  // Bootstrap + periodic resync. SSE handles the fast-path updates;
  // these timers are belt-and-braces in case the stream silently dies.
  refreshPing();
  window.refreshClaudeSessions();
  refreshIdentity();
  refreshSessionsBadge();
  setInterval(refreshPing, 30_000);
  setInterval(window.refreshClaudeSessions, 60_000);
  setInterval(refreshSessionsBadge, 5 * 60_000);
})();
</script>
</body></html>`;
