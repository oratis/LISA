/**
 * Inline <style> CSS for the Lisa chat shell (MAIN_HTML).
 *
 * Extracted verbatim from lisa-html.ts so the big stylesheet can be
 * maintained on its own. lisa-html.ts re-embeds this between its
 * <style> tags as `<style>\n${MAIN_CSS}\n</style>` — the byte-for-byte
 * concatenation is asserted by lisa-html-snapshot.test.ts.
 *
 * No interpolation or backticks appear in the original CSS text, so it is
 * a plain template literal with no ${} placeholders.
 */

export const MAIN_CSS = `  :root {
    color-scheme: dark;

    /* New design tokens (mockup) */
    --accent: #6ad4ff;
    --accent-soft: rgba(106, 212, 255, 0.13);
    --accent-glow: rgba(106, 212, 255, 0.27);
    /* Proactive / autonomy "live" accent (green) — the console's watching state. */
    --proactive: #3ddc97;
    --proactive-soft: rgba(61, 220, 151, 0.13);
    --proactive-glow: rgba(61, 220, 151, 0.30);
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
    grid-template-columns: 300px 1fr;
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

  /* ── Sidebar (floating panel — Claude-Code-style detached card) ──── */
  .sidebar {
    grid-area: sidebar;
    margin: 8px 6px 10px 10px;
    background: linear-gradient(180deg, rgba(18, 23, 48, 0.62), rgba(10, 13, 33, 0.6));
    backdrop-filter: blur(30px);
    -webkit-backdrop-filter: blur(30px);
    border: 1px solid var(--border-new);
    border-radius: 16px;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.5);
    overflow-y: auto;
    padding: 18px 14px 14px;
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
  .card.tint-mail {
    border-color: rgba(106, 212, 255, 0.20);
    background: linear-gradient(180deg, rgba(106, 212, 255, 0.06), rgba(106, 212, 255, 0.02));
  }
  .card.tint-mail .h .left { color: var(--brand, #6ad4ff); }
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
  /* working = calm slow breathe (running, not actionable);
     waiting = solid + a soft halo that draws the eye ("needs you"). */
  .session-row .pip.working { background: var(--claude); opacity: 1; animation: breathe 2.6s ease-in-out infinite; }
  .session-row .pip.waiting { background: var(--claude); opacity: 1; animation: needsYou 2s ease-in-out infinite; }
  .session-row .pip.error   { background: var(--err-color); }
  .session-row .name {
    color: var(--fg);
    font-weight: 600;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* D4a — agent-kind chip rendered inline before the project name, so the
     multi-agent sidebar reads which tool each row belongs to. */
  .session-row .agent-badge {
    display: inline-block;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: lowercase;
    color: var(--claude);
    background: rgba(255, 140, 66, 0.12);
    border: 1px solid rgba(255, 140, 66, 0.22);
    border-radius: 999px;
    padding: 0 5px;
    margin-right: 5px;
    vertical-align: 1px;
  }
  .session-row .when {
    color: var(--fg-3);
    font-variant-numeric: tabular-nums;
    font-size: 10.5px;
  }
  /* Second line under name/when: structural activity (turns/tokens/tool·file). */
  .session-row .session-act {
    grid-column: 2 / -1;
    margin-top: 2px;
    font-size: 10px;
    color: var(--fg-3);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Managed-agent controls (approve/deny · send follow-up · cancel). */
  .session-row .session-ctrl {
    grid-column: 2 / -1;
    margin-top: 4px;
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .session-ctrl .mc {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel2, rgba(255,255,255,0.05));
    color: var(--fg);
    cursor: pointer;
  }
  .session-ctrl .mc.approve { color: var(--green, #6bff9d); border-color: rgba(107,255,157,0.4); }
  .session-ctrl .mc.deny,
  .session-ctrl .mc.cancel { color: var(--err-color, #ff5577); border-color: rgba(255,85,119,0.4); }
  .session-ctrl .mc.adopt { color: var(--brand, #6ad4ff); border-color: rgba(106,212,255,0.4); }
  .session-ctrl .mc:hover { background: rgba(255,255,255,0.10); }
  .session-ctrl .mc-send {
    flex: 1;
    min-width: 90px;
    font-size: 10.5px;
    padding: 2px 7px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: rgba(0,0,0,0.25);
    color: var(--fg);
  }
  /* "Delegate a task" → a single full-width button that opens a modal. */
  .delegate-btn {
    width: 100%;
    margin: 2px 0 8px;
    font-size: 11.5px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--claude, #ff8c42);
    background: rgba(255,140,66,0.14);
    color: var(--claude, #ff8c42);
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .delegate-btn:hover { background: rgba(255,140,66,0.26); }
  /* Delegate dialog (rendered in the shared modal). */
  .delegate-modal { display: flex; flex-direction: column; gap: 8px; }
  .delegate-modal .dm-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--fg-2); margin-top: 4px;
  }
  .delegate-modal .dm-kind,
  .delegate-modal .dm-task {
    width: 100%; box-sizing: border-box;
    font-size: 13px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--border); background: rgba(0,0,0,0.25); color: var(--fg);
  }
  .delegate-modal .dm-task { resize: vertical; min-height: 88px; font-family: inherit; }
  .delegate-modal .dm-actions { display: flex; justify-content: flex-end; margin-top: 4px; }
  .delegate-modal .dm-start {
    font-size: 13px; padding: 8px 16px; border-radius: 8px;
    border: 1px solid var(--brand, #6ad4ff); background: rgba(106,212,255,0.16);
    color: var(--brand, #6ad4ff); cursor: pointer;
  }
  .delegate-modal .dm-start:hover { background: rgba(106,212,255,0.28); }
  .delegate-modal .dm-start:disabled { opacity: 0.5; cursor: default; }
  .delegate-modal .dm-err { color: var(--err-color, #ff5577); font-size: 12px; white-space: pre-wrap; }
  .delegate-modal .dm-note { font-size: 11px; color: var(--fg-faint); line-height: 1.4; margin-top: 2px; }
  /* Mail card body */
  #sbMailBody { margin: 2px 0 6px; }
  .mail-summary { font-size: 11.5px; color: var(--fg-2); line-height: 1.45; margin-bottom: 6px; }
  .mail-row { display: flex; gap: 6px; align-items: baseline; padding: 1px 0; }
  .mail-bang { color: var(--brand, #6ad4ff); font-weight: 700; font-size: 11px; flex: none; }
  .mail-bang.urgent { color: var(--err-color, #ff5577); }
  .mail-subj { font-size: 11.5px; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mail-sweep {
    margin-top: 6px; font-size: 10.5px; background: none; border: none;
    color: var(--brand, #6ad4ff); cursor: pointer; padding: 2px 0;
  }
  .mail-sweep:hover { text-decoration: underline; }
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
  /* Gentle breathing for "working" — present but not jumpy. */
  @keyframes breathe {
    0%, 100% { opacity: 0.55; }
    50%      { opacity: 1; }
  }
  /* "needs you" — solid dot with a pulsing warm halo, prominent without the
     harsh on/off flash. */
  @keyframes needsYou {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 140, 66, 0); }
    50%      { box-shadow: 0 0 7px 2px rgba(255, 140, 66, 0.65); }
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

  /* ── Primary nav (vertical list in the sidebar) ────────────── */
  .nav-list { display: flex; flex-direction: column; gap: 2px; }
  .nav-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 11px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--fg-2);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    text-align: left;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .nav-item .nav-ico { width: 18px; font-size: 15px; text-align: center; flex-shrink: 0; opacity: 0.9; }
  .nav-item:hover { background: var(--bg-card); color: var(--fg); }
  .nav-item.active { background: var(--accent-soft); color: var(--accent); }
  .nav-item.active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 18px;
    border-radius: 0 3px 3px 0;
    background: var(--accent);
  }
  .nav-item .nav-tag {
    margin-left: auto;
    font-size: 9.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--fg);
    background: var(--bg-3);
    border-radius: 999px;
    padding: 1px 7px;
    min-width: 18px;
    text-align: center;
  }
  .nav-item.active .nav-tag { background: var(--accent); color: #06141b; }

  /* ── Proactive toggle (sidebar footer area) ────────────────── */
  .proactive-toggle {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 9px 11px;
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    border-radius: 11px;
    cursor: pointer;
    user-select: none;
    transition: border-color 140ms ease, background 140ms ease;
  }
  .proactive-toggle .pt-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-3);
    transition: color 140ms ease;
  }
  .proactive-toggle .pt-track {
    margin-left: auto;
    width: 34px;
    height: 18px;
    border-radius: 999px;
    background: var(--bg-3);
    border: 1px solid var(--border-new);
    position: relative;
    flex-shrink: 0;
    transition: background 140ms ease, border-color 140ms ease;
  }
  .proactive-toggle .pt-knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--fg-3);
    transition: transform 140ms ease, background 140ms ease;
  }
  .proactive-toggle.on { border-color: var(--proactive-glow); background: var(--proactive-soft); }
  .proactive-toggle.on .pt-label { color: var(--proactive); }
  .proactive-toggle.on .pt-track { background: var(--proactive-soft); border-color: var(--proactive-glow); }
  .proactive-toggle.on .pt-knob { transform: translateX(16px); background: var(--proactive); }

  /* ── Main pane ─────────────────────────────────────────────── */
  /* The main pane is a view stack: each .view fills the pane and only the
     active one is shown. Chat is the default; it keeps its original
     log / attachPreview / form 3-row grid (moved onto #viewChat). */
  .main {
    grid-area: main;
    position: relative;
    overflow: hidden;
    background:
      radial-gradient(ellipse at 50% -30%, rgba(106, 212, 255, 0.06) 0%, transparent 60%),
      linear-gradient(180deg, transparent, rgba(106, 212, 255, 0.015));
  }
  .view { display: none; }
  .view.active {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  #viewChat.view.active {
    display: grid;
    grid-template-rows: auto 1fr auto auto;
  }

  /* ── Console views (dashboard / control / reve / sense / memory) ── */
  .view-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border-new);
  }
  .view-head h2 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: 0.02em; color: var(--fg); }
  .view-head .vh-sub { margin: 2px 0 0; font-size: 11.5px; color: var(--fg-3); }
  .view-act {
    flex-shrink: 0;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    color: #06140d;
    background: var(--accent);
    border: 0;
    border-radius: 9px;
    padding: 8px 13px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: filter 120ms ease, transform 120ms ease;
  }
  .view-act:hover { filter: brightness(1.08); }
  .view-act:active { transform: translateY(1px); }
  .view-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 24px 26px; }
  .view-empty { color: var(--fg-faint); font-size: 12.5px; font-style: italic; padding: 18px 4px; }
  .view-sec-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    color: var(--fg-3);
    margin: 4px 0 8px;
  }

  /* Stat bar */
  .stat-bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .stat {
    flex: 1;
    min-width: 92px;
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    border-radius: 12px;
    padding: 11px 13px;
  }
  .stat .n { font-size: 21px; font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; line-height: 1.1; }
  .stat .k {
    margin-top: 3px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-3);
  }

  /* Green "proactive — watching" panel */
  .proactive-panel {
    border: 1px solid var(--proactive-glow);
    background: linear-gradient(180deg, var(--proactive-soft), transparent);
    border-radius: 14px;
    padding: 13px 15px;
    margin-bottom: 16px;
  }
  .proactive-panel .pp-head { display: flex; align-items: center; gap: 10px; }
  .proactive-panel .pp-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--proactive);
    box-shadow: 0 0 8px var(--proactive-glow);
    flex-shrink: 0;
  }
  .proactive-panel.off .pp-dot { background: var(--fg-faint); box-shadow: none; }
  .proactive-panel .pp-title { font-size: 13px; font-weight: 700; color: var(--fg); }
  .proactive-panel .pp-title b { color: var(--proactive); font-weight: 700; }
  .proactive-panel.off .pp-title b { color: var(--fg-3); }
  .proactive-panel .pp-desc { margin: 2px 0 0; font-size: 11.5px; color: var(--fg-2); }
  /* .pp-tags / .pp-tag are reused outside the panel (Control policy chips),
     so they are not scoped to .proactive-panel. */
  .pp-tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .proactive-panel .pp-tags { margin-top: 10px; }
  .pp-tag {
    font-size: 10.5px;
    color: var(--fg-3);
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--border-new);
    border-radius: 999px;
    padding: 2px 9px;
  }
  .pp-tag.warn { color: var(--warm); }

  /* "Focus" big card (current desire / objective analog) */
  .focus-card {
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    border-radius: 14px;
    padding: 15px;
    margin-bottom: 18px;
  }
  .focus-card .fc-top { display: flex; align-items: flex-start; gap: 10px; }
  .focus-card .fc-title { font-size: 14.5px; font-weight: 700; color: var(--fg); }
  .focus-card .fc-desc { margin: 4px 0 0; font-size: 12px; color: var(--fg-2); line-height: 1.5; }
  .focus-card .fc-pill {
    margin-left: auto;
    flex-shrink: 0;
    font-size: 10.5px;
    color: var(--proactive);
    border: 1px solid var(--proactive-glow);
    border-radius: 999px;
    padding: 2px 10px;
  }
  .focus-card .fc-meta { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 11px; font-size: 11px; color: var(--fg-3); }

  /* Horizontally-scrolling agent / task cards */
  .card-scroll {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    padding-bottom: 6px;
    margin-bottom: 18px;
    scroll-snap-type: x proximity;
  }
  .ac {
    flex: 0 0 232px;
    scroll-snap-align: start;
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    border-radius: 13px;
    padding: 13px;
  }
  .ac .ac-top { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--fg-3); margin-bottom: 8px; }
  .ac .ac-status { margin-left: auto; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .ac .ac-status.working { color: var(--accent); }
  .ac .ac-status.waiting { color: var(--warm); }
  .ac .ac-status.error   { color: var(--err-color); }
  .ac .ac-status.done    { color: var(--proactive); }
  .ac .ac-title { font-size: 13px; font-weight: 600; color: var(--fg); margin-bottom: 3px; word-break: break-word; }
  .ac .ac-desc { font-size: 11.5px; color: var(--fg-2); line-height: 1.45; }
  .ac .ac-meta {
    margin-top: 9px;
    padding-top: 7px;
    border-top: 1px solid var(--border-new);
    font-size: 10px;
    color: var(--fg-3);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }

  /* Simple list rows / cards used by Reve / Sense / Memory */
  .v-card {
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    border-radius: 12px;
    padding: 12px 14px;
    margin-bottom: 10px;
  }
  .v-card h3 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-3);
  }
  .v-pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
    line-height: 1.55;
    color: var(--fg-2);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .v-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 0;
    border-top: 1px solid var(--border-new);
  }
  .v-row:first-child { border-top: 0; }
  .v-row .v-main { min-width: 0; flex: 1; }
  .v-row .v-name { font-size: 12.5px; font-weight: 600; color: var(--fg); }
  .v-row .v-sub { font-size: 11px; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v-toggle {
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border-radius: 7px;
    padding: 4px 10px;
    border: 1px solid var(--border-new);
    background: var(--bg-3);
    color: var(--fg-3);
    flex-shrink: 0;
  }
  .v-toggle.on { color: var(--proactive); border-color: var(--proactive-glow); background: var(--proactive-soft); }
  .v-sel {
    font-family: inherit;
    font-size: 12px;
    color: var(--fg);
    background: var(--bg-3);
    border: 1px solid var(--border-new);
    border-radius: 8px;
    padding: 5px 8px;
  }
  .mem-btn {
    width: 100%;
    text-align: left;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
    background: var(--bg-card);
    border: 1px solid var(--border-new);
    border-radius: 11px;
    padding: 13px 15px;
    margin-bottom: 9px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .mem-btn:hover { background: var(--bg-card-strong); border-color: var(--border-strong); }
  .mem-btn .mem-ico { font-size: 16px; width: 20px; text-align: center; }
  .mem-btn .mem-sub { margin-left: auto; font-size: 11px; color: var(--fg-3); font-weight: 400; }

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
  /* Failed-turn block: error detail + retry button (replaces the old bare
     [error] line so the user can read what happened and re-run the turn). */
  .err-block {
    background: linear-gradient(180deg, rgba(255, 85, 119, 0.10), rgba(255, 85, 119, 0.02));
    border: 1px solid rgba(255, 85, 119, 0.30);
    border-radius: 14px;
    padding: 10px 12px;
    margin: 6px 0;
  }
  .err-block .err-head {
    color: var(--err-color);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.03em;
    margin-bottom: 4px;
  }
  .err-block .err-detail {
    color: var(--err-color);
    font-size: 12px;
    line-height: 1.45;
    word-break: break-word;
    white-space: pre-wrap;
    opacity: 0.9;
  }
  .err-block .err-retry {
    margin-top: 8px;
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid rgba(106, 212, 255, 0.40);
    border-radius: 8px;
    cursor: pointer;
  }
  .err-block .err-retry:hover {
    background: var(--accent-glow);
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

  #plusBtn, #recordBtn {
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    color: var(--fg-2);
    cursor: pointer;
    border-radius: 10px;
    transition: background 120ms ease, color 120ms ease;
    min-height: 44px;
    padding: 0;
  }
  /* Line-style icons matching the .fbtn function bar above. */
  #plusBtn svg, #recordBtn svg { width: 19px; height: 19px; display: block; }
  #plusBtn:hover, #recordBtn:hover { background: var(--bg-card); color: var(--fg); }
  #plusBtn.flash { background: var(--accent); color: var(--bg-deep); }

  /* ＋ composer menu (merged attach + screenshot) */
  .plus-wrap { position: relative; align-self: stretch; display: flex; }
  .plus-menu {
    display: none;
    position: absolute;
    left: 0;
    bottom: calc(100% + 8px);
    min-width: 168px;
    background: var(--bg-deep, #0c1024);
    border: 1px solid var(--border-new, rgba(255,255,255,.1));
    border-radius: 11px;
    padding: 5px;
    box-shadow: 0 14px 34px rgba(0,0,0,.5);
    z-index: 30;
  }
  .plus-menu.open { display: block; }
  .plus-menu button {
    display: flex; align-items: center; gap: 9px; width: 100%;
    background: transparent; border: 0; color: var(--fg); font-size: 13px;
    padding: 9px 10px; border-radius: 8px; cursor: pointer; text-align: left;
  }
  .plus-menu button:hover { background: var(--bg-card); }
  .plus-menu .g { width: 18px; text-align: center; }

  /* Top icon function bar (功能区) inside #viewChat */
  .fnbar {
    display: flex; align-items: center; gap: 6px;
    padding: 7px 16px;
    border-bottom: 1px solid var(--border-new, rgba(255,255,255,.08));
    background: rgba(255,255,255,.02);
  }
  .fbtn {
    width: 34px; height: 34px; flex: none;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: 1px solid transparent; border-radius: 9px;
    color: var(--fg-2); cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .fbtn:hover { background: var(--bg-card, rgba(255,255,255,.06)); color: var(--fg); }
  .fbtn svg { width: 19px; height: 19px; display: block; }
  .fbar-spacer { flex: 1; }
  .fn-find {
    height: 28px; width: 150px; font-size: 12px; padding: 0 9px;
    border-radius: 8px; border: 1px solid var(--border-strong, rgba(255,255,255,.14));
    background: rgba(0,0,0,.3); color: var(--fg);
  }
  /* Pulsing red while recording. */
  #recordBtn.recording {
    background: var(--err-color);
    color: #fff;
    animation: rec-pulse 1.1s ease-in-out infinite;
  }
  @keyframes rec-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
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
      /* titlebar · sidebar (capped, scrolls) · main view-stack (fills rest) */
      grid-template-rows: auto auto 1fr;
      grid-template-areas:
        "titlebar"
        "sidebar"
        "main";
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

  /* ── Forced compact / "sidebar mode" ─────────────────────────────
     Same stacked layout as the narrow breakpoint, but toggled on at ANY
     width (persisted client-side) so Lisa can be docked as a skinny panel. */
  body.force-compact .frame {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto 1fr;
    grid-template-areas:
      "titlebar"
      "sidebar"
      "main";
  }
  body.force-compact .sidebar {
    max-height: 38vh;
    padding: 14px 14px 12px;
    gap: 14px;
  }
  body.force-compact #form { grid-template-columns: 36px 36px 1fr 84px; }

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
  .modal-body .pair-qr {
    display: flex;
    justify-content: center;
    margin: 4px 0 14px;
  }
  .modal-body .pair-qr svg {
    width: 200px;
    height: 200px;
    background: #fff;
    padding: 10px;
    border-radius: 12px;
  }
  .modal-body .pair-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 0;
    border-bottom: 1px solid var(--line, rgba(255,255,255,0.07));
  }
  .modal-body .pair-row:last-child { border: none; }
  .modal-body .pair-label {
    flex: 0 0 52px;
    color: var(--fg-3);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .modal-body .pair-val {
    flex: 1 1 auto;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
    color: var(--fg-1, #e8e8ea);
    overflow-wrap: anywhere;
    user-select: all;
  }
  .modal-body .pair-copy {
    flex: 0 0 auto;
    font-family: inherit;
    font-size: 11px;
    font-weight: 700;
    color: var(--fg-2);
    background: var(--btn-bg, rgba(255,255,255,0.08));
    border: 1px solid var(--line, rgba(255,255,255,0.12));
    border-radius: 6px;
    padding: 3px 9px;
    cursor: pointer;
  }
  .modal-body .pair-copy:hover { filter: brightness(1.12); }
  .modal-body .plan-select {
    margin-top: 6px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 700;
    padding: 4px 12px;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    background: var(--accent);
    color: #07091a;
  }
  .modal-body .plan-select:hover { filter: brightness(1.08); }
  .modal-body .plan-select[disabled] {
    background: var(--fg-faint);
    color: var(--fg-3);
    cursor: default;
  }
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
  }`;
